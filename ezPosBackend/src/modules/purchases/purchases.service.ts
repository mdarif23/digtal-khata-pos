import { db } from "../../db/schema/index.js";
import { purchaseItems } from "../../db/schema/purchaseItems.js";
import { purchases } from "../../db/schema/purchases.js";
import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import { products } from "../../db/schema/products.js";
import {
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import type { CreatePurchaseInput } from "./schemas/purchase.schema.js";
import { suppliers } from "../../db/schema/suppliers.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { units } from "../../db/schema/units.js";
import type { ReceiveItemsFormValues } from "./schemas/receiveItem.schema.js";
import { checkPriceIncreasesInTx } from "../procurement/priceAlerts.service.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import {
  basicRequestValidation,
  batchValidation,
  purchaseItemsValidation,
  purchaseValidation,
  receiveItemsValidation,
  serialNumberValidation,
} from "./receive/receive.validation.js";
import {
  calculatePayments,
  calculatePaymentStatus,
  calculatePurchaseStatus,
  getAllPurchaseItems,
  insertInventoryBatches,
  insertInventoryMovements,
  insertInventoryStockOnConflictDoUpdate,
  insertPurchasePayments,
  insertSerialNumbers,
  updateProductVariants,
  updatePurchase,
  updatePurchaseItems,
} from "./receive/receive.service.js";
import {
  formatPurchaseOrderNumber,
  nextDocumentNumber,
} from "../../utils/documentSequence.js";

// Every function takes the caller's server-verified businessId (from
// requireBusinessContext) and scopes all reads and writes to it.

export async function createPurchase(
  businessId: number,
  data: CreatePurchaseInput,
) {
  return db.transaction(async (tx) => {
    const {
      supplierId,
      items,
      purchaseDate,
      notes,
      discount,
      tax,
      shippingCost,
    } = data;

    // 1. Validate Supplier (same business only)
    if (supplierId) {
      const supplier = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(
          and(
            eq(suppliers.id, supplierId),
            eq(suppliers.businessId, businessId),
          ),
        );
      if (supplier.length === 0) {
        throw new NotFoundError("Supplier not found");
      }
    }

    // 2. Validate Variants (same business only)
    const variantIds = [...new Set(items.map((item) => item.variantId))];
    const existingVariants = await tx
      .select({ id: productVariants.id, status: productVariants.status })
      .from(productVariants)
      .where(
        and(
          inArray(productVariants.id, variantIds),
          eq(productVariants.businessId, businessId),
        ),
      );

    if (existingVariants.length !== variantIds.length) {
      const foundIds = existingVariants.map((v) => v.id);
      const missingIds = variantIds.filter((id) => !foundIds.includes(id));
      throw new NotFoundError(
        `These variant IDs do not exist: ${missingIds.join(", ")}`,
      );
    }

    // Check for inactive variants
    for (const variant of existingVariants) {
      if (variant.status !== "active") {
        throw new NotFoundError(`Variant ${variant.id} is inactive`);
      }
    }

    // 3. Calculate totals
    const subtotal = Number(
      items
        .reduce(
          (sum, item) =>
            sum +
            Number(
              (
                item.purchasePrice * item.quantity -
                item.discount +
                item.tax
              ).toFixed(2),
            ),
          0,
        )
        .toFixed(2),
    );
    const totalAmount = Number(
      (subtotal - discount + tax + shippingCost).toFixed(2),
    );

    // 4. Per-business PO number. The number comes from the business's own
    // document_sequences counter inside this transaction (rollback-safe);
    // the year in the prefix is the document's issue year.
    const number = await nextDocumentNumber(tx, businessId, "purchase_order");
    const purchaseOrderNumber = formatPurchaseOrderNumber(
      new Date(purchaseDate).getFullYear(),
      number,
    );

    // 5. Create Purchase
    const [newPurchase] = await tx
      .insert(purchases)
      .values({
        businessId,
        supplierId,
        purchaseOrderNumber,
        purchaseDate,
        notes,
        subtotal,
        discount: String(discount),
        tax: String(tax),
        shippingCost: String(shippingCost),
        totalAmount,
        dueAmount: totalAmount,
      })
      .returning();

    if (!newPurchase) {
      throw new Error("Failed to create purchase record");
    }

    // 6. Create Purchase Items (BULK INSERT)
    const itemsToInsert = items.map((item) => ({
      businessId,
      purchaseId: newPurchase.id,
      variantId: item.variantId,
      quantity: item.quantity,
      receivedQuantity: 0,
      unitCost: item.purchasePrice,
      discount: item.discount,
      tax: item.tax,
    }));

    // Insert them all in ONE single database query!
    await tx.insert(purchaseItems).values(itemsToInsert);

    // 7. Return the new purchase so the frontend can use it. The id was
    // added in Phase 5 (Smart Procurement draft creation navigates to the
    // created PO); consumers reading purchaseOrderNumber are unaffected.
    return {
      id: newPurchase.id,
      purchaseOrderNumber: newPurchase.purchaseOrderNumber,
    };
  });
}
export async function getPurchasesSummary(businessId: number) {
  const [
    orderedPurchase,
    allPurchases,
    partiallyPaidPurchase,
    completedPurchase,
  ] = await Promise.all([
    db
      .select({ ...getTableColumns(purchases), supplierName: suppliers.name })
      .from(purchases)
      .leftJoin(suppliers, eq(purchases.supplierId, suppliers.id))
      .where(
        and(
          eq(purchases.status, "ordered"),
          eq(purchases.businessId, businessId),
        ),
      ),
    db
      .select({ ...getTableColumns(purchases), supplierName: suppliers.name })
      .from(purchases)
      .leftJoin(suppliers, eq(purchases.supplierId, suppliers.id))
      .where(eq(purchases.businessId, businessId)),
    db
      .select({ ...getTableColumns(purchases), supplierName: suppliers.name })
      .from(purchases)
      .leftJoin(suppliers, eq(purchases.supplierId, suppliers.id))
      .where(
        and(
          inArray(purchases.paymentStatus, ["partial", "unpaid"]),
          eq(purchases.businessId, businessId),
        ),
      ),
    db
      .select({ ...getTableColumns(purchases), supplierName: suppliers.name })
      .from(purchases)
      .leftJoin(suppliers, eq(purchases.supplierId, suppliers.id))
      .where(
        and(
          inArray(purchases.paymentStatus, ["paid"]),
          eq(purchases.businessId, businessId),
        ),
      ),
  ]);
  return {
    orderedPurchase,
    allPurchases,
    partiallyPaidPurchase,
    completedPurchase,
  };
}
export async function getPurchasesItems(
  businessId: number,
  locationId: number,
) {
  return (
    db
      .select({
        // 1. Spread the table to get all its columns
        ...getTableColumns(purchaseItems),

        // 2. Select specific related columns
        productName: products.name,
        productUnit: units.name,
        sellingPrice: productVariants.sellingPrice,
        productId: products.id,
        trackingType: products.trackingType,
        availableStock: inventoryStock.quantity,
      })
      .from(purchaseItems)
      // 3. Join Variant (Purchase Items link to Variants, not directly to Products!)
      .innerJoin(
        productVariants,
        eq(purchaseItems.variantId, productVariants.id),
      )
      // 4. Join Product (Variants link to Products)
      .innerJoin(products, eq(productVariants.productId, products.id))
      // 5. Join Unit (Products link to Units)
      .leftJoin(units, eq(units.id, products.unitId))
      .leftJoin(
        inventoryStock,
        and(
          eq(inventoryStock.variantId, productVariants.id),
          eq(inventoryStock.businessId, businessId),
          eq(inventoryStock.locationId, locationId),
        ),
      )
      .where(eq(purchaseItems.businessId, businessId))
  ); // leftJoin is safer in case a product has no unit
}

export async function createReceivePurchase(
  businessId: number,
  locationId: number,
  data: ReceiveItemsFormValues,
) {
  const { purchaseId, items, paymentAmount, paymentMethod, paymentNotes } =
    data;

  return db.transaction(async (tx) => {
    const itemIds = basicRequestValidation(items);
    const purchase = await purchaseValidation(tx, businessId, purchaseId);

    // Stamp the receiving location on the purchase header (first receive
    // wins; later partial receives must go to the same location).
    if (purchase.locationId === null) {
      await tx
        .update(purchases)
        .set({ locationId })
        .where(and(eq(purchases.id, purchaseId), eq(purchases.businessId, businessId)));
    } else if (purchase.locationId !== locationId) {
      throw new ConflictError(
        "This purchase is already being received at another location.",
      );
    }

    const existingItems = await purchaseItemsValidation(
      tx,
      businessId,
      purchaseId,
      itemIds,
    );

    const receiveItemMap = new Map(items.map((item) => [item.itemId, item]));

    for (const purchaseItem of existingItems) {
      const receiveItem = receiveItemMap.get(purchaseItem.id);
      if (!receiveItem) {
        throw new NotFoundError(
          `Missing receiving information for purchase item ${purchaseItem.id}.`,
        );
      }
      await receiveItemsValidation(purchaseItem, receiveItem);

      if (receiveItem.receiveNow > 0 && receiveItem.trackingType === "batch") {
        batchValidation(purchaseItem, receiveItem);
      }

      if (receiveItem.receiveNow > 0 && receiveItem.trackingType === "serial") {
        serialNumberValidation(purchaseItem, receiveItem);
      }
    }

    for (const purchaseItem of existingItems) {
      const receiveItem = receiveItemMap.get(purchaseItem.id)!;

      if (receiveItem.receiveNow <= 0) {
        continue;
      }

      const newReceivedQuantity =
        purchaseItem.receivedQuantity + receiveItem.receiveNow;

      await updatePurchaseItems(
        tx,
        businessId,
        purchaseItem.id,
        newReceivedQuantity,
        receiveItem.unitCost,
      );
      await updateProductVariants(
        tx,
        businessId,
        receiveItem.sellingPrice,
        purchaseItem.variantId,
      );

      await insertInventoryStockOnConflictDoUpdate(
        tx,
        businessId,
        locationId,
        purchaseItem.variantId,
        receiveItem.receiveNow,
      );

      await insertInventoryMovements(
        tx,
        businessId,
        locationId,
        purchaseItem.variantId,
        purchaseId,
        receiveItem.receiveNow,
      );

      const insertedBatches = await insertInventoryBatches(
        tx,
        businessId,
        locationId,
        receiveItem,
        purchaseItem.variantId,
        purchaseItem.id,
      );

      if (receiveItem.trackingType === "serial") {
        const firstBatch = insertedBatches[0];

        if (!firstBatch) {
          throw new Error(
            `No inventory batch was created for purchase item ${purchaseItem.id}.`,
          );
        }

        await insertSerialNumbers(
          tx,
          businessId,
          locationId,
          receiveItem,
          purchaseItem.variantId,
          purchaseItem.id,
          firstBatch.id,
        );
      }
    }

    const allPurchaseItems = await getAllPurchaseItems(
      tx,
      businessId,
      purchaseId,
    );

    const newStatus = calculatePurchaseStatus(allPurchaseItems);

    const {
      updatedPaidAmount,
      receivedAmount,
      updatedDueAmount,
      newPaymentAmount,
    } = calculatePayments(
      allPurchaseItems,
      purchase.paidAmount,
      paymentAmount,
      purchase.totalAmount,
    );

    const paymentStatus = calculatePaymentStatus(
      updatedPaidAmount,
      purchase.totalAmount,
      receivedAmount,
    );

    // =========================================================
    // 13. UPDATE PURCHASE
    // =========================================================

    await updatePurchase(
      tx,
      newStatus,
      updatedPaidAmount,
      updatedDueAmount,
      paymentStatus,
      businessId,
      purchaseId,
    );

    // =========================================================
    // 14. PAYMENT RECORD
    // =========================================================

    if (newPaymentAmount > 0) {
      await insertPurchasePayments(
        tx,
        businessId,
        purchaseId,
        paymentMethod,
        newPaymentAmount,
        paymentNotes,
      );
    }

    // =========================================================
    // 15. PRICE-INCREASE ALERTS (Smart Procurement)
    // Factual supplier price monitoring: compares each received line's
    // actual unit cost against this supplier's previous actual price for
    // the variant; records a deduplicated notification when the business's
    // configured threshold is met. Runs inside this transaction but never
    // blocks a legitimate receive.
    // =========================================================

    try {
      await checkPriceIncreasesInTx(tx, {
        businessId,
        purchaseId,
        supplierId: purchase.supplierId,
        items: items.map((receiveItem) => ({
          variantId:
            existingItems.find((pi) => pi.id === receiveItem.itemId)?.variantId ?? 0,
          unitCost: receiveItem.unitCost,
          receiveNow: receiveItem.receiveNow,
        })),
      });
    } catch (alertError) {
      console.error("Price-increase alert check failed:", alertError);
    }

    // =========================================================
    // 15. RETURN
    // =========================================================

    return {
      success: true,
      purchaseId,
      status: newStatus,
      receivedAmount,
      paidAmount: updatedPaidAmount,
      dueAmount: updatedDueAmount,
      message:
        newStatus === "received"
          ? "Purchase completely received."
          : "Purchase partially received.",
    };
  });
}
