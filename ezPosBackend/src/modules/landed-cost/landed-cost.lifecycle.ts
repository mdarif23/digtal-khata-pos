import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { landedCosts } from "../../db/schema/landedCosts.js";
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
import { getLandedCostContext, computeLandedCostPreview, type LandedCostContext } from "./landed-cost.service.js";
import type { LandedCostPreviewInput } from "./landed-cost.validation.js";
import type { DbTransaction } from "../purchases/purchase.types.js";
import { postLandedCostPostLedgerEntry } from "./landed-cost.ledger.js";

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
  // Validate the calculation up front (weights, manual sums, bases).
  computeLandedCostPreview(context.lines, {
    method: input.method,
    expenses: input.expenses,
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
    computeLandedCostPreview(context.lines, {
      method: input.method,
      expenses: input.expenses,
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
  const [expenses, allocations, adjustments, auditLogs, postings] = await Promise.all([
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
      .select()
      .from(landedCostPostings)
      .where(
        and(
          eq(landedCostPostings.landedCostId, documentId),
          eq(landedCostPostings.businessId, businessId),
        ),
      ),
  ]);
  return { document: doc, expenses, allocations, adjustments, auditLogs, postings };
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
    let splitAdjustmentId: number | null = null;
    if (cogsQuads !== 0n) {
      const round2q = (q: bigint) => roundMoney(Number(q) / 10_000);
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
          reason: "Initial posting — units already sold carry their landed cost into COGS",
          referenceType: "landed_cost_post",
          referenceId: documentId,
          createdBy: actorUserId,
        })
        .returning({ id: landedCostAdjustments.id });
      splitAdjustmentId = splitRow?.id ?? null;
    }

    const totalCapitalizable = Math.round(preview.totalCapitalizableAmount * 100);
    const totalAllocated = Number(preview.allocation.allocatedTotal.toFixed(4));
    await tx
      .update(landedCosts)
      .set({
        status: "posted",
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

    // Finance & Growth: post the initial capitalization to the double-entry
    // ledger (DR 1050/5010 weighted against the settlement credits; no-op
    // before Finance activation; idempotent per document).
    await postLandedCostPostLedgerEntry(tx, {
      businessId,
      documentId,
      inventoryAmount: Number(inventoryQuads) / 10_000,
      totalAllocated,
      expenses: expenseRows
        .filter((e) => e.isCapitalizable)
        .map((e) => ({
          capitalizable:
            Number(e.amount) +
            (e.taxTreatment === "non_recoverable" ? Number(e.taxAmount) : 0),
          settlementType: e.settlementType,
          settlementReferenceId: e.settlementReferenceId,
        })),
      locationId: doc.locationId,
      actorUserId,
    });

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

export async function applyReceiveDeltaInTx(
  tx: DbTransaction,
  businessId: number,
  purchaseId: number,
  actorUserId: number,
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
  // carry the per-unit sale detail for reports).
  let inventoryQuads = 0n;
  let cogsQuads = 0n;
  for (const t of touchedBatches) {
    if (t.receivedQuads <= 0n) continue;
    const inv = (t.deltaQuads * t.remainingQuads) / t.receivedQuads;
    inventoryQuads += inv;
    cogsQuads += t.deltaQuads - inv;
  }
  const round2q = (q: bigint) => roundMoney(Number(q) / 10_000);

  const newAllocated = round2q(newAllocatedQuads);
  const [adjustment] = await tx
    .insert(landedCostAdjustments)
    .values({
      businessId,
      landedCostId: doc.id,
      adjustmentType: "receive_delta",
      previousAllocatedAmount: round2q(previousAllocated),
      newAllocatedAmount: newAllocated,
      adjustmentAmount: roundMoney(newAllocated - round2q(previousAllocated)),
      inventoryAmount: round2q(inventoryQuads),
      cogsAmount: round2q(cogsQuads),
      reason: "Subsequent receive — cumulative target delta",
      referenceType: "purchase_receive",
      referenceId: purchaseId,
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
  if (cogsQuads !== 0n) {
    await tx.insert(landedCostPostings).values({
      businessId,
      landedCostId: doc.id,
      adjustmentId: adjustment!.id,
      postingType: "cogs_adjustment",
      amount: round2q(cogsQuads),
      paymentSource: "unpaid",
      description: "Landed-cost delta attributable to sold units",
    });
  }

  await tx
    .update(landedCosts)
    .set({
      status: "adjusted",
      totalAllocatedAmount: preview.allocation.allocatedTotal,
      pendingAllocationAmount: roundMoney(
        Number(doc.totalCapitalizableAmount) - preview.allocation.allocatedTotal,
      ),
      updatedAt: new Date(),
    })
    .where(eq(landedCosts.id, doc.id));

  await tx.insert(landedCostAuditLogs).values({
    businessId,
    landedCostId: doc.id,
    action: "receive_adjustment",
    actorUserId,
    details: {
      allocationRows: allocationRows.length,
      inventoryAmount: round2q(inventoryQuads),
      cogsAmount: round2q(cogsQuads),
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
}

export async function reverseForPurchaseReturnInTx(
  tx: DbTransaction,
  businessId: number,
  purchaseId: number,
  purchaseReturnId: number,
  consumed: { batchId: number; quantity: number }[],
  actorUserId: number,
): Promise<ReturnLandedCostReversal> {
  if (consumed.length === 0) {
    return { adjusted: false, amount: 0, documentId: null };
  }
  const [doc] = await tx
    .select()
    .from(landedCosts)
    .where(
      and(eq(landedCosts.purchaseId, purchaseId), eq(landedCosts.businessId, businessId)),
    )
    .for("update")
    .limit(1);
  if (!doc || doc.status === "draft" || doc.status === "reversed") {
    return { adjusted: false, amount: 0, documentId: doc?.id ?? null };
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
    return { adjusted: false, amount: 0, documentId: doc.id };
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

  return { adjusted: true, amount: reversalAmount, documentId: doc.id };
}
