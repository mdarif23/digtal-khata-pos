import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { saleItems } from "../../db/schema/saleItems.js";
import { sales } from "../../db/schema/sales.js";
import { supplierLeadTimes } from "../../db/schema/supplierLeadTimes.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { createPurchase } from "../purchases/purchases.service.js";
import { recordAuditInTx } from "../../services/audit.js";
import {
  computeReorderRows,
  rowsToSuggestions,
} from "../procurement/reorderPlanning.service.js";

/**
 * Automated replenishment (Module 2C).
 *
 * Suggestions are DERIVED at read time (never stored) and share ONE
 * computation with the Smart Reorder dashboard
 * (procurement/reorderPlanning.service): available = (stock − reserved)
 * + outstanding POs + in-transit inbound transfers, so in-flight orders
 * are never double-ordered. The default order size is the configured
 * reorder quantity, else the shortfall to the point. The last purchase's
 * supplier and unit cost prefill the purchase-order conversion.
 */

export interface ReorderSuggestion {
  variantId: number;
  productId: number;
  productName: string;
  variantOptions: string | null;
  variantName: string | null;
  sku: string | null;
  currentStock: number;
  outstandingOnOrder: number;
  reorderPoint: number;
  reorderQuantity: number | null;
  suggestedQuantity: number;
  lastSupplierId: number | null;
  lastSupplierName: string | null;
  lastUnitCost: number | null;
  /** Phase 4 (Feature 14): avg units sold per day over the trailing window. */
  velocityPerDay?: number | null | undefined;
  /** Phase 4: configured supplier lead time in days (null = unknown). */
  leadTimeDays?: number | null | undefined;
  /** Phase 4: days of supply the suggested quantity covers. */
  daysOfCover?: number | null | undefined;
}

export async function listReorderSuggestions(
  businessId: number,
  locationId: number,
): Promise<ReorderSuggestion[]> {
  const rows = await computeReorderRows(businessId, locationId);
  const base = rowsToSuggestions(rows);
  return await applyForecasting(businessId, locationId, base);
}

/**
 * Phase 4 (Feature 14): sales velocity (trailing 30 days of completed
 * sales at the location) + supplier lead time. The suggested quantity
 * covers the LEAD-TIME demand when velocity is known:
 * suggested = max(configured suggestion, ceil(velocity × leadTimeDays) −
 * available). Lead times come from supplier_lead_times for the suggestion's
 * supplier (fallback: any supplier's lead time for the variant).
 */
export async function applyForecasting(
  businessId: number,
  locationId: number,
  suggestions: ReorderSuggestion[],
): Promise<ReorderSuggestion[]> {
  if (suggestions.length === 0) return suggestions;
  const variantIds = suggestions.map((s) => s.variantId);
  const windowStart = new Date(Date.now() - 30 * 86_400_000);

  const velocityRows = await db
    .select({
      variantId: saleItems.variantId,
      sold: sql<string>`COALESCE(SUM(${saleItems.quantity}), 0)`,
    })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .where(
      and(
        eq(saleItems.businessId, businessId),
        inArray(saleItems.variantId, variantIds),
        eq(sales.locationId, locationId),
        gte(sales.saleDate, windowStart),
        eq(sales.status, "completed"),
      ),
    )
    .groupBy(saleItems.variantId);
  const soldByVariant = new Map(
    velocityRows.map((row) => [row.variantId, Number(row.sold)] as const),
  );

  const leadRows = await db
    .select({
      variantId: supplierLeadTimes.variantId,
      supplierId: supplierLeadTimes.supplierId,
      leadTimeDays: supplierLeadTimes.leadTimeDays,
    })
    .from(supplierLeadTimes)
    .where(
      and(
        eq(supplierLeadTimes.businessId, businessId),
        inArray(supplierLeadTimes.variantId, variantIds),
      ),
    );
  const leadByVariantSupplier = new Map<string, number>();
  const leadByVariantAny = new Map<number, number>();
  for (const row of leadRows) {
    leadByVariantSupplier.set(`${row.variantId}:${row.supplierId}`, row.leadTimeDays);
    if (!leadByVariantAny.has(row.variantId)) {
      leadByVariantAny.set(row.variantId, row.leadTimeDays);
    }
  }

  return suggestions.map((suggestion) => {
    const sold = soldByVariant.get(suggestion.variantId) ?? 0;
    const velocityPerDay = roundMoney(sold / 30);
    const leadTimeDays =
      (suggestion.lastSupplierId != null
        ? leadByVariantSupplier.get(
            `${suggestion.variantId}:${suggestion.lastSupplierId}`,
          )
        : undefined) ??
      leadByVariantAny.get(suggestion.variantId) ??
      null;
    let suggestedQuantity = suggestion.suggestedQuantity;
    let daysOfCover: number | null = null;
    if (velocityPerDay > 0 && leadTimeDays != null) {
      const leadDemand = Math.ceil(velocityPerDay * leadTimeDays);
      const forecastQty = Math.max(
        1,
        leadDemand - suggestion.currentStock - suggestion.outstandingOnOrder,
      );
      suggestedQuantity = Math.max(suggestedQuantity, forecastQty);
      daysOfCover = roundMoney(suggestedQuantity / velocityPerDay);
    }
    return {
      ...suggestion,
      suggestedQuantity,
      velocityPerDay,
      leadTimeDays,
      daysOfCover,
    };
  });
}

export async function setReorderConfig(
  businessId: number,
  variantId: number,
  actorUserId: number | null,
  input: { reorderPoint: number | null; reorderQuantity: number | null },
) {
  for (const value of [input.reorderPoint, input.reorderQuantity]) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new BadRequestError(
        "Reorder values must be non-negative integers or null.",
      );
    }
  }
  return db.transaction(async (tx) => {
    const [variant] = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(eq(productVariants.id, variantId), eq(productVariants.businessId, businessId)),
      )
      .limit(1);
    if (!variant) throw new NotFoundError("Variant not found.");
    await tx
      .update(productVariants)
      .set({
        reorderPoint: input.reorderPoint,
        reorderQuantity: input.reorderQuantity,
      })
      .where(eq(productVariants.id, variantId));
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "product.reorder_configured",
      entityType: "product_variant",
      entityId: variantId,
      metadata: { ...input },
    });
    return { variantId, ...input };
  });
}

export interface ConvertInput {
  supplierId: number | null;
  items: { variantId: number; quantity?: number | undefined }[];
  note?: string | null | undefined;
}

/** Converts selected suggestions into a draft purchase order. */
export async function convertSuggestionsToPurchase(
  businessId: number,
  locationId: number,
  actorUserId: number | null,
  input: ConvertInput,
) {
  if (input.items.length === 0) {
    throw new BadRequestError("Select at least one suggestion to convert.");
  }
  const suggestions = await listReorderSuggestions(businessId, locationId);
  const byVariant = new Map(suggestions.map((s) => [s.variantId, s]));

  const purchaseItems0 = input.items.map((item) => {
    const suggestion = byVariant.get(item.variantId);
    if (!suggestion) {
      throw new BadRequestError(
        "One or more selected items are not current reorder suggestions.",
      );
    }
    const quantity =
      item.quantity !== undefined && item.quantity > 0
        ? item.quantity
        : suggestion.suggestedQuantity;
    return {
      variantId: item.variantId,
      quantity,
      // Prefill from purchase history; the buyer can edit the draft.
      purchasePrice: suggestion.lastUnitCost ?? 0,
      discount: 0,
      tax: 0,
    };
  });

  const purchase = await createPurchase(businessId, {
    items: purchaseItems0,
    supplierId: input.supplierId,
    purchaseDate: new Date(),
    notes: input.note ?? "Created from reorder suggestions",
    discount: 0,
    discountBasis: "fixed",
    tax: 0,
    shippingCost: 0,
  });

  await db.transaction(async (tx) => {
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "purchase.from_reorder",
      entityType: "purchase",
      entityId: (purchase as { id?: number }).id ?? null,
      metadata: { itemCount: purchaseItems0.length, locationId },
    });
  });

  return purchase;
}

export async function getVariantReorderConfig(
  businessId: number,
  variantId: number,
) {
  const [variant] = await db
    .select({
      variantId: productVariants.id,
      reorderPoint: productVariants.reorderPoint,
      reorderQuantity: productVariants.reorderQuantity,
    })
    .from(productVariants)
    .where(
      and(eq(productVariants.id, variantId), eq(productVariants.businessId, businessId)),
    )
    .limit(1);
  if (!variant) throw new NotFoundError("Variant not found.");
  return variant;
}

/** Phase 4 (Feature 14): supplier lead-time CRUD per variant. */
export async function setLeadTime(
  businessId: number,
  input: { variantId: number; supplierId: number; leadTimeDays: number },
): Promise<void> {
  if (input.leadTimeDays < 0 || input.leadTimeDays > 365) {
    throw new BadRequestError("Lead time must be between 0 and 365 days.");
  }
  await db
    .insert(supplierLeadTimes)
    .values({
      businessId,
      supplierId: input.supplierId,
      variantId: input.variantId,
      leadTimeDays: input.leadTimeDays,
    })
    .onConflictDoUpdate({
      target: [
        supplierLeadTimes.businessId,
        supplierLeadTimes.supplierId,
        supplierLeadTimes.variantId,
      ],
      set: {
        leadTimeDays: input.leadTimeDays,
        updatedAt: new Date(),
      },
    });
}

export async function getLeadTime(
  businessId: number,
  variantId: number,
): Promise<{ supplierId: number; leadTimeDays: number }[]> {
  const rows = await db
    .select({
      supplierId: supplierLeadTimes.supplierId,
      leadTimeDays: supplierLeadTimes.leadTimeDays,
    })
    .from(supplierLeadTimes)
    .where(
      and(
        eq(supplierLeadTimes.businessId, businessId),
        eq(supplierLeadTimes.variantId, variantId),
      ),
    );
  return rows;
}
