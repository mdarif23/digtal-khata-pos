import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  quotationItems,
  quotations,
  type quotationStatusEnum,
} from "../../db/schema/quotations.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { customers } from "../../db/schema/customers.js";
import { nextDocumentNumber } from "../../utils/documentSequence.js";
import { recordAuditInTx, recordAudit } from "../../services/audit.js";
import { createSale } from "../sales/sales.service.js";
import { publishRealtime } from "../realtime/realtime.service.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";

/**
 * Quotation workflow (Phase 2B — master prompt Feature 7): draft → sent →
 * accepted → converted, with rejected/expired/cancelled side states.
 * Conversion is transactional, row-locked and single-shot.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QuotationStatus = (typeof quotationStatusEnum.enumValues)[number];

export interface QuotationItemInput {
  variantId: number;
  quantity: number;
  unitPrice: number;
  discount?: number | undefined;
}

export interface QuotationInput {
  customerId: number | null;
  customerNameSnapshot: string | null;
  items: QuotationItemInput[];
  vatPercent: number;
  notes?: string | null;
  terms?: string | null;
  validUntil?: string | null;
}

async function assertVariantsInBusiness(
  businessId: number,
  items: QuotationItemInput[],
): Promise<Map<number, { name: string }>> {
  const ids = [...new Set(items.map((i) => i.variantId))];
  if (ids.length === 0) {
    throw new BadRequestError("A quotation needs at least one line.");
  }
  const rows = await db
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      sku: productVariants.sku,
      productName: products.name,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(productVariants.businessId, businessId),
        inArray(productVariants.id, ids),
      ),
    );
  const byId = new Map<number, { name: string }>();
  for (const row of rows) {
    byId.set(row.id, { name: row.productName });
  }
  for (const item of items) {
    if (!byId.has(item.variantId)) {
      throw new BadRequestError(
        `Variant ${item.variantId} was not found in this business.`,
      );
    }
    if (item.quantity <= 0) {
      throw new BadRequestError("Quantities must be greater than zero.");
    }
    if (item.unitPrice < 0 || (item.discount ?? 0) < 0) {
      throw new BadRequestError("Prices and discounts cannot be negative.");
    }
  }
  return byId;
}

function computeTotals(items: QuotationItemInput[], vatPercent: number) {
  let subtotal = 0;
  let discountTotal = 0;
  for (const item of items) {
    const gross = item.quantity * item.unitPrice;
    const discount = item.discount ?? 0;
    subtotal += gross;
    discountTotal += discount;
  }
  const net = roundMoney(subtotal - discountTotal);
  const vatTotal = roundMoney((net * vatPercent) / 100);
  return {
    subtotal: roundMoney(subtotal),
    discountTotal: roundMoney(discountTotal),
    vatTotal,
    grandTotal: roundMoney(net + vatTotal),
  };
}

export async function createQuotation(
  businessId: number,
  locationId: number,
  userId: number,
  input: QuotationInput,
): Promise<{ id: number; quoteNumber: string }> {
  if (input.items.length === 0) {
    throw new BadRequestError("A quotation needs at least one line.");
  }
  if (input.vatPercent < 0 || input.vatPercent > 100) {
    throw new BadRequestError("VAT percent must be between 0 and 100.");
  }
  const variantNames = await assertVariantsInBusiness(businessId, input.items);
  let customerName = input.customerNameSnapshot;
  if (input.customerId !== null) {
    const [customer] = await db
      .select({ name: customers.name })
      .from(customers)
      .where(
        and(
          eq(customers.id, input.customerId),
          eq(customers.businessId, businessId),
        ),
      )
      .limit(1);
    if (!customer) {
      throw new BadRequestError("Customer not found in this business.");
    }
    customerName = customer.name;
  }
  const totals = computeTotals(input.items, input.vatPercent);

  return db.transaction(async (tx) => {
    const seq = await nextDocumentNumber(tx, businessId, "quotation");
    const quoteNumber = `QT-${new Date().getFullYear()}-${String(seq).padStart(6, "0")}`;
    const [quotation] = await tx
      .insert(quotations)
      .values({
        businessId,
        locationId,
        quoteNumber,
        ...(input.customerId !== null ? { customerId: input.customerId } : {}),
        customerNameSnapshot: customerName,
        status: "draft",
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        vatTotal: totals.vatTotal,
        grandTotal: totals.grandTotal,
        vatPercent: input.vatPercent,
        notes: input.notes ?? null,
        terms: input.terms ?? null,
        validUntil: input.validUntil ?? null,
        createdBy: userId,
      })
      .returning({ id: quotations.id, quoteNumber: quotations.quoteNumber });
    if (!quotation) throw new Error("Quotation insert returned no row.");

    await tx.insert(quotationItems).values(
      input.items.map((item) => ({
        businessId,
        quotationId: quotation.id,
        variantId: item.variantId,
        variantNameSnapshot: variantNames.get(item.variantId)!.name.slice(0, 255),
        quantity: item.quantity,
        unitPrice: roundMoney(item.unitPrice),
        discount: roundMoney(item.discount ?? 0),
        lineTotal: roundMoney(item.quantity * item.unitPrice - (item.discount ?? 0)),
      })),
    );

    await recordAuditInTx(tx, {
      businessId,
      actorUserId: userId,
      action: "quotation.created",
      entityType: "quotation",
      entityId: quotation.id,
      metadata: { quoteNumber, grandTotal: totals.grandTotal, itemCount: input.items.length },
    });
    return quotation;
  });
}

export async function updateQuotationDraft(
  businessId: number,
  userId: number,
  quotationId: number,
  input: QuotationInput,
): Promise<void> {
  const variantNames = await assertVariantsInBusiness(businessId, input.items);
  const totals = computeTotals(input.items, input.vatPercent);
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ status: quotations.status, customerId: quotations.customerId })
      .from(quotations)
      .where(
        and(eq(quotations.id, quotationId), eq(quotations.businessId, businessId)),
      )
      .for("update");
    if (!existing) throw new NotFoundError("Quotation not found.");
    if (existing.status !== "draft") {
      throw new ConflictError("Only draft quotations can be edited.");
    }
    await tx
      .update(quotations)
      .set({
        ...(input.customerId !== undefined
          ? { customerId: input.customerId }
          : {}),
        customerNameSnapshot: input.customerNameSnapshot,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        vatTotal: totals.vatTotal,
        grandTotal: totals.grandTotal,
        vatPercent: input.vatPercent,
        notes: input.notes ?? null,
        terms: input.terms ?? null,
        validUntil: input.validUntil ?? null,
        updatedAt: new Date(),
      })
      .where(eq(quotations.id, quotationId));
    await tx.delete(quotationItems).where(eq(quotationItems.quotationId, quotationId));
    await tx.insert(quotationItems).values(
      input.items.map((item) => ({
        businessId,
        quotationId,
        variantId: item.variantId,
        variantNameSnapshot: variantNames.get(item.variantId)!.name.slice(0, 255),
        quantity: item.quantity,
        unitPrice: roundMoney(item.unitPrice),
        discount: roundMoney(item.discount ?? 0),
        lineTotal: roundMoney(item.quantity * item.unitPrice - (item.discount ?? 0)),
      })),
    );
    await recordAuditInTx(tx, {
      businessId,
      actorUserId: userId,
      action: "quotation.updated",
      entityType: "quotation",
      entityId: quotationId,
      metadata: { grandTotal: totals.grandTotal },
    });
  });
}

const TRANSITIONS: Record<
  "sent" | "accepted" | "rejected" | "cancelled",
  { from: QuotationStatus[]; action: string }
> = {
  sent: { from: ["draft"], action: "quotation.sent" },
  accepted: { from: ["draft", "sent"], action: "quotation.accepted" },
  rejected: { from: ["draft", "sent"], action: "quotation.rejected" },
  cancelled: { from: ["draft", "sent", "accepted"], action: "quotation.cancelled" },
};

export type QuotationTransition = keyof typeof TRANSITIONS;

export async function transitionQuotation(
  businessId: number,
  userId: number,
  quotationId: number,
  to: QuotationTransition,
): Promise<{ id: number; status: QuotationStatus }> {
  const rule = TRANSITIONS[to];
  if (!rule) {
    throw new BadRequestError("Invalid status transition.");
  }
  const [row] = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: quotations.id, status: quotations.status })
      .from(quotations)
      .where(
        and(eq(quotations.id, quotationId), eq(quotations.businessId, businessId)),
      )
      .for("update");
    if (!existing) throw new NotFoundError("Quotation not found.");
    if (!rule.from.includes(existing.status)) {
      throw new ConflictError(
        `Cannot move a ${existing.status} quotation to ${to}.`,
      );
    }
    const [updated] = await tx
      .update(quotations)
      .set({ status: to, updatedAt: new Date() })
      .where(eq(quotations.id, quotationId))
      .returning({ id: quotations.id, status: quotations.status });
    await recordAuditInTx(tx, {
      businessId,
      actorUserId: userId,
      action: rule.action,
      entityType: "quotation",
      entityId: quotationId,
      beforeState: { status: existing.status },
      afterState: { status: to },
    });
    return [updated];
  });
  if (!row) throw new Error("Quotation transition returned no row.");
  return row;
}

export interface ConvertQuotationInput {
  payments: {
    method: string;
    amount?: number | undefined;
    reference?: string | undefined;
    tendered?: number | undefined;
  }[];
}

/**
 * Converts an accepted (or sent) quotation into a sale. E3-004: the quote
 * is CLAIMED first (status → 'converting' under the row lock, migration
 * 0092) so two concurrent converts can never both create a real sale —
 * the old order (validate → create sale → conditional claim) let the
 * loser commit a sale it then failed to link. A crashed claim (older than
 * 5 minutes, no sale id) is reclaimable; a createSale failure reverts the
 * claim to the previous status. Sale pricing is re-run by the standard
 * backend-authoritative engine on the quoted lines.
 */
export async function convertQuotation(
  businessId: number,
  locationId: number,
  cashierUserId: number,
  quotationId: number,
  input: ConvertQuotationInput,
): Promise<{ saleId: number; quoteNumber: string }> {
  const quotation = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(quotations)
      .where(
        and(eq(quotations.id, quotationId), eq(quotations.businessId, businessId)),
      )
      .for("update");
    if (!existing) throw new NotFoundError("Quotation not found.");
    if (existing.status === "converting") {
      const stale =
        existing.convertedClaimedAt !== null &&
        Date.now() - existing.convertedClaimedAt.getTime() > 5 * 60_000;
      if (!stale) {
        throw new ConflictError(
          "A conversion of this quotation is already in progress.",
        );
      }
      // Crashed attempt — reclaim below.
    } else if (existing.status !== "accepted" && existing.status !== "sent") {
      throw new ConflictError(
        `Only accepted (or sent) quotations can be converted — this one is ${existing.status}.`,
      );
    }
    const prevStatus = existing.status === "converting" ? "accepted" : existing.status;
    // THE CLAIM — atomic under the row lock: a racing convert now sees
    // 'converting' with a fresh claim and gets a clean 409 BEFORE it can
    // create any sale.
    const [claimed] = await tx
      .update(quotations)
      .set({ status: "converting", convertedClaimedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(quotations.id, quotationId),
          eq(quotations.businessId, businessId),
        ),
      )
      .returning({ id: quotations.id, quoteNumber: quotations.quoteNumber });
    if (!claimed) {
      throw new ConflictError("The quotation could not be claimed for conversion.");
    }
    return { ...existing, prevStatus, claimed };
  });

  const items = await db
    .select()
    .from(quotationItems)
    .where(
      and(
        eq(quotationItems.quotationId, quotationId),
        eq(quotationItems.businessId, businessId),
      ),
    );
  if (items.length === 0) {
    await revertQuotationClaim(businessId, quotationId, quotation.prevStatus);
    throw new ConflictError("The quotation has no lines to convert.");
  }

  // The sale engine runs ITS OWN transaction. A failure reverts the claim
  // so the quote stays convertible; a crash leaves a stale 'converting'
  // claim that the 5-minute rule reclaims.
  let sale: Awaited<ReturnType<typeof createSale>>;
  try {
    sale = await createSale(
      businessId,
      locationId,
      cashierUserId,
      {
        customerId: quotation.customerId,
        saleDate: new Date(),
        items: items.map((item) => ({
          variantId: item.variantId,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          // The quoted per-line discount carries through: the sale total must
          // match the offered quotation total (same VAT percent). The cart
          // item discount shape is {type, value}.
          ...(Number(item.discount) > 0
            ? { discount: { type: "fixed" as const, value: Number(item.discount) } }
            : { discount: null }),
        })),
        payments: input.payments as never,
        vatPercent: Number(quotation.vatPercent),
        discount: null,
      } as never,
    );
  } catch (err) {
    await revertQuotationClaim(businessId, quotationId, quotation.prevStatus);
    throw err;
  }

  // E3-008: the quoted total and the backend-recomputed total must agree.
  // A cart saved with named charges (quotations persist items+VAT only) or
  // per-variant tax rules that re-resolve at sale time used to either
  // convert to a SMALLER sale (charges silently dropped) or fail
  // validatePayments outright — refuse honestly instead.
  const quotedTotal = Number(quotation.grandTotal ?? 0);
  const saleTotal = Number(sale.sale.finalTotal ?? 0);
  if (Math.abs(saleTotal - quotedTotal) > 0.01) {
    await revertQuotationClaim(businessId, quotationId, quotation.prevStatus);
    throw new ConflictError(
      `The quotation total (${quotedTotal.toFixed(2)}) no longer matches current pricing (${saleTotal.toFixed(2)}) — charges or tax rules changed. Re-quote from the cart.`,
    );
  }

  const [claimed] = await db
    .update(quotations)
    .set({
      status: "converted",
      convertedSaleId: sale.sale.id,
      convertedAt: new Date(),
      convertedClaimedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(quotations.id, quotationId),
        eq(quotations.businessId, businessId),
        eq(quotations.status, "converting"),
      ),
    )
    .returning({ id: quotations.id, quoteNumber: quotations.quoteNumber });
  if (!claimed) {
    throw new ConflictError(
      "The quotation was already converted by another checkout.",
    );
  }
  recordAudit({
    businessId,
    actorUserId: cashierUserId,
    action: "quotation.converted",
    entityType: "quotation",
    entityId: quotationId,
    metadata: {
      quoteNumber: quotation.quoteNumber,
      saleId: sale.sale.id,
      grandTotal: Number(quotation.grandTotal),
    },
  });
  publishRealtime(businessId, locationId, {
    kind: "sale.created",
    locationId,
    saleId: sale.sale.id,
  });
  return { saleId: sale.sale.id, quoteNumber: claimed.quoteNumber };
}

/** E3-004: release an in-flight claim back to its previous status. */
async function revertQuotationClaim(
  businessId: number,
  quotationId: number,
  prevStatus: "draft" | "sent" | "accepted",
): Promise<void> {
  await db
    .update(quotations)
    .set({
      status: prevStatus,
      convertedClaimedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(quotations.id, quotationId),
        eq(quotations.businessId, businessId),
        eq(quotations.status, "converting"),
      ),
    );
}

export async function listQuotations(
  businessId: number,
  filters: { status?: string | undefined; search?: string | undefined; limit?: number; offset?: number },
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const conditions = [eq(quotations.businessId, businessId)];
  if (filters.status) {
    conditions.push(
      sql`${quotations.status} = ${filters.status}::quotation_status`,
    );
  }
  if (filters.search) {
    conditions.push(
      sql`(${quotations.quoteNumber} ILIKE ${`%${filters.search}%`} OR ${quotations.customerNameSnapshot} ILIKE ${`%${filters.search}%`})`,
    );
  }
  const where = and(...conditions);
  const rows = await db
    .select()
    .from(quotations)
    .where(where)
    .orderBy(desc(quotations.id))
    .limit(Math.min(filters.limit ?? 50, 200))
    .offset(Math.max(filters.offset ?? 0, 0));
  const [counted] = await db
    .select({ total: sql<string>`COUNT(*)` })
    .from(quotations)
    .where(where);
  return { rows, total: Number(counted?.total ?? 0) };
}

export async function getQuotationDetail(
  businessId: number,
  quotationId: number,
): Promise<Record<string, unknown>> {
  const [quotation] = await db
    .select()
    .from(quotations)
    .where(
      and(eq(quotations.id, quotationId), eq(quotations.businessId, businessId)),
    )
    .limit(1);
  if (!quotation) throw new NotFoundError("Quotation not found.");
  const items = await db
    .select()
    .from(quotationItems)
    .where(eq(quotationItems.quotationId, quotationId))
    .orderBy(quotationItems.id);
  return { ...quotation, items };
}

/** Expiry sweep: draft/sent quotations past valid_until become 'expired'. */
export async function runQuotationExpirySweep(): Promise<{ expired: number }> {
  const result = await db.execute(sql`
    UPDATE quotations
    SET status = 'expired', updated_at = now()
    WHERE status IN ('draft', 'sent')
      AND valid_until IS NOT NULL
      AND valid_until < CURRENT_DATE
  `);
  return { expired: result.rowCount ?? 0 };
}
