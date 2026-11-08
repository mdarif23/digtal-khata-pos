import {
  and,
  asc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  foldVariantOptionRows,
  variantNameFromMap,
  variantOptionsFromMap,
} from "../../utils/variantDisplay.js";
import { variantOptions } from "../../db/schema/variantOptions.js";
import { variantValues } from "../../db/schema/variantValues.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { purchaseItems } from "../../db/schema/purchaseItems.js";
import { purchaseReturnItems } from "../../db/schema/purchaseReturnItems.js";
import { purchaseReturns } from "../../db/schema/purchaseReturns.js";
import { purchases } from "../../db/schema/purchases.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import { supplierLedger } from "../../db/schema/supplierLedger.js";
import {
  lockDocumentForPurchaseInTx,
  reverseForPurchaseReturnInTx,
} from "../landed-cost/landed-cost.lifecycle.js";
import {
  assertStockDecremented,
  decrementStockGuarded,
  markSerialsReturned,
  recordStockMovement,
} from "../inventory/index.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import type { CreatePurchaseReturnInput } from "./purchaseReturn.schema.js";
import {
  assertItemsBelongToPurchase,
  assertReturnEligibility,
  assertReturnablePurchase,
  validateReturnRequest,
} from "./return.validation.js";
import { computeReturnCredits } from "./return.valuation.js";

// Takes the caller's server-verified businessId (from requireBusinessContext)
// and scopes all reads and writes to it.
export async function createPurchaseReturn(
  businessId: number,
  {
    orderId,
    changedItems,
    reason,
  }: CreatePurchaseReturnInput,
  actorUserId?: number,
) {
  const purchaseItemIds = validateReturnRequest(changedItems);

  return db.transaction(async (tx) => {
    const [purchase] = await tx
      .select({
        id: purchases.id,
        supplierId: purchases.supplierId,
        paidAmount: purchases.paidAmount,
        dueAmount: purchases.dueAmount,
        locationId: purchases.locationId,
      })
      .from(purchases)
      .where(
        and(eq(purchases.id, orderId), eq(purchases.businessId, businessId)),
      )
      .for("update");

    if (!purchase) {
      throw new NotFoundError("Purchase order not found.");
    }
    assertReturnablePurchase(purchase);
    const locationId: number = purchase.locationId;

    // Lock-order anchor (see lockDocumentForPurchaseInTx): the landed-cost
    // document row is locked before the purchase items so the reversal's
    // allocation FKs can never cross-wait with a receive or a post.
    await lockDocumentForPurchaseInTx(tx, businessId, orderId);

    const items = await tx
      .select({
        id: purchaseItems.id,
        variantId: purchaseItems.variantId,
        productId: productVariants.productId,
        quantity: purchaseItems.quantity,
        receivedQuantity: purchaseItems.receivedQuantity,
        unitCost: purchaseItems.unitCost,
        discount: purchaseItems.discount,
        tax: purchaseItems.tax,
        trackingType: products.trackingType,
      })
      .from(purchaseItems)
      .innerJoin(
        productVariants,
        eq(productVariants.id, purchaseItems.variantId),
      )
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(purchaseItems.purchaseId, orderId),
          eq(purchaseItems.businessId, businessId),
          inArray(purchaseItems.id, purchaseItemIds),
        ),
      )
      .for("update");

    assertItemsBelongToPurchase(items, purchaseItemIds);

    const alreadyReturned = await tx
      .select({
        purchaseItemId: purchaseReturnItems.purchaseItemId,
        quantity: sql<number>`COALESCE(SUM(${purchaseReturnItems.quantity}), 0)`,
      })
      .from(purchaseReturnItems)
      .where(
        and(
          eq(purchaseReturnItems.businessId, businessId),
          inArray(purchaseReturnItems.purchaseItemId, purchaseItemIds),
        ),
      )
      .groupBy(purchaseReturnItems.purchaseItemId);
    const returnedByItem = new Map(
      alreadyReturned.map((item) => [
        item.purchaseItemId,
        Number(item.quantity),
      ]),
    );
    const requestedByItem = new Map(
      changedItems.map((item) => [item.purchaseItemId, item.quantity]),
    );
    // Phase 5: explicit serial selections per line (absent = auto-pick).
    const serialIdsByItem = new Map(
      changedItems
        .filter((item) => item.serialIds !== undefined)
        .map((item) => [item.purchaseItemId, item.serialIds!]),
    );
    // Purchase returns deduct stock at the RETURN's location (the location
    // the purchase was received into).
    const stockRows = await tx
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
            [...new Set(items.map((item) => item.variantId))],
          ),
        ),
      )
      .for("update");
    const stockByVariant = new Map(
      stockRows.map((row) => [row.variantId, Number(row.quantity ?? 0)]),
    );
    // Eligibility (received − returned per line, on-hand stock per variant)
    // is enforced in return.validation.ts; it returns the aggregated
    // return demand per variant used by the stock decrement below.
    const requestedByVariant = assertReturnEligibility({
      items,
      requestedByItem,
      returnedByItem,
      stockByVariant,
    });

    let totalAmount = 0;
    // D1 (batch-authoritative credit): each returned unit is credited at the
    // purchase_price of the batch it actually comes out of (FIFO by batch
    // id), plus the line's discount/tax amortized over the ordered quantity
    // — unchanged from the previous formula except that the cost basis is
    // now the unit's real receive-time cost instead of the line's single
    // cost column. Returning a fully received line credits exactly its net
    // line value.
    const lineAdjustment = (item: (typeof items)[number]) =>
      (Number(item.tax) - Number(item.discount)) / Number(item.quantity);
    const getReturnUnitPrice = (item: (typeof items)[number]) =>
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
    // Landed-cost reversal tracking (Part F): every unit taken from a batch
    // carries its per-unit landed cost out of inventory.
    const landedConsumed: { batchId: number; quantity: number }[] = [];
    // Phase 5 traceability: the serial numbers this return actually marks.
    const returnedSerials: string[] = [];
    // Line credit (money) by purchase item id — the purchaseReturnItems row
    // stores the average per-unit credit; total_amount governs the money.
    const creditByItemId = new Map<number, number>();

    // Batch pool per variant (Phase 6 fix): sales consume batches FIFO
    // across the whole VARIANT, so a returned unit may physically sit in a
    // sibling line's batch. The pool therefore spans this purchase's lines
    // sharing the variant, at the receiving location — consumed FIFO by
    // batch id across the return's lines (items processed in id order).
    // Cross-purchase fungibility is deliberately NOT allowed: a return
    // never credits costs from another PO's batches.
    const requestedVariantIds = [...new Set(items.map((item) => item.variantId))];
    const poolRows = requestedVariantIds.length
      ? await tx
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
              eq(purchaseItems.purchaseId, orderId),
              inArray(inventoryBatches.variantId, requestedVariantIds),
            ),
          )
          .orderBy(inventoryBatches.id)
          .for("update")
      : [];
    // Phase 2: the credit math lives in return.valuation.ts — ONE pure
    // implementation shared with the return-preview endpoint, so a preview
    // can never disagree with what the return actually pays. This
    // transaction owns the locked reads (poolRows) and applies the
    // returned consumption as the real decrements.
    const valuation = computeReturnCredits(
      items.map((item) => ({
        purchaseItemId: item.id,
        variantId: item.variantId,
        lineAdjustment: lineAdjustment(item),
        fallbackUnitPrice: getReturnUnitPrice(item),
      })),
      requestedByItem,
      poolRows.map((row) => ({
        batchId: row.id,
        variantId: row.variantId as number,
        quantityRemaining: Number(row.quantityRemaining),
        purchasePrice: Number(row.purchasePrice),
      })),
    );

    // Every returned unit must trace to a batch row (its cost basis). A
    // shortfall means the on-hand units came from another purchase's
    // batches (mixed sales) — refuse rather than mis-credit.
    if (valuation.shortfall) {
      throw new BadRequestError(
        `Insufficient available batch quantity for purchase item ${valuation.shortfall.purchaseItemId}.`,
      );
    }
    for (const [batchId, quantity] of valuation.consumedByBatch) {
      await tx
        .update(inventoryBatches)
        .set({
          quantityRemaining: sql`${inventoryBatches.quantityRemaining} - ${quantity}`,
        })
        .where(
          and(
            eq(inventoryBatches.id, batchId),
            eq(inventoryBatches.businessId, businessId),
          ),
        );
    }
    for (const entry of valuation.consumption) {
      landedConsumed.push({
        batchId: entry.batchId,
        quantity: entry.quantity,
      });
    }
    for (const [itemId, credit] of valuation.creditByItemId) {
      creditByItemId.set(itemId, credit);
    }

    for (const item of items) {
      const trackingType = item.trackingType;
      const quantity = requestedByItem.get(item.id) ?? 0;

      if (trackingType === "serial") {
        // Phase 5: explicit selection when the caller provides serialIds —
        // every id is re-validated against THIS line, business, receiving
        // location and in-stock state; the frontend is never trusted.
        // Absent → the documented auto-pick fallback (first in-stock
        // serials by id), preserved for compatibility.
        const requestedSerialIds = serialIdsByItem.get(item.id);
        let serialsToMark: { id: number; serialNumber: string }[];
        if (requestedSerialIds) {
          if (new Set(requestedSerialIds).size !== requestedSerialIds.length) {
            throw new BadRequestError(
              `Duplicate serial numbers selected for purchase item ${item.id}.`,
            );
          }
          if (requestedSerialIds.length !== quantity) {
            throw new BadRequestError(
              `The selected serial count (${requestedSerialIds.length}) must match the return quantity (${quantity}) for purchase item ${item.id}.`,
            );
          }
          const eligible = await tx
            .select({ id: serialNumbers.id, serialNumber: serialNumbers.serialNumber })
            .from(serialNumbers)
            .where(
              and(
                eq(serialNumbers.businessId, businessId),
                eq(serialNumbers.purchaseItemId, item.id),
                eq(serialNumbers.status, "in_stock"),
                ...(locationId !== null
                  ? [eq(serialNumbers.locationId, locationId)]
                  : []),
                inArray(serialNumbers.id, requestedSerialIds),
              ),
            )
            .for("update");
          if (eligible.length !== requestedSerialIds.length) {
            throw new BadRequestError(
              `One or more selected serial numbers are not eligible for return on purchase item ${item.id}.`,
            );
          }
          serialsToMark = eligible;
        } else {
          serialsToMark = await tx
            .select({ id: serialNumbers.id, serialNumber: serialNumbers.serialNumber })
            .from(serialNumbers)
            .where(
              and(
                eq(serialNumbers.purchaseItemId, item.id),
                eq(serialNumbers.businessId, businessId),
                eq(serialNumbers.status, "in_stock"),
              ),
            )
            .orderBy(serialNumbers.id)
            .limit(quantity)
            .for("update");

          if (serialsToMark.length < quantity) {
            throw new BadRequestError(
              `Insufficient in-stock serial numbers for purchase item ${item.id}.`,
            );
          }
        }

        if (serialsToMark.length > 0) {
          await markSerialsReturned(tx, {
            businessId,
            serialIds: serialsToMark.map((serial) => serial.id),
          });
          for (const serial of serialsToMark) {
            returnedSerials.push(serial.serialNumber);
          }
        }
      }
    }

    totalAmount = Number(
      [...creditByItemId.values()].reduce((sum, credit) => sum + credit, 0).toFixed(2),
    );
    const [purchaseReturn] = await tx
      .insert(purchaseReturns)
      .values({
        businessId,
        purchaseId: orderId,
        supplierId: purchase.supplierId,
        reason: reason?.trim() || null,
        status: "completed",
        totalAmount,
      })
      .returning({ id: purchaseReturns.id });

    if (!purchaseReturn) {
      throw new Error("Failed to create purchase return.");
    }

    await tx.insert(purchaseReturnItems).values(
      items.map((item) => {
        const quantity = requestedByItem.get(item.id) ?? 0;
        // Average per-unit credit across the batches this line's units came
        // from (the return's total_amount is the authoritative figure).
        const lineCredit = creditByItemId.get(item.id) ?? 0;
        const unitPrice = quantity > 0 ? lineCredit / quantity : 0;
        return {
          businessId,
          purchaseReturnId: purchaseReturn.id,
          purchaseItemId: item.id,
          productId: item.productId,
          quantity,
          unitPrice: Math.max(0, Number(unitPrice.toFixed(2))),
        };
      }),
    );

    for (const [variantId, quantity] of requestedByVariant) {
      // Conditional decrement — the last-line guard against concurrent
      // races (the row-locked read above already checked availability).
      const decremented = await decrementStockGuarded(tx, {
        businessId,
        locationId,
        variantId,
        quantity,
      });
      assertStockDecremented(decremented, variantId);

      await recordStockMovement(tx, {
        businessId,
        variantId,
        locationId,
        movementType: "adjustment",
        referenceType: "purchase_return",
        referenceId: purchaseReturn.id,
        quantity: -quantity,
      });
    }

    await tx.insert(supplierLedger).values({
      businessId,
      supplierId: purchase.supplierId,
      transactionType: "PURCHASE_RETURN",
      referenceId: purchaseReturn.id,
      credit: totalAmount,
      note: reason?.trim() || `Purchase return #${purchaseReturn.id}`,
    });

    // Landed-cost reversal (Part F): returned units take their allocated
    // landed cost out of inventory — traceable, never silent. The reversal
    // info rides back to the client for the adjustment notice.
    const landedCost = await reverseForPurchaseReturnInTx(
      tx,
      businessId,
      purchase.id,
      purchaseReturn.id,
      landedConsumed,
      actorUserId ?? 0,
    );

    const updatedDueAmount = Math.max(
      0,
      Number(purchase.dueAmount) - totalAmount,
    );
    await tx
      .update(purchases)
      .set({
        dueAmount: updatedDueAmount,
        paymentStatus:
          updatedDueAmount === 0
            ? "paid"
            : Number(purchase.paidAmount) > 0
              ? "partial"
              : "unpaid",
        updatedAt: new Date(),
      })
      .where(
        and(eq(purchases.id, orderId), eq(purchases.businessId, businessId)),
      );

    // Phase 3 — supplier credit visibility: the credit split, computed from
    // the same figures that wrote the ledger and the payable. A credit
    // beyond the outstanding due is a SUPPLIER CREDIT BALANCE (the supplier
    // owes the business), never a cash refund — the system does not record
    // cash refunds; application to future purchases is not supported yet.
    const outstandingBefore = Math.max(0, Number(purchase.dueAmount));
    return {
      success: true,
      message: "Purchase return processed successfully.",
      data: {
        purchaseReturnId: purchaseReturn.id,
        totalAmount,
        // Authoritative landed-cost reversal feedback for the frontend.
        landedCost,
        supplierBalance: {
          outstandingBefore,
          goodsCredit: totalAmount,
          outstandingAfter: updatedDueAmount,
          supplierCreditCreated: Math.max(
            0,
            totalAmount - outstandingBefore,
          ),
        },
        returnedSerials,
      },
    };
  });
}

/**
 * Phase 5: the in-stock serial numbers eligible for return, per
 * serial-tracked line of ONE purchase. The committing return re-validates
 * every selection transactionally (line ownership, business, receiving
 * location, in-stock state) — this listing is for the picker UI.
 */
export async function getReturnableSerials(businessId: number, purchaseId: number) {
  const [purchase] = await db
    .select({ id: purchases.id, locationId: purchases.locationId })
    .from(purchases)
    .where(and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)))
    .limit(1);
  if (!purchase) {
    throw new NotFoundError("Purchase order not found.");
  }

  const itemRows = await db
    .select({
      id: purchaseItems.id,
      trackingType: products.trackingType,
    })
    .from(purchaseItems)
    .innerJoin(productVariants, eq(purchaseItems.variantId, productVariants.id))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(purchaseItems.purchaseId, purchaseId),
        eq(purchaseItems.businessId, businessId),
      ),
    );
  const serialItemRows = itemRows.filter(
    (item) => item.trackingType === "serial",
  );
  const serialItemIds = serialItemRows.map((item) => item.id);

  const serialRows = serialItemIds.length
    ? await db
        .select({
          purchaseItemId: serialNumbers.purchaseItemId,
          id: serialNumbers.id,
          serialNumber: serialNumbers.serialNumber,
        })
        .from(serialNumbers)
        .where(
          and(
            eq(serialNumbers.businessId, businessId),
            inArray(serialNumbers.purchaseItemId, serialItemIds),
            eq(serialNumbers.status, "in_stock"),
            // Serials were created at the receiving location — belt and
            // braces against legacy rows from another outlet.
            ...(purchase.locationId !== null
              ? [eq(serialNumbers.locationId, purchase.locationId)]
              : []),
          ),
        )
        .orderBy(serialNumbers.purchaseItemId, serialNumbers.id)
    : [];

  const byItem = new Map<number, { id: number; serialNumber: string }[]>();
  for (const row of serialRows) {
    const itemId = row.purchaseItemId as number;
    const list = byItem.get(itemId) ?? [];
    list.push({ id: row.id, serialNumber: row.serialNumber });
    byItem.set(itemId, list);
  }

  return {
    success: true,
    data: {
      purchaseId,
      items: serialItemRows.map((item) => ({
        purchaseItemId: item.id,
        serials: byItem.get(item.id) ?? [],
      })),
    },
  };
}

export async function getPurchaseReturnItems(businessId: number) {
  const rows = await db
    .select({
      purchaseItemId: purchaseReturnItems.purchaseItemId,
      variantId: purchaseItems.variantId,
      productId: products.id,
      productName: products.name,
      variantSku: productVariants.sku,
      returnQuantity: sql<number>`COALESCE(SUM(${purchaseReturnItems.quantity}), 0)`,
    })
    .from(purchaseReturnItems)
    .innerJoin(
      purchaseItems,
      eq(purchaseItems.id, purchaseReturnItems.purchaseItemId),
    )
    .innerJoin(
      productVariants,
      eq(productVariants.id, purchaseItems.variantId),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(purchaseReturnItems.businessId, businessId))
    .groupBy(
      purchaseReturnItems.purchaseItemId,
      purchaseItems.variantId,
      products.id,
      products.name,
      productVariants.sku,
    );

  // Option labels batched per distinct variant (a join would fan out rows).
  const variantIds = [...new Set(rows.map((row) => row.variantId))];
  let optionsByVariant = new Map<number, string[]>();
  if (variantIds.length > 0) {
    const optRows = await db
      .select({
        variantId: variantValues.variantId,
        value: variantOptions.value,
      })
      .from(variantValues)
      .innerJoin(variantOptions, eq(variantValues.optionId, variantOptions.id))
      .where(inArray(variantValues.variantId, variantIds))
      .orderBy(asc(variantValues.optionId));
    optionsByVariant = foldVariantOptionRows(optRows);
  }

  return rows.map((row) => ({
    ...row,
    variantOptions: variantOptionsFromMap(optionsByVariant, row.variantId),
    variantName: variantNameFromMap(optionsByVariant, row.variantId, row.productName),
  }));
}
