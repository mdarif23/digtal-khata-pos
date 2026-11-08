import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { landedCosts } from "../../db/schema/landedCosts.js";
import { purchases } from "../../db/schema/purchases.js";
import { purchaseReturns } from "../../db/schema/purchaseReturns.js";
import { purchaseReturnItems } from "../../db/schema/purchaseReturnItems.js";
import {
  landedCostAdjustments,
  landedCostAllocations,
  landedCostAuditLogs,
  landedCostExpenses,
  landedCostPostings,
} from "../../db/schema/landedCosts.js";
import { NotFoundError, ConflictError, BadRequestError } from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { allocateByBasis } from "./landed-cost.money.js";
import {
  getLandedCostContext,
  computeLandedCostPreview,
  purchaseOriginExpenses,
  type LandedCostContext,
} from "./landed-cost.service.js";
import {
  classifyLandedCostComponents,
} from "./landed-cost.components.service.js";
import type { LandedCostPreviewInput } from "./landed-cost.validation.js";
import type { DbTransaction } from "../purchases/purchase.types.js";

/**
 * Landed-cost document lifecycle (Part F).
 *
 * Invariants enforced here:
 * - ONE document per purchase (DB unique) and it is created only after the
 *   first receive (location stamped).
 * - Draft documents are the only editable state; posted documents change
 *   exclusively through delta adjustments (receive_delta) or reversals —
 *   posted allocation rows are NEVER rewritten.
 * - Posting/deltas run the SAME preview function the API previews with,
 *   inside the caller's transaction, with the document row-locked.
 * - Cumulative target − previously posted = the delta; Σ posted per batch
 *   always equals the batch's cumulative received target, and
 *   total_allocated + pending_allocation == total_capitalizable.
 * - batch.additional_cost_per_unit is RECOMPUTED from the immutable
 *   allocation rows (self-healing), never incremented blindly.
 */

interface DocumentExpensesInput {
  method: LandedCostPreviewInput["method"];
  expenses: LandedCostPreviewInput["expenses"];
  manualAllocations?: LandedCostPreviewInput["manualAllocations"];
}

async function lockDocument(
  tx: DbTransaction,
  businessId: number,
  documentId: number,
) {
  const [doc] = await tx
    .select()
    .from(landedCosts)
    .where(
      and(eq(landedCosts.id, documentId), eq(landedCosts.businessId, businessId)),
    )
    .for("update")
    .limit(1);
  if (!doc) throw new NotFoundError("Landed-cost document not found.");
  return doc;
}

/**
 * Global lock-order anchor (Phase 6, concurrency fix): every transaction
 * that touches BOTH a landed-cost document and purchase items/batches must
 * take the document row lock FIRST — before the purchase items — so the
 * FK key-share that allocation inserts take on locked purchase-item rows
 * can never wait behind a transaction that is itself waiting for the
 * document lock. (The receive-vs-post deadlock this prevents is exercised
 * by purchaseLifecycle.integration.test.ts.)
 */
export async function lockDocumentForPurchaseInTx(
  tx: DbTransaction,
  businessId: number,
  purchaseId: number,
): Promise<void> {
  await tx
    .select({ id: landedCosts.id })
    .from(landedCosts)
    .where(
      and(
        eq(landedCosts.purchaseId, purchaseId),
        eq(landedCosts.businessId, businessId),
      ),
    )
    .for("update")
    .limit(1);
}

/**
 * Server-verified settlement references (Part G): an expense settled from a
 * recorded expense payment must point at a real, same-business expense row;
 * a supplier-payable settlement needs the vendor for the payable reference.
 */
async function assertSettlements(
  businessId: number,
  expenses: DocumentExpensesInput["expenses"],
) {
  for (const expense of expenses) {
    if (expense.settlementType === "expense_payment") {
      if (!expense.settlementReferenceId) {
        throw new BadRequestError(
          "Expense-payment settlement needs the settled expense id.",
        );
      }
      const { expenses: expensesTable } = await import(
        "../../db/schema/expenses.js"
      );
      const [row] = await db
        .select({ id: expensesTable.id })
        .from(expensesTable)
        .where(
          and(
            eq(expensesTable.id, expense.settlementReferenceId),
            eq(expensesTable.businessId, businessId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new BadRequestError(
          "Settled expense reference does not exist in this business.",
        );
      }
    }
    if (expense.settlementType === "supplier_payable" && !expense.vendorId) {
      throw new BadRequestError(
        "Supplier-payable settlement needs the vendor for the payable.",
      );
    }
  }
}

async function insertExpenses(
  tx: DbTransaction,
  documentId: number,
  businessId: number,
  expenses: DocumentExpensesInput["expenses"],
) {
  if (expenses.length === 0) return;
  await tx.insert(landedCostExpenses).values(
    expenses.map((expense) => ({
      businessId,
      landedCostId: documentId,
      expenseType: expense.expenseType,
      description: expense.description ?? null,
      amount: expense.amount,
      taxAmount: expense.taxAmount ?? 0,
      taxTreatment: expense.taxTreatment ?? "none",
      isCapitalizable: expense.isCapitalizable ?? true,
      vendorId: expense.vendorId ?? null,
      referenceNumber: expense.referenceNumber ?? null,
      expenseDate: expense.expenseDate ? new Date(expense.expenseDate) : null,
      settlementType: expense.settlementType ?? "unpaid",
      settlementReferenceId: expense.settlementReferenceId ?? null,
    })),
  );
}

/**
 * Server-generated purchase-origin expense rows (Phase 4): today the
 * supplier's own shipping charge. Written ONCE per document (the partial
 * unique index makes a second write impossible), mirrored from
 * `purchases.shipping_cost` — the payable already includes it, so these
 * rows bring no new money, only capitalization eligibility.
 */
async function insertPurchaseOriginRows(
  tx: DbTransaction,
  documentId: number,
  businessId: number,
  purchase: { supplierId: number | null; shippingCost: string | number | null },
) {
  const rows = purchaseOriginExpenses(purchase).map((expense) => ({
    businessId,
    landedCostId: documentId,
    expenseType: expense.expenseType,
    description: expense.description ?? null,
    amount: expense.amount,
    taxAmount: expense.taxAmount ?? 0,
    taxTreatment: expense.taxTreatment ?? "none",
    isCapitalizable: expense.isCapitalizable ?? true,
    vendorId: purchase.supplierId,
    settlementType: expense.settlementType ?? "supplier_payable",
    sourceType: "purchase" as const,
    sourceKey: "shipping_cost" as const,
  }));
  if (rows.length > 0) {
    await tx.insert(landedCostExpenses).values(rows);
  }
}

/** Create the (single) draft document for a purchase. */
export async function createLandedCostDocument(
  businessId: number,
  purchaseId: number,
  actorUserId: number,
  input: DocumentExpensesInput,
) {
  const context = await getLandedCostContext(businessId, purchaseId);
  if (context.existingStatus) {
    throw new ConflictError(
      "This purchase already has a landed-cost document.",
    );
  }
  // Purchase-origin components (supplier shipping) are part of the real
  // allocation set — validation and preview must include them.
  const effectiveExpenses = [
    ...input.expenses,
    ...purchaseOriginExpenses(context.purchase),
  ];
  // Validate the calculation up front (weights, manual sums, bases).
  computeLandedCostPreview(context.lines, {
    method: input.method,
    expenses: effectiveExpenses,
    ...(input.manualAllocations ? { manualAllocations: input.manualAllocations } : {}),
  });
  await assertSettlements(businessId, input.expenses);

  return db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(landedCosts)
      .values({
        businessId,
        purchaseId,
        locationId: context.purchase.locationId!,
        allocationMethod: input.method,
        status: "draft",
        createdBy: actorUserId,
      })
      .returning();
    if (!doc) throw new Error("Failed to create landed-cost document.");
    await insertExpenses(tx, doc.id, businessId, input.expenses);
    await insertPurchaseOriginRows(tx, doc.id, businessId, context.purchase);
    await tx.insert(landedCostAuditLogs).values({
      businessId,
      landedCostId: doc.id,
      action: "create",
      actorUserId,
      details: { method: input.method, expenseCount: input.expenses.length },
    });
    return doc;
  });
}

/** Replace method + expenses on a draft document. */
export async function updateLandedCostDocument(
  businessId: number,
  documentId: number,
  actorUserId: number,
  input: DocumentExpensesInput,
) {
  return db.transaction(async (tx) => {
    const doc = await lockDocument(tx, businessId, documentId);
    if (doc.status !== "draft") {
      throw new ConflictError(
        "Posted landed-cost documents can only change through adjustments.",
      );
    }
    const context = await getLandedCostContext(businessId, doc.purchaseId);
    const effectiveExpenses = [
      ...input.expenses,
      ...purchaseOriginExpenses(context.purchase),
    ];
    computeLandedCostPreview(context.lines, {
      method: input.method,
      expenses: effectiveExpenses,
      ...(input.manualAllocations ? { manualAllocations: input.manualAllocations } : {}),
    });
    await assertSettlements(businessId, input.expenses);

    await tx
      .update(landedCosts)
      .set({ allocationMethod: input.method, updatedAt: new Date() })
      .where(eq(landedCosts.id, documentId));
    await tx.delete(landedCostExpenses).where(
      and(
        eq(landedCostExpenses.landedCostId, documentId),
        eq(landedCostExpenses.businessId, businessId),
      ),
    );
    await insertExpenses(tx, documentId, businessId, input.expenses);
    await insertPurchaseOriginRows(tx, documentId, businessId, context.purchase);
    await tx.insert(landedCostAuditLogs).values({
      businessId,
      landedCostId: documentId,
      action: "expense_update",
      actorUserId,
      details: { method: input.method, expenseCount: input.expenses.length },
    });
    return { ...doc, allocationMethod: input.method };
  });
}

/** Full document detail: header + expenses + allocations + adjustments. */
export async function getLandedCostDocument(businessId: number, documentId: number) {
  const [doc] = await db
    .select()
    .from(landedCosts)
    .where(
      and(eq(landedCosts.id, documentId), eq(landedCosts.businessId, businessId)),
    )
    .limit(1);
  if (!doc) throw new NotFoundError("Landed-cost document not found.");
  const [expenses, allocations, adjustments, auditLogs, postingRows] = await Promise.all([
    db
      .select()
      .from(landedCostExpenses)
      .where(
        and(
          eq(landedCostExpenses.landedCostId, documentId),
          eq(landedCostExpenses.businessId, businessId),
        ),
      ),
    db
      .select()
      .from(landedCostAllocations)
      .where(
        and(
          eq(landedCostAllocations.landedCostId, documentId),
          eq(landedCostAllocations.businessId, businessId),
        ),
      ),
    db
      .select()
      .from(landedCostAdjustments)
      .where(
        and(
          eq(landedCostAdjustments.landedCostId, documentId),
          eq(landedCostAdjustments.businessId, businessId),
        ),
      ),
    db
      .select()
      .from(landedCostAuditLogs)
      .where(
        and(
          eq(landedCostAuditLogs.landedCostId, documentId),
          eq(landedCostAuditLogs.businessId, businessId),
        ),
      ),
    db
      .select({
        posting: landedCostPostings,
        expenseType: landedCostExpenses.expenseType,
        expenseSourceType: landedCostExpenses.sourceType,
        expenseSourceKey: landedCostExpenses.sourceKey,
        expenseDescription: landedCostExpenses.description,
      })
      .from(landedCostPostings)
      .leftJoin(
        landedCostExpenses,
        and(
          eq(landedCostPostings.expenseId, landedCostExpenses.id),
          eq(landedCostPostings.businessId, landedCostExpenses.businessId),
        ),
      )
      .where(
        and(
          eq(landedCostPostings.landedCostId, documentId),
          eq(landedCostPostings.businessId, businessId),
        ),
      ),
  ]);

  // Authoritative per-component classification (Phase 5): the purchase
  // header carries discount/tax/shipping — the expense rows carry their
  // own treatments. One source for the UI, allocation, and postings.
  const [purchase] = await db
    .select({
      discount: purchases.discount,
      tax: purchases.tax,
      shippingCost: purchases.shippingCost,
    })
    .from(purchases)
    .where(
      and(eq(purchases.id, doc.purchaseId), eq(purchases.businessId, businessId)),
    )
    .limit(1);

  // Phase 9 accounting view: each posting carries its expense's source
  // identity (auto supplier shipping vs manual entries); event-level
  // postings (cogs_adjustment / reversal) and legacy rows have none.
  const postings = postingRows.map((row) => ({
    ...row.posting,
    expenseType: row.expenseType,
    expenseSourceType: row.expenseSourceType,
    expenseSourceKey: row.expenseSourceKey,
    expenseDescription: row.expenseDescription,
  }));

  const sumType = (type: string) =>
    roundMoney(
      postings
        .filter((p) => p.postingType === type)
        .reduce((sum, p) => sum + Number(p.amount), 0),
    );
  const capitalization = sumType("capitalization");
  const expensePosted = sumType("expense");
  const cogsAdjustment = sumType("cogs_adjustment");
  const reversal = sumType("reversal");
  const attributedAmount = roundMoney(
    postings
      .filter((p) => p.expenseId !== null)
      .reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0),
  );
  const unattributedAmount = roundMoney(
    postings
      .filter((p) => p.expenseId === null)
      .reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0),
  );

  // Phase 12 reconciliation fix: net-in-inventory is BATCH-authoritative —
  // Σ (quantity_remaining × additional_cost_per_unit) over the doc's
  // batches. The postings alone cannot express it once units were SOLD:
  // sale consumption carries the original landed share out of inventory
  // without writing a landed posting (deltas post cogs_adjustment, the
  // original share does not). Conservation:
  // capitalization = netInInventory + soldUnitsLanded + |reversal|.
  const batchIds = [
    ...new Set(allocations.map((a) => a.inventoryBatchId as number)),
  ];
  const batchValuationRows = batchIds.length
    ? await db
        .select({
          remaining: inventoryBatches.quantityRemaining,
          additional: inventoryBatches.additionalCostPerUnit,
        })
        .from(inventoryBatches)
        .where(
          and(
            inArray(inventoryBatches.id, batchIds),
            eq(inventoryBatches.businessId, businessId),
          ),
        )
    : [];
  const netInInventory = roundMoney(
    batchValuationRows.reduce(
      (sum, b) =>
        sum + Number(b.remaining) * Number(b.additional ?? 0),
      0,
    ),
  );
  const soldUnitsLanded = roundMoney(capitalization + reversal - netInInventory);

  return {
    document: doc,
    expenses,
    allocations,
    adjustments,
    auditLogs,
    postings,
    // Phase 9 accounting reconciliation: the posting ledger tied out
    // against the document. The invariant (Part G): Σ capitalization
    // postings == totalAllocatedAmount. cogs_adjustment postings mark the
    // sold-units portion of posting-time deltas; `expense` postings are
    // period expenses outside the allocation. Phase 12: netInInventory is
    // the batch valuation and soldUnitsLanded is derived so the four money
    // figures always conserve.
    accounting: {
      postingsByType: {
        capitalization,
        expense: expensePosted,
        cogsAdjustment,
        reversal,
      },
      netInInventory,
      soldUnitsLanded,
      periodExpensed: expensePosted,
      attributedAmount,
      unattributedAmount,
      capitalizationTiesOut:
        Math.abs(capitalization - Number(doc.totalAllocatedAmount)) <= 0.005,
    },
    components: classifyLandedCostComponents(
      purchase ?? { discount: 0, tax: 0, shippingCost: 0 },
      expenses.map((expense) => ({
        id: expense.id,
        expenseType: expense.expenseType,
        description: expense.description,
        amount: expense.amount,
        taxAmount: expense.taxAmount,
        taxTreatment: expense.taxTreatment,
        isCapitalizable: expense.isCapitalizable,
        sourceType: expense.sourceType,
        sourceKey: expense.sourceKey,
      })),
    ),
  };
}

/**
 * The cumulative allocation targets for a document over the purchase's
 * CURRENT received state (works inside a transaction so receive-deltas see
 * the just-created batches).
 */
async function computeDocumentTargets(
  tx: DbTransaction,
  doc: typeof landedCosts.$inferSelect,
  businessId: number,
): Promise<{
  context: LandedCostContext;
  preview: ReturnType<typeof computeLandedCostPreview>;
  expenseRows: {
    id: number;
    amount: number;
    taxAmount: number;
    taxTreatment: string;
    isCapitalizable: boolean;
    settlementType: string;
    settlementReferenceId: number | null;
    vendorId: number | null;
    expenseType: string;
  }[];
}> {
  const expenseRows = await tx
    .select({
      id: landedCostExpenses.id,
      amount: landedCostExpenses.amount,
      taxAmount: landedCostExpenses.taxAmount,
      taxTreatment: landedCostExpenses.taxTreatment,
      isCapitalizable: landedCostExpenses.isCapitalizable,
      settlementType: landedCostExpenses.settlementType,
      settlementReferenceId: landedCostExpenses.settlementReferenceId,
      vendorId: landedCostExpenses.vendorId,
      expenseType: landedCostExpenses.expenseType,
    })
    .from(landedCostExpenses)
    .where(
      and(
        eq(landedCostExpenses.landedCostId, doc.id),
        eq(landedCostExpenses.businessId, businessId),
      ),
    );

  const context = await getLandedCostContext(businessId, doc.purchaseId, tx);

  const preview = computeLandedCostPreview(context.lines, {
    method: doc.allocationMethod,
    expenses: expenseRows.map((e) => ({
      expenseType: "other" as const,
      amount: Number(e.amount),
      taxAmount: Number(e.taxAmount),
      taxTreatment: e.taxTreatment as "none" | "recoverable" | "non_recoverable",
      isCapitalizable: e.isCapitalizable,
      settlementType: e.settlementType,
    })),
  });
  return {
    context,
    preview,
    expenseRows: expenseRows.map((e) => ({
      ...e,
      amount: Number(e.amount),
      taxAmount: Number(e.taxAmount),
    })),
  };
}

/**
 * Reconcile a batch's additional_cost_per_unit from its immutable allocation
 * rows (per unit = Σ allocations / quantity_received, 6-dp by column scale).
 */
async function recomputeBatchCosts(
  tx: DbTransaction,
  businessId: number,
  batchIds: number[],
) {
  if (batchIds.length === 0) return;
  await tx.execute(sql`
    UPDATE inventory_batches b
    SET additional_cost_per_unit = COALESCE(agg.total_allocated, 0) / NULLIF(b.quantity_received, 0)
    FROM (
      SELECT inventory_batch_id, SUM(allocated_amount) AS total_allocated
      FROM landed_cost_allocations
      WHERE business_id = ${businessId}
        AND inventory_batch_id IN (${sql.join(batchIds.map((id) => sql`${id}`), sql`, `)})
      GROUP BY inventory_batch_id
    ) agg
    WHERE b.id = agg.inventory_batch_id AND b.business_id = ${businessId}
  `);
}

type PostingExpense = {
  id: number;
  amount: number;
  taxAmount: number;
  taxTreatment: string;
  isCapitalizable: boolean;
  settlementType: string;
  settlementReferenceId: number | null;
  vendorId: number | null;
  expenseType: string;
};

/**
 * Records the module-scoped accounting trail (Part G, audit decision Q1-a):
 * one `capitalization` posting per capitalizable expense (its share of the
 * posted amount, largest-remainder exact), one `expense` posting per period
 * expense. Settlement references ride along so already-recorded payments are
 * never double-counted — the authoritative settlement rows stay in
 * expense_payments / purchase payables; this table is the landed-cost view.
 * Phase 9: every per-expense posting carries expense_id, so the posting
 * ledger traces back to the expense's source identity (auto supplier
 * shipping vs manual entries).
 */
async function writeAllocationPostings(
  tx: DbTransaction,
  doc: typeof landedCosts.$inferSelect,
  expenses: PostingExpense[],
  allocatedQuads: bigint,
  adjustmentId: number | null,
) {
  const capitalizable = expenses.filter(
    (e) =>
      e.isCapitalizable &&
      BigInt(Math.round((e.amount + (e.taxTreatment === "non_recoverable" ? e.taxAmount : 0)) * 10_000)) > 0n,
  );
  const periodExpenses = expenses.filter((e) => !e.isCapitalizable);

  const rows: (typeof landedCostPostings.$inferInsert)[] = [];
  if (allocatedQuads > 0n && capitalizable.length > 0) {
    const basis = capitalizable.map((e, i) => ({
      key: String(i),
      basisMicros: BigInt(
        Math.round((e.amount + (e.taxTreatment === "non_recoverable" ? e.taxAmount : 0)) * 10_000),
      ),
    }));
    const shares = allocateByBasis(allocatedQuads, basis);
    for (const [index, expense] of capitalizable.entries()) {
      const shareQuads = shares.get(String(index))!;
      rows.push({
        businessId: doc.businessId,
        landedCostId: doc.id,
        adjustmentId,
        expenseId: expense.id,
        postingType: "capitalization",
        amount: Number(shareQuads) / 10_000,
        paymentSource: doc.allocationMethod ? paymentSourceOf(expense) : "unpaid",
        paymentReferenceType:
          expense.settlementType === "expense_payment"
            ? "expense"
            : expense.settlementType === "supplier_payable"
              ? "supplier"
              : null,
        paymentReferenceId:
          expense.settlementType === "expense_payment"
            ? expense.settlementReferenceId
            : expense.settlementType === "supplier_payable"
              ? expense.vendorId
              : null,
        description: `${expense.expenseType} → inventory`,
      });
    }
  }
  for (const expense of periodExpenses) {
    rows.push({
      businessId: doc.businessId,
      landedCostId: doc.id,
      adjustmentId,
      expenseId: expense.id,
      postingType: "expense",
      amount: expense.amount,
      paymentSource: paymentSourceOf(expense),
      paymentReferenceType:
        expense.settlementType === "expense_payment"
          ? "expense"
          : expense.settlementType === "supplier_payable"
            ? "supplier"
            : null,
      paymentReferenceId:
        expense.settlementType === "expense_payment"
          ? expense.settlementReferenceId
          : expense.settlementType === "supplier_payable"
            ? expense.vendorId
            : null,
      description: `${expense.expenseType} → period expense`,
    });
  }
  if (rows.length > 0) {
    await tx.insert(landedCostPostings).values(rows);
  }
}

function paymentSourceOf(expense: PostingExpense) {
  const allowed = ["expense_payment", "supplier_payable", "cash", "unpaid"];
  return (allowed.includes(expense.settlementType)
    ? expense.settlementType
    : "unpaid") as "expense_payment" | "supplier_payable" | "cash" | "unpaid";
}

/**
 * Phase 10: returns that PREDATE a landed-cost posting (or a posting
 * delta) — the returned units are not in inventory, so their share of the
 * newly posted money cannot stay there. Item-level math: per-unit landed
 * cost is uniform across an item's batches and returns record item-level
 * quantities only, so the reversal amount is attribution-independent.
 * Returns { returnId → reversal quads } for COMPLETED returns only.
 */
async function computeReturnReversalQuadsInTx(
  tx: DbTransaction,
  businessId: number,
  purchaseId: number,
  itemMoneyQuads: Map<number, bigint>,
  itemReceivedMillis: Map<number, bigint>,
): Promise<Map<number, bigint>> {
  const byReturn = new Map<number, bigint>();
  if (itemMoneyQuads.size === 0) return byReturn;
  const rows = await tx
    .select({
      purchaseReturnId: purchaseReturns.id,
      purchaseItemId: purchaseReturnItems.purchaseItemId,
      quantity: purchaseReturnItems.quantity,
    })
    .from(purchaseReturnItems)
    .innerJoin(
      purchaseReturns,
      and(
        eq(purchaseReturnItems.purchaseReturnId, purchaseReturns.id),
        eq(purchaseReturnItems.businessId, purchaseReturns.businessId),
      ),
    )
    .where(
      and(
        eq(purchaseReturns.purchaseId, purchaseId),
        eq(purchaseReturns.businessId, businessId),
        eq(purchaseReturns.status, "completed"),
      ),
    );
  for (const row of rows) {
    const moneyQuads = itemMoneyQuads.get(row.purchaseItemId);
    const receivedMillis = itemReceivedMillis.get(row.purchaseItemId);
    if (moneyQuads === undefined || receivedMillis === undefined) continue;
    if (receivedMillis <= 0n || moneyQuads <= 0n) continue;
    const returnedMillis = BigInt(Math.round(Number(row.quantity) * 1000));
    if (returnedMillis <= 0n) continue;
    const quads = (moneyQuads * returnedMillis) / receivedMillis;
    byReturn.set(
      row.purchaseReturnId,
      (byReturn.get(row.purchaseReturnId) ?? 0n) + quads,
    );
  }
  return byReturn;
}

/**
 * Writes one pre-posting return reversal: a `reversal` adjustment
 * referenced to the purchase return plus its reversal posting (negative,
 * event-level — unattributed, like every return-time reversal). The
 * document's cumulative totalAllocatedAmount stays gross; the reversal
 * exits through the postings ledger (netInInventory).
 */
async function writeReturnReversalInTx(
  tx: DbTransaction,
  doc: typeof landedCosts.$inferSelect,
  returnId: number,
  quads: bigint,
  grossAllocatedQuads: bigint,
  actorUserId: number,
) {
  const amount = -roundMoney(Number(quads) / 10_000);
  const [row] = await tx
    .insert(landedCostAdjustments)
    .values({
      businessId: doc.businessId,
      landedCostId: doc.id,
      adjustmentType: "reversal",
      previousAllocatedAmount: roundMoney(Number(grossAllocatedQuads) / 10_000),
      newAllocatedAmount: roundMoney(Number(grossAllocatedQuads - quads) / 10_000),
      adjustmentAmount: amount,
      inventoryAmount: amount,
      cogsAmount: 0,
      reason: "Units returned before posting — landed cost reversed at posting",
      referenceType: "purchase_return",
      referenceId: returnId,
      createdBy: actorUserId,
    })
    .returning({ id: landedCostAdjustments.id });
  await tx.insert(landedCostPostings).values({
    businessId: doc.businessId,
    landedCostId: doc.id,
    adjustmentId: row!.id,
    postingType: "reversal",
    amount,
    paymentSource: "unpaid",
    description: "Landed cost of units returned before posting",
  });
  return row!.id;
}

/**
 * Post a draft document: allocate the received share of every line target to
 * the batches, write immutable allocation rows, recompute batch costs.
 */
export async function postLandedCostDocument(
  businessId: number,
  documentId: number,
  actorUserId: number,
) {
  return db.transaction(async (tx) => {
    const doc = await lockDocument(tx, businessId, documentId);
    if (doc.status !== "draft") {
      throw new ConflictError("Only draft documents can be posted.");
    }
    const { context, preview, expenseRows } = await computeDocumentTargets(
      tx,
      doc,
      businessId,
    );

    // Previously posted per batch (none for a first post, but keep the delta
    // math uniform).
    const postedRows = await tx
      .select({
        batchId: landedCostAllocations.inventoryBatchId,
        posted: sql<string>`COALESCE(SUM(${landedCostAllocations.allocatedAmount}), 0)`,
      })
      .from(landedCostAllocations)
      .where(
        and(
          eq(landedCostAllocations.landedCostId, documentId),
          eq(landedCostAllocations.businessId, businessId),
        ),
      )
      .groupBy(landedCostAllocations.inventoryBatchId);
    const postedByBatch = new Map(
      postedRows.map((r) => [r.batchId, BigInt(Math.round(Number(r.posted) * 10_000))]),
    );

    const batchIdToLine = new Map(
      context.lines.flatMap((line) =>
        line.batches.map((batch) => [batch.batchId, { line, batch }]),
      ),
    );

    type AllocationInsert = typeof landedCostAllocations.$inferInsert;
    const allocationRows: AllocationInsert[] = [];
    let totalAllocatedQuads = 0n;
    for (const lineResult of preview.allocation.lines) {
      for (const batchResult of lineResult.batches) {
        const targetQuads = BigInt(Math.round(batchResult.allocatedAmount * 10_000));
        const deltaQuads =
          targetQuads - (postedByBatch.get(batchResult.batchId) ?? 0n);
        if (deltaQuads === 0n) continue;
        const batchInfo = batchIdToLine.get(batchResult.batchId)!;
        allocationRows.push({
          businessId,
          landedCostId: documentId,
          expenseId: null,
          purchaseItemId: lineResult.purchaseItemId,
          inventoryBatchId: batchResult.batchId,
          variantId: lineResult.variantId,
          allocationMethod: doc.allocationMethod,
          basisValue: batchResult.basisValue,
          allocatedAmount: Number(deltaQuads) / 10_000,
          allocatedPerUnit: batchResult.allocatedPerUnit,
          quantitySnapshot: batchResult.quantitySnapshot,
          weightSnapshot: batchResult.weightSnapshot,
          createdBy: actorUserId,
        });
        totalAllocatedQuads += deltaQuads;
        void batchInfo;
      }
    }
    if (allocationRows.length > 0) {
      await tx.insert(landedCostAllocations).values(allocationRows);
    }
    await recomputeBatchCosts(
      tx,
      businessId,
      allocationRows.map((r) => r.inventoryBatchId as number),
    );

    // Part F: units already sold out of an allocated batch cannot receive
    // their landed cost as inventory — record the stock/COGS split as a
    // traceable adjustment (only when some allocated units were sold).
    let inventoryQuads = 0n;
    let cogsQuads = 0n;
    for (const row of allocationRows) {
      const batchInfo = batchIdToLine.get(row.inventoryBatchId as number)!.batch;
      const receivedQuads = BigInt(Math.round(Number(batchInfo.quantityReceived) * 1000));
      const remainingQuads = BigInt(Math.round(Number(batchInfo.quantityRemaining) * 1000));
      const deltaQuads = BigInt(Math.round(Number(row.allocatedAmount) * 10_000));
      if (receivedQuads <= 0n) continue;
      const inv = (deltaQuads * remainingQuads) / receivedQuads;
      inventoryQuads += inv;
      cogsQuads += deltaQuads - inv;
    }

    // Phase 10: returns that PREDATE this posting — their units are not in
    // inventory either, but they were never SOLD: their share of the posted
    // money is REVERSED out (one traceable adjustment + posting per
    // return), not sent to COGS. Each return gets exactly the reversal its
    // return-time flow would have written had the document existed.
    const itemAllocatedQuads = new Map<number, bigint>();
    for (const row of allocationRows) {
      const itemId = row.purchaseItemId as number;
      itemAllocatedQuads.set(
        itemId,
        (itemAllocatedQuads.get(itemId) ?? 0n) +
          BigInt(Math.round(Number(row.allocatedAmount) * 10_000)),
      );
    }
    const itemReceivedMillis = new Map<number, bigint>();
    for (const line of context.lines) {
      let millis = itemReceivedMillis.get(line.purchaseItemId) ?? 0n;
      for (const batch of line.batches) {
        millis += BigInt(Math.round(Number(batch.quantityReceived) * 1000));
      }
      itemReceivedMillis.set(line.purchaseItemId, millis);
    }
    const reversalQuadsByReturn = await computeReturnReversalQuadsInTx(
      tx,
      businessId,
      doc.purchaseId,
      itemAllocatedQuads,
      itemReceivedMillis,
    );
    let prePostingReversalQuads = 0n;
    for (const quads of reversalQuadsByReturn.values()) {
      prePostingReversalQuads += quads;
    }

    const round2q = (q: bigint) => roundMoney(Number(q) / 10_000);
    let splitAdjustmentId: number | null = null;
    if (cogsQuads !== 0n) {
      const [splitRow] = await tx
        .insert(landedCostAdjustments)
        .values({
          businessId,
          landedCostId: documentId,
          adjustmentType: "manual",
          previousAllocatedAmount: 0,
          newAllocatedAmount: round2q(totalAllocatedQuads),
          adjustmentAmount: round2q(totalAllocatedQuads),
          inventoryAmount: round2q(inventoryQuads),
          cogsAmount: round2q(cogsQuads),
          reason: "Initial posting — units no longer in inventory split out (the returned share is carved out by the paired reversal)",
          referenceType: "landed_cost_post",
          referenceId: documentId,
          createdBy: actorUserId,
        })
        .returning({ id: landedCostAdjustments.id });
      splitAdjustmentId = splitRow?.id ?? null;
    }
    for (const [returnId, quads] of reversalQuadsByReturn) {
      if (quads === 0n) continue;
      await writeReturnReversalInTx(
        tx,
        doc,
        returnId,
        quads,
        totalAllocatedQuads,
        actorUserId,
      );
    }

    const totalCapitalizable = Math.round(preview.totalCapitalizableAmount * 100);
    const totalAllocated = Number(preview.allocation.allocatedTotal.toFixed(4));
    await tx
      .update(landedCosts)
      .set({
        // A pre-posting reversal marks the document "adjusted" — the same
        // status a return after posting produces.
        status: prePostingReversalQuads > 0n ? "adjusted" : "posted",
        postedBy: actorUserId,
        postedAt: new Date(),
        totalExpenseAmount: roundMoney(preview.totalExpenseAmount),
        totalCapitalizableAmount: roundMoney(preview.totalCapitalizableAmount),
        totalAllocatedAmount: totalAllocated,
        pendingAllocationAmount:
          roundMoney(preview.totalCapitalizableAmount - preview.allocation.allocatedTotal),
        updatedAt: new Date(),
      })
      .where(eq(landedCosts.id, documentId));

    // Accounting trail (Part G): capitalization + period-expense postings,
    // per expense, with settlement references.
    const [postedDoc] = await tx
      .select()
      .from(landedCosts)
      .where(eq(landedCosts.id, documentId))
      .limit(1);
    await writeAllocationPostings(
      tx,
      postedDoc!,
      expenseRows,
      BigInt(Math.round(totalAllocated * 10_000)),
      splitAdjustmentId,
    );

    await tx.insert(landedCostAuditLogs).values({
      businessId,
      landedCostId: documentId,
      action: "post",
      actorUserId,
      details: {
        allocationRows: allocationRows.length,
        totalAllocated,
        totalCapitalizable,
      },
    });
    return { documentId, totalAllocated };
  });
}

/**
 * Receive-flow delta (Part F): recompute cumulative targets now that more
 * batches exist, post only the difference. No-op when there is no posted
 * document. MUST run inside the receive transaction.
 *
 * Returns authoritative adjustment feedback for the receive response so the
 * frontend can render an adjustment notice without computing amounts itself.
 */
export interface ReceiveLandedCostDelta {
  adjusted: boolean;
  amount: number;
  documentId: number | null;
}

export interface ReceiveDeltaMetadata {
  /** Adjustment-row type. Defaults to 'receive_delta'. */
  adjustmentType?: "receive_delta" | "manual";
  /** What triggered the delta — defaults to the receiving purchase. */
  referenceType?: string;
  referenceId?: number;
  reason?: string;
}

export async function applyReceiveDeltaInTx(
  tx: DbTransaction,
  businessId: number,
  purchaseId: number,
  actorUserId: number,
  metadata: ReceiveDeltaMetadata = {},
): Promise<ReceiveLandedCostDelta> {
  const [doc] = await tx
    .select()
    .from(landedCosts)
    .where(
      and(eq(landedCosts.purchaseId, purchaseId), eq(landedCosts.businessId, businessId)),
    )
    .for("update")
    .limit(1);
  if (!doc || (doc.status !== "posted" && doc.status !== "adjusted")) {
    return { adjusted: false, amount: 0, documentId: doc?.id ?? null };
  }

  const { context, preview, expenseRows } = await computeDocumentTargets(
    tx,
    doc,
    businessId,
  );

  const postedRows = await tx
    .select({
      batchId: landedCostAllocations.inventoryBatchId,
      posted: sql<string>`COALESCE(SUM(${landedCostAllocations.allocatedAmount}), 0)`,
    })
    .from(landedCostAllocations)
    .where(
      and(
        eq(landedCostAllocations.landedCostId, doc.id),
        eq(landedCostAllocations.businessId, businessId),
      ),
    )
    .groupBy(landedCostAllocations.inventoryBatchId);
  const postedByBatch = new Map(
    postedRows.map((r) => [r.batchId, BigInt(Math.round(Number(r.posted) * 10_000))]),
  );

  const previousAllocated = [...postedByBatch.values()].reduce((a, b) => a + b, 0n);
  const batchIdToLine = new Map(
    context.lines.flatMap((line) =>
      line.batches.map((batch) => [batch.batchId, { line, batch }]),
    ),
  );

  type AllocationInsert = typeof landedCostAllocations.$inferInsert;
  const allocationRows: AllocationInsert[] = [];
  const touchedBatches: {
    batchId: number;
    deltaQuads: bigint;
    receivedQuads: bigint;
    remainingQuads: bigint;
  }[] = [];
  let newAllocatedQuads = 0n;

  for (const lineResult of preview.allocation.lines) {
    for (const batchResult of lineResult.batches) {
      const targetQuads = BigInt(Math.round(batchResult.allocatedAmount * 10_000));
      const previous = postedByBatch.get(batchResult.batchId) ?? 0n;
      const deltaQuads = targetQuads - previous;
      newAllocatedQuads += targetQuads;
      if (deltaQuads === 0n) continue;
      allocationRows.push({
        businessId,
        landedCostId: doc.id,
        expenseId: null,
        purchaseItemId: lineResult.purchaseItemId,
        inventoryBatchId: batchResult.batchId,
        variantId: lineResult.variantId,
        allocationMethod: doc.allocationMethod,
        basisValue: batchResult.basisValue,
        allocatedAmount: Number(deltaQuads) / 10_000,
        allocatedPerUnit: batchResult.allocatedPerUnit,
        quantitySnapshot: batchResult.quantitySnapshot,
        weightSnapshot:
          batchResult.weightSnapshot,
        createdBy: actorUserId,
      });
      const batchInfo = batchIdToLine.get(batchResult.batchId)!.batch;
      touchedBatches.push({
        batchId: batchResult.batchId,
        deltaQuads,
        receivedQuads: BigInt(Math.round(Number(batchInfo.quantityReceived) * 1000)),
        remainingQuads: BigInt(Math.round(Number(batchInfo.quantityRemaining) * 1000)),
      });
    }
  }

  if (allocationRows.length === 0) {
    return { adjusted: false, amount: 0, documentId: doc.id };
  }
  await tx.insert(landedCostAllocations).values(allocationRows);
  await recomputeBatchCosts(
    tx,
    businessId,
    touchedBatches.map((t) => t.batchId),
  );

  // Split each batch's delta between remaining inventory and units already
  // sold out of the batch (sold = received − remaining; consumption rows
  // carry the per-unit sale detail for reports). Phase 10: units RETURNED
  // before this delta are not sold — their share of the delta is reversed
  // out (one traceable entry per return), not sent to COGS.
  let inventoryQuads = 0n;
  let cogsQuads = 0n;
  for (const t of touchedBatches) {
    if (t.receivedQuads <= 0n) continue;
    const inv = (t.deltaQuads * t.remainingQuads) / t.receivedQuads;
    inventoryQuads += inv;
    cogsQuads += t.deltaQuads - inv;
  }

  const itemDeltaQuads = new Map<number, bigint>();
  for (const t of touchedBatches) {
    const itemId = batchIdToLine.get(t.batchId)!.line.purchaseItemId;
    itemDeltaQuads.set(itemId, (itemDeltaQuads.get(itemId) ?? 0n) + t.deltaQuads);
  }
  const itemReceivedMillis = new Map<number, bigint>();
  for (const line of context.lines) {
    let millis = itemReceivedMillis.get(line.purchaseItemId) ?? 0n;
    for (const batch of line.batches) {
      millis += BigInt(Math.round(Number(batch.quantityReceived) * 1000));
    }
    itemReceivedMillis.set(line.purchaseItemId, millis);
  }
  const reversalQuadsByReturn = await computeReturnReversalQuadsInTx(
    tx,
    businessId,
    purchaseId,
    itemDeltaQuads,
    itemReceivedMillis,
  );
  let prePostingReversalQuads = 0n;
  for (const quads of reversalQuadsByReturn.values()) {
    prePostingReversalQuads += quads;
  }

  const round2q = (q: bigint) => roundMoney(Number(q) / 10_000);

  const newAllocated = round2q(newAllocatedQuads);
  const [adjustment] = await tx
    .insert(landedCostAdjustments)
    .values({
      businessId,
      landedCostId: doc.id,
      adjustmentType: metadata.adjustmentType ?? "receive_delta",
      previousAllocatedAmount: round2q(previousAllocated),
      newAllocatedAmount: newAllocated,
      adjustmentAmount: roundMoney(newAllocated - round2q(previousAllocated)),
      inventoryAmount: round2q(inventoryQuads),
      cogsAmount: round2q(cogsQuads),
      reason: metadata.reason ?? "Subsequent receive — cumulative target delta",
      referenceType: metadata.referenceType ?? "purchase_receive",
      referenceId: metadata.referenceId ?? purchaseId,
      createdBy: actorUserId,
    })
    .returning({ id: landedCostAdjustments.id });

  // Accounting trail for the delta (Part G): per-expense capitalization of
  // the incremental amount, plus a COGS posting when sold units were hit.
  const deltaQuads = BigInt(
    Math.round(roundMoney(newAllocated - round2q(previousAllocated)) * 10_000),
  );
  if (deltaQuads > 0n) {
    await writeAllocationPostings(tx, doc, expenseRows, deltaQuads, adjustment!.id);
  }
  // The cogs POSTING carries the SOLD share only (raw batch-level bucket
  // minus the returned share carved out by the reversal postings below) —
  // the ledger shows net truth; the adjustment row keeps the raw split.
  const netCogsQuads = cogsQuads - prePostingReversalQuads;
  if (netCogsQuads !== 0n) {
    await tx.insert(landedCostPostings).values({
      businessId,
      landedCostId: doc.id,
      adjustmentId: adjustment!.id,
      postingType: "cogs_adjustment",
      amount: round2q(netCogsQuads),
      paymentSource: "unpaid",
      description: "Landed-cost delta attributable to sold units",
    });
  }
  for (const [returnId, quads] of reversalQuadsByReturn) {
    if (quads === 0n) continue;
    await writeReturnReversalInTx(
      tx,
      doc,
      returnId,
      quads,
      newAllocatedQuads,
      actorUserId,
    );
  }

  await tx
    .update(landedCosts)
    .set({
      status: "adjusted",
      // The capitalizable total comes from the CURRENT expenses — when an
      // expense is adjusted (Phase 7), the stale doc value would make the
      // pending go negative.
      totalCapitalizableAmount: roundMoney(preview.totalCapitalizableAmount),
      totalAllocatedAmount: preview.allocation.allocatedTotal,
      pendingAllocationAmount: roundMoney(
        Number(preview.totalCapitalizableAmount) - preview.allocation.allocatedTotal,
      ),
      updatedAt: new Date(),
    })
    .where(eq(landedCosts.id, doc.id));

  await tx.insert(landedCostAuditLogs).values({
    businessId,
    landedCostId: doc.id,
    action:
      (metadata.adjustmentType ?? "receive_delta") === "receive_delta"
        ? "receive_adjustment"
        : "expense_adjustment",
    actorUserId,
    details: {
      allocationRows: allocationRows.length,
      inventoryAmount: round2q(inventoryQuads),
      cogsAmount: round2q(cogsQuads),
      referenceType: metadata.referenceType ?? "purchase_receive",
      referenceId: metadata.referenceId ?? purchaseId,
    },
  });

  return {
    adjusted: true,
    amount: roundMoney(newAllocated - round2q(previousAllocated)),
    documentId: doc.id,
  };
}

/**
 * Purchase-return reversal: returned units carry their landed cost out of
 * inventory. Reverses perUnitLanded × returnedQty per consumed batch inside
 * the return's transaction and records a traceable reversal adjustment.
 *
 * Returns authoritative reversal feedback for the return response so the
 * frontend can render a reversal notice without computing amounts itself.
 */
export interface ReturnLandedCostReversal {
  adjusted: boolean;
  amount: number;
  documentId: number | null;
  /**
   * Phase 7: WHY the reversal is (or is not) applicable — the landed-cost
   * document's state, authoritatively reported so the frontend never has
   * to infer it: the document is posted/adjusted (reversal applied or
   * nothing to reverse), a draft (nothing capitalized yet), already
   * reversed, or no document exists.
   */
  state: "posted" | "adjusted" | "draft" | "reversed" | "no_document";
  reason: string | null;
}

export async function reverseForPurchaseReturnInTx(
  tx: DbTransaction,
  businessId: number,
  purchaseId: number,
  purchaseReturnId: number,
  consumed: { batchId: number; quantity: number }[],
  actorUserId: number,
): Promise<ReturnLandedCostReversal> {
  // The document is loaded first so EVERY exit path reports its actual
  // state (a return with nothing consumed still names the document's
  // state rather than a generic "no document").
  const [doc] = await tx
    .select()
    .from(landedCosts)
    .where(
      and(eq(landedCosts.purchaseId, purchaseId), eq(landedCosts.businessId, businessId)),
    )
    .for("update")
    .limit(1);
  if (consumed.length === 0) {
    return {
      adjusted: false,
      amount: 0,
      documentId: doc?.id ?? null,
      state: doc ? (doc.status as "posted" | "adjusted" | "draft" | "reversed") : "no_document",
      reason: doc
        ? "No returned units carried an inventory batch to reverse."
        : "No landed-cost document exists for this purchase.",
    };
  }
  if (!doc) {
    return {
      adjusted: false,
      amount: 0,
      documentId: null,
      state: "no_document",
      reason: "No landed-cost document exists for this purchase.",
    };
  }
  if (doc.status === "draft") {
    return {
      adjusted: false,
      amount: 0,
      documentId: doc.id,
      state: "draft",
      reason:
        "The landed-cost document is a draft — nothing is capitalized yet; if the goods are gone at posting time, the posting itself reverses the returned units' share.",
    };
  }
  if (doc.status === "reversed") {
    return {
      adjusted: false,
      amount: 0,
      documentId: doc.id,
      state: "reversed",
      reason: "The landed-cost document is already fully reversed.",
    };
  }

  const batchIds = consumed.map((c) => c.batchId);
  const batchRows = await tx
    .select({
      id: inventoryBatches.id,
      additionalCostPerUnit: inventoryBatches.additionalCostPerUnit,
    })
    .from(inventoryBatches)
    .where(
      and(eq(inventoryBatches.businessId, businessId), inArray(inventoryBatches.id, batchIds)),
    )
    .for("update");
  const costByBatch = new Map(
    batchRows.map((b) => [b.id, Number(b.additionalCostPerUnit ?? 0)]),
  );

  let reversalQuads = 0n;
  for (const c of consumed) {
    const perUnit = costByBatch.get(c.batchId) ?? 0;
    if (perUnit === 0) continue;
    reversalQuads += BigInt(Math.round(perUnit * c.quantity * 10_000));
  }
  if (reversalQuads === 0n) {
    return {
      adjusted: false,
      amount: 0,
      documentId: doc.id,
      state: doc.status as "posted" | "adjusted",
      reason: "The returned batches carry no allocated landed cost.",
    };
  }
  const reversalAmount = roundMoney(Number(reversalQuads) / 10_000);

  // Returns do NOT change a batch's per-unit additional cost — the
  // remaining units keep the same landed per-unit cost and total valuation
  // drops with quantity_remaining (already applied by the return's batch
  // consumption). The reversal row records the cost that left inventory.
  const previousAllocated = Number(doc.totalAllocatedAmount);

  const [reversalAdjustment] = await tx
    .insert(landedCostAdjustments)
    .values({
      businessId,
      landedCostId: doc.id,
      adjustmentType: "reversal",
      previousAllocatedAmount: previousAllocated,
      newAllocatedAmount: roundMoney(previousAllocated - reversalAmount),
      adjustmentAmount: -reversalAmount,
      inventoryAmount: -reversalAmount,
      cogsAmount: 0,
      reason: "Purchase return — landed cost of returned units reversed",
      referenceType: "purchase_return",
      referenceId: purchaseReturnId,
      createdBy: actorUserId,
    })
    .returning({ id: landedCostAdjustments.id });

  await tx.insert(landedCostPostings).values({
    businessId,
    landedCostId: doc.id,
    adjustmentId: reversalAdjustment!.id,
    postingType: "reversal",
    amount: -reversalAmount,
    paymentSource: "unpaid",
    description: "Landed cost of returned units reversed",
  });

  await tx
    .update(landedCosts)
    .set({
      status: "adjusted",
      updatedAt: new Date(),
    })
    .where(eq(landedCosts.id, doc.id));

  await tx.insert(landedCostAuditLogs).values({
    businessId,
    landedCostId: doc.id,
    action: "reverse",
    actorUserId,
    details: { purchaseReturnId, reversalAmount, batches: consumed.length },
  });

  return {
    adjusted: true,
    amount: reversalAmount,
    documentId: doc.id,
    state: "adjusted",
    reason: null,
  };
}
