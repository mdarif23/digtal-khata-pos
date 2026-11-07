import { and, eq, inArray } from "drizzle-orm";
import type { DbTransaction } from "./purchase.types.js";
import { db } from "../../db/schema/index.js";
import { purchaseDiscrepancies } from "../../db/schema/purchaseDiscrepancies.js";
import { purchaseItems } from "../../db/schema/purchaseItems.js";
import { purchases } from "../../db/schema/purchases.js";
import { supplierLedger } from "../../db/schema/supplierLedger.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import {
  applyReceiveDeltaInTx,
  lockDocumentForPurchaseInTx,
} from "../landed-cost/landed-cost.lifecycle.js";
import { calculatePurchaseStatus } from "./receive/receive.calculations.js";
import type {
  ResolveOutstandingInput,
  ResolveDiscrepancyInput,
} from "./outstandingResolution.schema.js";

// Takes the caller's server-verified businessId (from requireBusinessContext)
// and scopes all reads and writes to it.

/**
 * Short-receiving resolution (Phase 3). For each requested line:
 * - `receive_later` / `backordered` record the decision — the outstanding
 *   quantity stays outstanding and the payable is untouched.
 * - `cancel` writes the quantity off: excluded from outstanding
 *   (received + cancelled >= ordered completes the line) and the payable
 *   drops by the line's per-unit order value × cancelled quantity. The
 *   reduction also lands in the supplier ledger so ledger balances keep
 *   matching the derived outstanding. Walk-in purchases (no supplier)
 *   skip the ledger row — there is no ledger to keep.
 *
 * Missing goods never create stock: this flow writes no inventory at all.
 */
export async function resolveOutstandingQuantities(
  businessId: number,
  purchaseId: number,
  actorUserId: number,
  input: ResolveOutstandingInput,
) {
  const requestedIds = input.items.map((item) => item.purchaseItemId);
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw new BadRequestError("Duplicate purchase items are not allowed.");
  }

  return db.transaction(async (tx) => {
    const [purchase] = await tx
      .select({
        id: purchases.id,
        supplierId: purchases.supplierId,
        paidAmount: purchases.paidAmount,
        dueAmount: purchases.dueAmount,
      })
      .from(purchases)
      .where(
        and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)),
      )
      .for("update");

    if (!purchase) {
      throw new NotFoundError("Purchase order not found.");
    }

    // Lock-order anchor (see lockDocumentForPurchaseInTx): the landed-cost
    // document row is locked before the purchase items so the delta's
    // allocation inserts can never cross-wait with a receive or a post.
    await lockDocumentForPurchaseInTx(tx, businessId, purchaseId);

    const items = await tx
      .select({
        id: purchaseItems.id,
        quantity: purchaseItems.quantity,
        receivedQuantity: purchaseItems.receivedQuantity,
        cancelledQuantity: purchaseItems.cancelledQuantity,
        unitCost: purchaseItems.unitCost,
        discount: purchaseItems.discount,
        tax: purchaseItems.tax,
      })
      .from(purchaseItems)
      .where(
        and(
          eq(purchaseItems.purchaseId, purchaseId),
          eq(purchaseItems.businessId, businessId),
          inArray(purchaseItems.id, requestedIds),
        ),
      )
      .for("update");

    if (items.length !== requestedIds.length) {
      throw new BadRequestError(
        "One or more selected items do not belong to this purchase order.",
      );
    }

    const requestedByItem = new Map(
      input.items.map((item) => [item.purchaseItemId, item]),
    );

    let cancelledValue = 0;
    let cancellationNote: string | null = null;
    const discrepancyRows: (typeof purchaseDiscrepancies.$inferInsert)[] = [];
    const resolved: {
      purchaseItemId: number;
      quantity: number;
      resolution: string;
      outstandingAfter: number;
    }[] = [];

    for (const item of items) {
      const request = requestedByItem.get(item.id)!;
      const outstanding =
        Number(item.quantity) -
        Number(item.receivedQuantity) -
        Number(item.cancelledQuantity);

      if (request.quantity > outstanding + 1e-9) {
        throw new BadRequestError(
          `Cannot resolve ${request.quantity} unit(s) of item ${item.id}; only ${Math.max(outstanding, 0)} remain outstanding.`,
        );
      }

      discrepancyRows.push({
        businessId,
        purchaseId,
        purchaseItemId: item.id,
        type: "shortage",
        quantity: request.quantity,
        reason: request.reason?.trim() || null,
        status: "resolved",
        resolution: request.resolution,
        requestedByUserId: actorUserId,
        resolvedByUserId: actorUserId,
        resolvedAt: new Date(),
      });

      if (request.resolution === "cancel") {
        await tx
          .update(purchaseItems)
          .set({
            cancelledQuantity:
              Number(item.cancelledQuantity) + request.quantity,
          })
          .where(
            and(
              eq(purchaseItems.id, item.id),
              eq(purchaseItems.businessId, businessId),
            ),
          );

        // The line's per-unit ORDER value (same amortization the return
        // credit uses for its line adjustment) — the invoice value of the
        // units the supplier will never deliver.
        const perUnitValue = Math.max(
          0,
          Number(
            (
              (Number(item.quantity) * Number(item.unitCost) -
                Number(item.discount) +
                Number(item.tax)) /
              Number(item.quantity)
            ).toFixed(2),
          ),
        );
        cancelledValue += request.quantity * perUnitValue;
        cancellationNote = request.reason?.trim() || cancellationNote;
      }

      resolved.push({
        purchaseItemId: item.id,
        quantity: request.quantity,
        resolution: request.resolution,
        outstandingAfter:
          request.resolution === "cancel"
            ? roundMoney(outstanding - request.quantity)
            : roundMoney(outstanding),
      });
    }

    cancelledValue = roundMoney(cancelledValue);

    if (discrepancyRows.length > 0) {
      await tx.insert(purchaseDiscrepancies).values(discrepancyRows);
    }

    let updatedDueAmount = roundMoney(Number(purchase.dueAmount));
    let paymentStatus: "paid" | "unpaid" | "partial" | null = null;

    if (cancelledValue > 0) {
      updatedDueAmount = Math.max(
        0,
        roundMoney(Number(purchase.dueAmount) - cancelledValue),
      );
      // Same convention as the purchase-return flow: the payable is gone
      // when the due reaches zero, regardless of how it got there.
      paymentStatus =
        updatedDueAmount === 0
          ? "paid"
          : Number(purchase.paidAmount) > 0
            ? "partial"
            : "unpaid";

      await tx
        .update(purchases)
        .set({
          dueAmount: updatedDueAmount,
          paymentStatus,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(purchases.id, purchaseId),
            eq(purchases.businessId, businessId),
          ),
        );

      // Ledger keeps matching the derived outstanding. Walk-in purchases
      // (no supplier) have no ledger to keep.
      if (purchase.supplierId !== null) {
        await tx.insert(supplierLedger).values({
          businessId,
          supplierId: purchase.supplierId,
          transactionType: "PURCHASE_CANCELLATION",
          referenceId: purchaseId,
          credit: cancelledValue,
          note:
            cancellationNote ||
            `Cancelled outstanding quantity on PO #${purchaseId}`,
        });
      }
    }

    // Landed-cost delta (Phase 6): cancelling outstanding quantity reduces
    // the effective ordered basis, so a posted document's pending share
    // becomes allocatable to the already-received batches — adjusted in
    // the SAME transaction. No-op when there is no posted document, or for
    // receive-later / backordered resolutions (nothing was cancelled).
    let landedCost: Awaited<ReturnType<typeof applyReceiveDeltaInTx>> = {
      adjusted: false,
      amount: 0,
      documentId: null,
    };
    if (cancelledValue > 0) {
      landedCost = await applyReceiveDeltaInTx(
        tx,
        businessId,
        purchaseId,
        actorUserId,
      );
    }

    // Cancelled quantities complete lines: refresh the receiving status so
    // a fully-resolved purchase reads "received" (nothing outstanding).
    const statusItems = await tx
      .select({
        quantity: purchaseItems.quantity,
        receivedQuantity: purchaseItems.receivedQuantity,
        cancelledQuantity: purchaseItems.cancelledQuantity,
      })
      .from(purchaseItems)
      .where(
        and(
          eq(purchaseItems.purchaseId, purchaseId),
          eq(purchaseItems.businessId, businessId),
        ),
      );
    const newStatus = calculatePurchaseStatus(statusItems);
    await tx
      .update(purchases)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(
        and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)),
      );

    return {
      success: true,
      message: "Outstanding quantities resolved.",
      data: {
        purchaseId,
        status: newStatus,
        resolved,
        cancelledValue,
        dueAmount: updatedDueAmount,
        paymentStatus,
        landedCost,
      },
    };
  });
}

/**
 * Invoice value written off by short-receiving cancellations on a purchase
 * — Σ line per-unit order value × cancelled_quantity. Feeds the payment
 * math (the effective invoice total nets this out) in BOTH the receive
 * flow and due-management supplier payments.
 */
export async function getPurchaseCancelledValueInTx(
  tx: DbTransaction,
  businessId: number,
  purchaseId: number,
): Promise<number> {
  const items = await tx
    .select({
      quantity: purchaseItems.quantity,
      cancelledQuantity: purchaseItems.cancelledQuantity,
      unitCost: purchaseItems.unitCost,
      discount: purchaseItems.discount,
      tax: purchaseItems.tax,
    })
    .from(purchaseItems)
    .where(
      and(
        eq(purchaseItems.purchaseId, purchaseId),
        eq(purchaseItems.businessId, businessId),
      ),
    );

  return roundMoney(
    items.reduce((sum, item) => {
      const ordered = Number(item.quantity);
      if (ordered <= 0) return sum;
      const perUnitValue = Math.max(
        0,
        Number(
          (
            (ordered * Number(item.unitCost) -
              Number(item.discount) +
              Number(item.tax)) /
            ordered
          ).toFixed(2),
        ),
      );
      return sum + perUnitValue * Number(item.cancelledQuantity);
    }, 0),
  );
}

/**
 * Record the settlement of an OPEN rejection discrepancy (Phase 4). This
 * only completes the audit trail — no supplier credit, payment, or
 * inventory change is produced here.
 */
export async function resolvePurchaseDiscrepancy(
  businessId: number,
  purchaseId: number,
  discrepancyId: number,
  actorUserId: number,
  input: ResolveDiscrepancyInput,
) {
  return db.transaction(async (tx) => {
    const [purchase] = await tx
      .select({ id: purchases.id })
      .from(purchases)
      .where(
        and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)),
      )
      .limit(1);
    if (!purchase) {
      throw new NotFoundError("Purchase order not found.");
    }

    const [discrepancy] = await tx
      .select()
      .from(purchaseDiscrepancies)
      .where(
        and(
          eq(purchaseDiscrepancies.id, discrepancyId),
          eq(purchaseDiscrepancies.businessId, businessId),
          eq(purchaseDiscrepancies.purchaseId, purchaseId),
        ),
      )
      .for("update")
      .limit(1);

    if (!discrepancy) {
      throw new NotFoundError("Discrepancy not found.");
    }
    if (discrepancy.type !== "rejection") {
      throw new BadRequestError(
        "Only rejection discrepancies are resolved through this workflow.",
      );
    }
    if (discrepancy.status !== "open") {
      throw new ConflictError(
        "This discrepancy has already been resolved.",
      );
    }

    const [updated] = await tx
      .update(purchaseDiscrepancies)
      .set({
        status: "resolved",
        resolution: input.resolution,
        resolvedByUserId: actorUserId,
        resolvedAt: new Date(),
        reason: input.reason?.trim() || discrepancy.reason,
        updatedAt: new Date(),
      })
      .where(eq(purchaseDiscrepancies.id, discrepancyId))
      .returning();

    return {
      success: true,
      message: "Rejection resolution recorded.",
      data: {
        discrepancyId: updated!.id,
        purchaseItemId: updated!.purchaseItemId,
        type: updated!.type,
        quantity: Number(updated!.quantity),
        resolution: updated!.resolution,
        status: updated!.status,
      },
    };
  });
}

/**
 * Discrepancy audit trail for a purchase: every receiving record (the
 * per-delivery delivered/accepted/rejected split) and every discrepancy
 * with its resolution state. Read model for the receiving UI.
 */
export async function getPurchaseDiscrepancyDetail(
  businessId: number,
  purchaseId: number,
) {
  const [purchase] = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)),
    )
    .limit(1);
  if (!purchase) {
    throw new NotFoundError("Purchase order not found.");
  }

  const { purchaseReceivingRecords } = await import(
    "../../db/schema/purchaseReceivingRecords.js"
  );
  const [receivingRecords, discrepancies] = await Promise.all([
    db
      .select()
      .from(purchaseReceivingRecords)
      .where(
        and(
          eq(purchaseReceivingRecords.businessId, businessId),
          eq(purchaseReceivingRecords.purchaseId, purchaseId),
        ),
      )
      .orderBy(purchaseReceivingRecords.id),
    db
      .select()
      .from(purchaseDiscrepancies)
      .where(
        and(
          eq(purchaseDiscrepancies.businessId, businessId),
          eq(purchaseDiscrepancies.purchaseId, purchaseId),
        ),
      )
      .orderBy(purchaseDiscrepancies.id),
  ]);

  return {
    success: true,
    data: {
      purchaseId,
      receivingRecords: receivingRecords.map((record) => ({
        ...record,
        deliveredQuantity: Number(record.deliveredQuantity),
        acceptedQuantity: Number(record.acceptedQuantity),
        rejectedQuantity: Number(record.rejectedQuantity),
        unitCost: Number(record.unitCost),
      })),
      discrepancies: discrepancies.map((row) => ({
        ...row,
        quantity: Number(row.quantity),
      })),
    },
  };
}
