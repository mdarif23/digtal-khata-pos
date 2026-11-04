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
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { purchaseItems } from "../../db/schema/purchaseItems.js";
import { purchaseReturnItems } from "../../db/schema/purchaseReturnItems.js";
import { purchaseReturns } from "../../db/schema/purchaseReturns.js";
import { purchases } from "../../db/schema/purchases.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import { supplierLedger } from "../../db/schema/supplierLedger.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import type { CreatePurchaseReturnInput } from "./purchaseReturn.schema.js";

// Takes the caller's server-verified businessId (from requireBusinessContext)
// and scopes all reads and writes to it.
export async function createPurchaseReturn(
  businessId: number,
  {
    orderId,
    changedItems,
    reason,
  }: CreatePurchaseReturnInput,
) {
  const purchaseItemIds = changedItems.map((item) => item.purchaseItemId);
  if (new Set(purchaseItemIds).size !== purchaseItemIds.length) {
    throw new BadRequestError("Duplicate purchase items are not allowed.");
  }

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
    if (purchase.supplierId === null) {
      throw new BadRequestError(
        "A supplier must be assigned to process a purchase return.",
      );
    }
    // Returns deduct stock where the purchase was received.
    if (purchase.locationId === null) {
      throw new BadRequestError(
        "This purchase has no receiving location recorded and cannot be returned.",
      );
    }
    const locationId: number = purchase.locationId;

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

    if (items.length !== purchaseItemIds.length) {
      throw new BadRequestError(
        "One or more selected items do not belong to this purchase order.",
      );
    }

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
    const requestedByVariant = new Map<number, number>();

    for (const item of items) {
      const quantity = requestedByItem.get(item.id) ?? 0;
      const remainingReceived =
        Number(item.receivedQuantity) -
        (returnedByItem.get(item.id) ?? 0);

      if (quantity > remainingReceived) {
        throw new BadRequestError(
          `Cannot return ${quantity} of item ${item.id}; only ${Math.max(remainingReceived, 0)} received units remain eligible.`,
        );
      }

      requestedByVariant.set(
        item.variantId,
        (requestedByVariant.get(item.variantId) ?? 0) + quantity,
      );
    }

    for (const [variantId, quantity] of requestedByVariant) {
      const available = stockByVariant.get(variantId);
      if (available === undefined || quantity > available) {
        throw new BadRequestError(
          `Insufficient on-hand stock to return ${quantity} unit(s) of variant ${variantId}.`,
        );
      }
    }

    let totalAmount = 0;
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
    for (const item of items) {
      const quantity = requestedByItem.get(item.id) ?? 0;
      const trackingType = item.trackingType;
      const batches = await tx
        .select({
          id: inventoryBatches.id,
          quantityRemaining: inventoryBatches.quantityRemaining,
        })
        .from(inventoryBatches)
        .where(
          and(
            eq(inventoryBatches.purchaseItemId, item.id),
            eq(inventoryBatches.businessId, businessId),
          ),
        )
        .orderBy(inventoryBatches.id)
        .for("update");

      let remainingToRemove = quantity;
      for (const batch of batches) {
        if (remainingToRemove <= 0) break;
        const removed = Math.min(batch.quantityRemaining, remainingToRemove);
        if (removed <= 0) continue;
        await tx
          .update(inventoryBatches)
          .set({
            quantityRemaining: sql`${inventoryBatches.quantityRemaining} - ${removed}`,
          })
          .where(
            and(
              eq(inventoryBatches.id, batch.id),
              eq(inventoryBatches.businessId, businessId),
            ),
          );
        remainingToRemove -= removed;
      }

      if (remainingToRemove > 0 && trackingType !== "none") {
        throw new BadRequestError(
          `Insufficient available batch quantity for purchase item ${item.id}.`,
        );
      }

      if (trackingType === "serial") {
        const availableSerials = await tx
          .select({ id: serialNumbers.id })
          .from(serialNumbers)
          .where(
            and(
              eq(serialNumbers.purchaseItemId, item.id),
              eq(serialNumbers.businessId, businessId),
              eq(serialNumbers.status, "in_stock"),
            ),
          )
          .limit(quantity)
          .for("update");

        if (availableSerials.length < quantity) {
          throw new BadRequestError(
            `Insufficient in-stock serial numbers for purchase item ${item.id}.`,
          );
        }

        if (availableSerials.length > 0) {
          await tx
            .update(serialNumbers)
            .set({ status: "returned" })
            .where(
              inArray(
                serialNumbers.id,
                availableSerials.map((serial) => serial.id),
              ),
            );
        }
      }

      totalAmount += quantity * getReturnUnitPrice(item);
    }

    totalAmount = Number(totalAmount.toFixed(2));
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
        const unitPrice = getReturnUnitPrice(item);
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
      const [updatedStock] = await tx
        .update(inventoryStock)
        .set({
          quantity: sql`${inventoryStock.quantity} - ${quantity}`,
        })
        .where(
          and(
            eq(inventoryStock.variantId, variantId),
            eq(inventoryStock.businessId, businessId),
            eq(inventoryStock.locationId, locationId),
            sql`${inventoryStock.quantity} >= ${quantity}`,
          ),
        )
        .returning({ variantId: inventoryStock.variantId });

      if (!updatedStock) {
        throw new BadRequestError(
          `Stock changed while processing the return for variant ${variantId}. Please retry.`,
        );
      }

      await tx.insert(inventoryMovements).values({
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

    return {
      success: true,
      message: "Purchase return processed successfully.",
      data: {
        purchaseReturnId: purchaseReturn.id,
        totalAmount,
      },
    };
  });
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
