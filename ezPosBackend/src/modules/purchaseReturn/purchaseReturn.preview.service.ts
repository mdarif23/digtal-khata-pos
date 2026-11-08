import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  inventoryBatches,
} from "../../db/schema/inventoryBatches.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { landedCosts } from "../../db/schema/landedCosts.js";
import {
  productVariants,
} from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import {
  purchaseReturnItems,
} from "../../db/schema/purchaseReturnItems.js";
import { purchaseReturns } from "../../db/schema/purchaseReturns.js";
import { purchaseItems } from "../../db/schema/purchaseItems.js";
import { purchases } from "../../db/schema/purchases.js";
import { NotFoundError } from "../../utils/handleError.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { assertReturnablePurchase } from "./return.validation.js";
import { evaluateReturnEligibility } from "./return.validation.js";
import {
  computeReturnCredits,
} from "./return.valuation.js";
import type { PurchaseReturnPreviewInput } from "./purchaseReturn.preview.schema.js";

// Takes the caller's server-verified businessId (from requireBusinessContext).

/**
 * Server-authoritative purchase-return preview (Phase 2): what THIS return
 * would pay, computed from the same pure valuation the committing return
 * uses — batch-FIFO credits at real purchase prices, the amortized
 * discount/tax adjustments, the landed-cost reversal per the document's
 * state, and the supplier-balance split (outstanding vs credit created).
 *
 * Informational only: no locks, no writes, no reservation. The committing
 * return re-locks and recalculates — the preview is a faithful estimate of
 * that recalculation, not a guarantee (concurrent sales/returns between
 * preview and submit change the outcome; the submit path validates and
 * refuses rather than silently paying a different amount).
 */
export async function previewPurchaseReturn(
  businessId: number,
  purchaseId: number,
  input: PurchaseReturnPreviewInput,
) {
  const [purchase] = await db
    .select({
      id: purchases.id,
      supplierId: purchases.supplierId,
      locationId: purchases.locationId,
      dueAmount: purchases.dueAmount,
      totalAmount: purchases.totalAmount,
      paidAmount: purchases.paidAmount,
    })
    .from(purchases)
    .where(and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)))
    .limit(1);

  if (!purchase) {
    throw new NotFoundError("Purchase order not found.");
  }
  assertReturnablePurchase(purchase);
  const locationId: number = purchase.locationId;

  const requestedByItem = new Map(
    input.changedItems.map((item) => [item.purchaseItemId, item.quantity]),
  );
  const purchaseItemIds = [...requestedByItem.keys()];

  const itemRows = await db
    .select({
      id: purchaseItems.id,
      variantId: purchaseItems.variantId,
      quantity: purchaseItems.quantity,
      receivedQuantity: purchaseItems.receivedQuantity,
      unitCost: purchaseItems.unitCost,
      discount: purchaseItems.discount,
      tax: purchaseItems.tax,
      trackingType: products.trackingType,
    })
    .from(purchaseItems)
    .innerJoin(productVariants, eq(purchaseItems.variantId, productVariants.id))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(purchaseItems.purchaseId, purchaseId),
        eq(purchaseItems.businessId, businessId),
        inArray(purchaseItems.id, purchaseItemIds),
      ),
    );

  if (itemRows.length !== purchaseItemIds.length) {
    throw new NotFoundError(
      "One or more selected items do not belong to this purchase order.",
    );
  }

  const returnRows = await db
    .select({
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
        eq(purchaseReturnItems.businessId, businessId),
        inArray(purchaseReturnItems.purchaseItemId, purchaseItemIds),
      ),
    );
  const returnedByItem = new Map<number, number>();
  for (const row of returnRows) {
    returnedByItem.set(
      row.purchaseItemId,
      (returnedByItem.get(row.purchaseItemId) ?? 0) + Number(row.quantity),
    );
  }

  const stockRows = await db
    .select({
      variantId: inventoryStock.variantId,
      quantity: inventoryStock.quantity,
    })
    .from(inventoryStock)
    .where(
      and(
        eq(inventoryStock.businessId, businessId),
        eq(inventoryStock.locationId, locationId),
        inArray(
          inventoryStock.variantId,
          [...new Set(itemRows.map((item) => item.variantId))],
        ),
      ),
    );
  const stockByVariant = new Map(
    stockRows.map((row) => [row.variantId, Number(row.quantity ?? 0)]),
  );

  // Eligibility: the SAME rule set the committing return enforces —
  // reported as issues instead of thrown so the UI can disable submit.
  const { issues } = evaluateReturnEligibility({
    items: itemRows,
    requestedByItem,
    returnedByItem,
    stockByVariant,
  });

  // Valuation: ONE implementation shared with the committing transaction.
  const lineAdjustmentOf = (item: (typeof itemRows)[number]) =>
    (Number(item.tax) - Number(item.discount)) / Number(item.quantity);
  const fallbackUnitPriceOf = (item: (typeof itemRows)[number]) =>
    Math.max(
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
  const requestedVariantIds = [...new Set(itemRows.map((item) => item.variantId))];
  const poolRows = requestedVariantIds.length
    ? await db
        .select({
          id: inventoryBatches.id,
          variantId: inventoryBatches.variantId,
          quantityRemaining: inventoryBatches.quantityRemaining,
          purchasePrice: inventoryBatches.purchasePrice,
        })
        .from(inventoryBatches)
        .innerJoin(
          purchaseItems,
          and(
            eq(inventoryBatches.purchaseItemId, purchaseItems.id),
            eq(inventoryBatches.businessId, purchaseItems.businessId),
          ),
        )
        .where(
          and(
            eq(inventoryBatches.businessId, businessId),
            eq(inventoryBatches.locationId, locationId),
            eq(purchaseItems.purchaseId, purchaseId),
            inArray(inventoryBatches.variantId, requestedVariantIds),
          ),
        )
        .orderBy(inventoryBatches.id)
    : [];

  const valuation = computeReturnCredits(
    itemRows.map((item) => ({
      purchaseItemId: item.id,
      variantId: item.variantId,
      lineAdjustment: lineAdjustmentOf(item),
      fallbackUnitPrice: fallbackUnitPriceOf(item),
    })),
    requestedByItem,
    poolRows.map((row) => ({
      batchId: row.id,
      variantId: row.variantId as number,
      quantityRemaining: Number(row.quantityRemaining),
      purchasePrice: Number(row.purchasePrice),
    })),
  );
  if (valuation.shortfall) {
    issues.push(
      `Insufficient available batch quantity for purchase item ${valuation.shortfall.purchaseItemId}.`,
    );
  }

  // Landed-cost state (C): the reversal the commit would post, per the
  // document's CURRENT state — no document / draft / reversed mean nothing
  // is capitalized to reverse.
  const [doc] = await db
    .select({
      status: landedCosts.status,
      pendingAllocationAmount: landedCosts.pendingAllocationAmount,
    })
    .from(landedCosts)
    .where(
      and(
        eq(landedCosts.purchaseId, purchaseId),
        eq(landedCosts.businessId, businessId),
      ),
    )
    .limit(1);

  const consumedBatchIds = [...valuation.consumedByBatch.keys()];
  const additionalByBatch = new Map<number, number>();
  if (consumedBatchIds.length) {
    const rows = await db
      .select({
        id: inventoryBatches.id,
        purchasePrice: inventoryBatches.purchasePrice,
        additional: inventoryBatches.additionalCostPerUnit,
      })
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          inArray(inventoryBatches.id, consumedBatchIds),
        ),
      );
    for (const row of rows) {
      additionalByBatch.set(row.id, Number(row.additional ?? 0));
    }
  }

  let landedCost: {
    applies: boolean;
    state: "no_document" | "draft" | "posted" | "adjusted" | "reversed";
    expectedReversal: number;
    pendingAllocation: number | null;
    reason: string | null;
  };
  if (!doc) {
    landedCost = {
      applies: false,
      state: "no_document",
      expectedReversal: 0,
      pendingAllocation: null,
      reason: "No landed-cost document exists for this purchase.",
    };
  } else if (doc.status === "draft") {
    landedCost = {
      applies: false,
      state: "draft",
      expectedReversal: 0,
      pendingAllocation: Number(doc.pendingAllocationAmount ?? 0),
      reason:
        "The landed-cost document is a draft — nothing is capitalized yet; if the goods are gone at posting time, the posting itself reverses the returned units' share.",
    };
  } else if (doc.status === "reversed") {
    landedCost = {
      applies: false,
      state: "reversed",
      expectedReversal: 0,
      pendingAllocation: Number(doc.pendingAllocationAmount ?? 0),
      reason: "The landed-cost document is already fully reversed.",
    };
  } else {
    const expectedReversal = roundMoney(
      [...valuation.consumedByBatch].reduce(
        (sum, [batchId, quantity]) =>
          sum + (additionalByBatch.get(batchId) ?? 0) * quantity,
        0,
      ),
    );
    landedCost = {
      applies: expectedReversal > 0,
      state: doc.status as "posted" | "adjusted",
      expectedReversal,
      pendingAllocation: Number(doc.pendingAllocationAmount ?? 0),
      reason:
        expectedReversal > 0
          ? null
          : "The returned batches carry no allocated landed cost.",
    };
  }

  // D. Inventory valuation reduction: full landed unit cost leaves stock.
  const valuationReduction = roundMoney(
    [...valuation.consumedByBatch].reduce(
      (sum, [batchId, quantity]) => {
        const poolRow = poolRows.find((row) => row.id === batchId);
        const unitLanded =
          Number(poolRow?.purchasePrice ?? 0) +
          (additionalByBatch.get(batchId) ?? 0);
        return sum + unitLanded * quantity;
      },
      0,
    ),
  );

  // B. Goods credit (the supplier's money) — batch cost + adjustments.
  const goodsCreditTotal = roundMoney(
    [...valuation.creditByItemId.values()].reduce((sum, c) => sum + c, 0),
  );

  // E. Supplier balance: outstanding debt vs the credit balance created.
  const outstandingBefore = roundMoney(Number(purchase.dueAmount));
  const outstandingAfter = roundMoney(
    Math.max(0, outstandingBefore - goodsCreditTotal),
  );
  const supplierCreditCreated = roundMoney(
    Math.max(0, goodsCreditTotal - outstandingBefore),
  );

  const quantities = itemRows.map((item) => {
    const eligible = Math.max(
      0,
      Number(item.receivedQuantity) - (returnedByItem.get(item.id) ?? 0),
    );
    const requested = requestedByItem.get(item.id) ?? 0;
    return {
      purchaseItemId: item.id,
      orderedQuantity: Number(item.quantity),
      receivedQuantity: Number(item.receivedQuantity),
      previouslyReturned: returnedByItem.get(item.id) ?? 0,
      eligibleQuantity: eligible,
      availableStock: stockByVariant.get(item.variantId) ?? 0,
      requestedQuantity: requested,
      remainingAfterReturn: Math.max(0, eligible - requested),
    };
  });

  return {
    success: true,
    data: {
      purchaseId,
      canSubmit: issues.length === 0,
      issues,
      quantities,
      goodsCredit: {
        total: goodsCreditTotal,
        lineCredits: [...valuation.creditByItemId].map(
          ([purchaseItemId, credit]) => ({
            purchaseItemId,
            quantity: requestedByItem.get(purchaseItemId) ?? 0,
            goodsCredit: credit,
          }),
        ),
      },
      landedCost,
      inventory: {
        valuationReduction,
        batchBreakdown: [...valuation.consumedByBatch].map(
          ([batchId, quantity]) => ({
            batchId,
            quantity,
            unitCost:
              poolRows.find((row) => row.id === batchId)?.purchasePrice ?? 0,
            unitAdditionalCost: additionalByBatch.get(batchId) ?? 0,
          }),
        ),
      },
      supplierBalance: {
        outstandingBefore,
        goodsCredit: goodsCreditTotal,
        outstandingAfter,
        supplierCreditCreated,
      },
    },
  };
}
