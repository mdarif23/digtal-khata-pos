import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DbTransaction } from "../../config/db.js";

/** Anything that can run drizzle queries: the shared pool db or a tx. */
type Executor = DbTransaction | NodePgDatabase<Record<string, never>>;
import {
  nextDocumentNumber,
  formatWarrantyNumber,
} from "../../utils/documentSequence.js";
import { ConflictError, NotFoundError } from "../../utils/handleError.js";
import { customerWarranties } from "../../db/schema/warranties.js";
import { productWarrantyConfigs } from "../../db/schema/warranties.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import type { customerWarranties as CustomerWarrantiesTable } from "../../db/schema/warranties.js";

type WarrantyRow = typeof CustomerWarrantiesTable.$inferSelect;

/**
 * Warranty engine — pure business rules for the customer warranty system.
 *
 * INVARIANTS (approved audit §10, decisions D1-D10):
 * - Terms are snapshotted from the resolved config at generation; history
 *   never re-reads product configuration.
 * - Expiry is computed ONCE from the sale's business-effective date, never
 *   from the claim date. Month arithmetic clamps to the last valid day
 *   (Jan 31 + 1 month = Feb 28/29); day/year arithmetic uses UTC calendar
 *   math consistently with sales.saleDate (timestamptz).
 * - Serial-tracked products (products.trackingType = 'serial') get ONE
 *   warranty row per sold serial; every other product gets ONE quantity
 *   row per sale item. Ordinary products never ask the cashier for serials.
 * - Duplicate generation is impossible: partial unique indexes
 *   (sale_item_id where serial_id IS NULL / serial_id) + the sale-level
 *   idempotency replay, which returns before generation runs.
 * - Expired is DERIVED (expiry_date < now); stored statuses describe the
 *   lifecycle only (active/voided/replaced/suspended).
 */

type DurationUnit = "days" | "months" | "years";

/**
 * Add a warranty duration to a start date.
 * Months are calendar months with end-of-month clamping; days/years are
 * calendar days/years. The warranty stays valid through the last full
 * millisecond of the expiry day (inclusive expiry — a claim submitted on
 * the expiry date itself is eligible).
 */
export function addWarrantyDuration(
  start: Date,
  duration: number,
  unit: DurationUnit,
): Date {
  const result = new Date(start.getTime());
  if (unit === "days") {
    result.setUTCDate(result.getUTCDate() + duration);
    return result;
  }
  if (unit === "years") {
    // Calendar years, clamped like months (Feb 29 + 1 year = Feb 28).
    return addWarrantyDuration(start, 12 * duration, "months");
  }
  // Months: add calendar months, clamping the day-of-month (Jan 31 -> Feb 28).
  const originalDay = result.getUTCDate();
  result.setUTCDate(1); // step onto a safe day before touching the month
  result.setUTCMonth(result.getUTCMonth() + duration);
  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, daysInTargetMonth));
  return result;
}

export type ResolvedWarrantyConfig = {
  enabled: boolean;
  provider: string;
  warrantyType: string;
  duration: number;
  durationUnit: DurationUnit;
  terms: string | null;
};

/**
 * Resolve the effective warranty configuration for a variant:
 * variant-specific row -> product-default row -> null (no warranty).
 * Inactive rows are skipped in both scopes.
 */
export async function resolveWarrantyConfig(
  tx: Executor,
  businessId: number,
  productId: number,
  variantId: number,
): Promise<ResolvedWarrantyConfig | null> {
  const rows = await tx
    .select({
      variantId: productWarrantyConfigs.variantId,
      enabled: productWarrantyConfigs.enabled,
      provider: productWarrantyConfigs.provider,
      warrantyType: productWarrantyConfigs.warrantyType,
      duration: productWarrantyConfigs.duration,
      durationUnit: productWarrantyConfigs.durationUnit,
      terms: productWarrantyConfigs.terms,
    })
    .from(productWarrantyConfigs)
    .where(
      and(
        eq(productWarrantyConfigs.businessId, businessId),
        eq(productWarrantyConfigs.productId, productId),
        eq(productWarrantyConfigs.status, "active"),
        sql`(${productWarrantyConfigs.variantId} = ${variantId} OR ${productWarrantyConfigs.variantId} IS NULL)`,
      ),
    )
    .orderBy(sql`${productWarrantyConfigs.variantId} NULLS LAST`)
    .limit(2);

  const variantRow = rows.find((r) => r.variantId === variantId);
  const productRow = rows.find((r) => r.variantId === null);
  const resolved = variantRow ?? productRow;
  if (!resolved || !resolved.enabled) return null;
  return {
    enabled: true,
    provider: resolved.provider,
    warrantyType: resolved.warrantyType,
    duration: resolved.duration,
    durationUnit: resolved.durationUnit as DurationUnit,
    terms: resolved.terms ?? null,
  };
}

export interface WarrantyGenerationItem {
  saleItemId: number;
  productId: number;
  variantId: number;
  /** Base-unit quantity sold on the line. */
  quantity: number;
  /** Sold serial ids (serial-tracked lines only). */
  serialIds?: number[];
}

/**
 * Generate customer warranties for completed sale items. Called inside the
 * caller's transaction by createSale / createSaleExchange, after sale_items
 * rows and serial links exist. Products without an active warranty config
 * are skipped silently; everything else inserts snapshot rows numbered from
 * the business's customer_warranty document sequence.
 */
export async function createWarrantiesForSaleItems(
  tx: DbTransaction,
  params: {
    businessId: number;
    locationId: number;
    saleId: number;
    saleDate: Date;
    customerId: number | null;
    items: WarrantyGenerationItem[];
  },
): Promise<number> {
  if (params.items.length === 0) return 0;

  // Memoize config resolution per (productId, variantId) — a sale rarely
  // repeats variants, but multi-line UOM carts can.
  const configCache = new Map<string, ResolvedWarrantyConfig | null>();
  const serialTextCache = new Map<number, string>();
  let created = 0;

  for (const item of params.items) {
    const cacheKey = `${item.productId}:${item.variantId}`;
    if (!configCache.has(cacheKey)) {
      configCache.set(
        cacheKey,
        await resolveWarrantyConfig(
          tx,
          params.businessId,
          item.productId,
          item.variantId,
        ),
      );
    }
    const config = configCache.get(cacheKey);
    if (!config) continue;

    const expiryDate = addWarrantyDuration(
      params.saleDate,
      config.duration,
      config.durationUnit,
    );
    const baseRow = {
      businessId: params.businessId,
      locationId: params.locationId,
      saleId: params.saleId,
      saleItemId: item.saleItemId,
      customerId: params.customerId,
      productId: item.productId,
      variantId: item.variantId,
      provider: config.provider,
      warrantyType: config.warrantyType,
      duration: config.duration,
      durationUnit: config.durationUnit,
      terms: config.terms,
      startDate: params.saleDate,
      expiryDate,
      status: "active" as const,
    };

    if (item.serialIds && item.serialIds.length > 0) {
      // One individually-tracked warranty per sold serial. Serial texts are
      // snapshotted from the DB rows, not the request payload.
      const serialRows = await tx
        .select({ id: serialNumbers.id, serialNumber: serialNumbers.serialNumber })
        .from(serialNumbers)
        .where(
          and(
            eq(serialNumbers.businessId, params.businessId),
            inArray(serialNumbers.id, item.serialIds),
          ),
        );
      for (const serialId of item.serialIds) {
        const row = serialRows.find((s) => s.id === serialId);
        if (!row) {
          throw new NotFoundError(
            `Serial ${serialId} not found while issuing warranty.`,
          );
        }
        const text = serialTextCache.get(serialId) ?? row.serialNumber;
        serialTextCache.set(serialId, text);
        const warrantyNumber = await nextDocumentNumber(
          tx,
          params.businessId,
          "customer_warranty",
        );
        await tx
          .insert(customerWarranties)
          .values({
            ...baseRow,
            warrantyNumber: formatWarrantyNumber(
              params.saleDate.getUTCFullYear(),
              warrantyNumber,
            ),
            serialId,
            serialNumber: text,
            quantity: 1,
          })
          .onConflictDoNothing();
        created += 1;
      }
    } else {
      // Quantity-based: one row covers every unit of the line; partial
      // returns increment returned_quantity (see applyRefundWarrantyEffects).
      const warrantyNumber = await nextDocumentNumber(
        tx,
        params.businessId,
        "customer_warranty",
      );
      await tx
        .insert(customerWarranties)
        .values({
          ...baseRow,
          warrantyNumber: formatWarrantyNumber(
            params.saleDate.getUTCFullYear(),
            warrantyNumber,
          ),
          serialId: null,
          serialNumber: null,
          quantity: item.quantity,
        })
        .onConflictDoNothing();
      created += 1;
    }
  }
  return created;
}

/** Re-exported for the warranty API modules; canonical home is
 *  utils/documentSequence.ts beside formatSaleInvoiceNumber. */
export {
  formatWarrantyNumber,
  formatWarrantyClaimNumber,
  formatSupplierClaimNumber,
} from "../../utils/documentSequence.js";

export type { WarrantyRow };

/**
 * Is the warranty still claimable right now? Expiry is compared against
 * `now` (server UTC); a claim submitted on the expiry date itself is
 * eligible (inclusive expiry). A warranty whose units were all returned is
 * voided and no longer claimable; a partially returned quantity warranty
 * remains claimable for the units still covered.
 */
export function isWarrantyClaimable(
  warranty: Pick<
    WarrantyRow,
    "status" | "expiryDate" | "quantity" | "returnedQuantity"
  >,
  now: Date = new Date(),
): { ok: boolean; reason?: string } {
  if (warranty.status === "voided") {
    return { ok: false, reason: "This warranty has been voided." };
  }
  if (warranty.status === "suspended") {
    return { ok: false, reason: "This warranty is suspended." };
  }
  if (warranty.status === "replaced") {
    return { ok: false, reason: "This warranty was replaced by a new one." };
  }
  if (warranty.expiryDate.getTime() < now.getTime()) {
    return { ok: false, reason: "This warranty has expired." };
  }
  if (warranty.returnedQuantity >= warranty.quantity) {
    return { ok: false, reason: "All covered units were returned." };
  }
  return { ok: true };
}

/**
 * Refund-time warranty effects (called from applySaleRefund inside its tx).
 *
 * - Serial-tracked lines: the refund options carry the exact returned
 *   serialIds — only THOSE warranties are voided (partial return must not
 *   touch the units the customer kept).
 * - Quantity-based lines: returned_quantity increments by the returned
 *   units; the warranty voids when every covered unit came back. All units
 *   of a line share identical terms, so no per-unit allocation is needed.
 */
export async function applyRefundWarrantyEffects(
  tx: DbTransaction,
  params: {
    businessId: number;
    saleItemId: number;
    returnedQuantity: number;
    serialIds: number[];
    refundId: number;
  },
): Promise<void> {
  const reason = `sale_return:${params.refundId}`.slice(0, 200);

  if (params.serialIds.length > 0) {
    await tx
      .update(customerWarranties)
      .set({
        status: "voided",
        voidedAt: new Date(),
        voidReason: reason,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customerWarranties.businessId, params.businessId),
          eq(customerWarranties.saleItemId, params.saleItemId),
          inArray(customerWarranties.serialId, params.serialIds),
          eq(customerWarranties.status, "active"),
        ),
      );
    return;
  }

  // Quantity-based row: bump returned_quantity, void when exhausted. The
  // guarded WHERE makes the increment idempotent against concurrent refunds
  // of the same line (each refund's quantities are validated upstream).
  const updated = await tx
    .update(customerWarranties)
    .set({
      returnedQuantity: sql`${customerWarranties.returnedQuantity} + ${params.returnedQuantity}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(customerWarranties.businessId, params.businessId),
        eq(customerWarranties.saleItemId, params.saleItemId),
        isNull(customerWarranties.serialId),
        eq(customerWarranties.status, "active"),
      ),
    )
    .returning({
      id: customerWarranties.id,
      quantity: customerWarranties.quantity,
      returnedQuantity: customerWarranties.returnedQuantity,
    });
  for (const row of updated) {
    if (row.returnedQuantity >= row.quantity) {
      await tx
        .update(customerWarranties)
        .set({
          status: "voided",
          voidedAt: new Date(),
          voidReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(customerWarranties.id, row.id));
    }
  }
}

/**
 * Full-return / sale-level invalidation: every remaining active warranty of
 * the sale is voided (sale status flipped to 'refunded' means every line
 * came back). Called from applySaleRefund when the sale becomes refunded.
 */
export async function voidWarrantiesForSale(
  tx: DbTransaction,
  params: { businessId: number; saleId: number; refundId: number },
): Promise<void> {
  const reason = `sale_return:${params.refundId}`.slice(0, 200);
  await tx
    .update(customerWarranties)
    .set({
      status: "voided",
      voidedAt: new Date(),
      voidReason: reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(customerWarranties.businessId, params.businessId),
        eq(customerWarranties.saleId, params.saleId),
        eq(customerWarranties.status, "active"),
      ),
    );
}

/**
 * Load a business-scoped warranty with the variant/product context needed
 * by claim flows. Foreign ids are indistinguishable from missing (404).
 */
export async function getWarrantyForBusiness(
  tx: Executor,
  businessId: number,
  warrantyId: number,
): Promise<WarrantyRow> {
  const [row] = await tx
    .select()
    .from(customerWarranties)
    .where(
      and(
        eq(customerWarranties.businessId, businessId),
        eq(customerWarranties.id, warrantyId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new NotFoundError("Warranty not found.");
  }
  return row;
}

/**
 * Assert a warranty may receive a new claim. Claims stay allowed while any
 * covered unit remains and the warranty is unexpired; rejected claims never
 * void the warranty (multi-claim is permitted).
 */
export async function assertWarrantyClaimable(
  tx: Executor,
  businessId: number,
  warrantyId: number,
): Promise<WarrantyRow> {
  const warranty = await getWarrantyForBusiness(tx, businessId, warrantyId);
  const check = isWarrantyClaimable(warranty);
  if (!check.ok) {
    throw new ConflictError(check.reason ?? "Warranty is not claimable.");
  }
  return warranty;
}

/**
 * Replace the previous warranty's status after a warranty replacement:
 * the original row becomes 'replaced' (closed for claims) and the new row
 * stays 'active' with the inherited expiry.
 */
export async function markWarrantyReplaced(
  tx: DbTransaction,
  params: { businessId: number; warrantyId: number },
): Promise<void> {
  await tx
    .update(customerWarranties)
    .set({ status: "replaced", updatedAt: new Date() })
    .where(
      and(
        eq(customerWarranties.businessId, params.businessId),
        eq(customerWarranties.id, params.warrantyId),
      ),
    );
}

/**
 * Serial status used while a defective unit sits in the shop's repair flow.
 * 'in_repair' existed in serial_status from the start but was written by no
 * module — warranty claims adopt it without an enum migration.
 */
export const WARRANTY_REPAIR_SERIAL_STATUS = "in_repair" as const;
