import { purchaseItems } from "../../../db/schema/purchaseItems.js";
import { and, eq, sql } from "drizzle-orm";
import type { DbTransaction } from "../purchase.types.js";
import { inventoryStock } from "../../../db/schema/inventoryStock.js";
import { inventoryMovements } from "../../../db/schema/inventoryMovements.js";
import { inventoryBatches } from "../../../db/schema/inventoryBatches.js";
import type { Items } from "./receive.types.js";
import { serialNumbers } from "../../../db/schema/serialNumbers.js";
import { NotFoundError } from "../../../utils/handleError.js";
import { purchases } from "../../../db/schema/purchases.js";
import { purchasePayments } from "../../../db/schema/purchasePayments.js";
import { productVariants } from "../../../db/schema/productVariants.js";

// Every function takes the caller's server-verified businessId (from
// requireBusinessContext) and scopes all reads and writes to it.

export async function updatePurchaseItems(
  tx: DbTransaction,
  businessId: number,
  purchaseItemId: number,
  newReceivedQuantity: number,
  unitCost: number,
) {
  await tx
    .update(purchaseItems)
    .set({
      receivedQuantity: newReceivedQuantity,
      unitCost,
    })
    .where(
      and(
        eq(purchaseItems.id, purchaseItemId),
        eq(purchaseItems.businessId, businessId),
      ),
    );
}
export async function updateProductVariants(
  tx: DbTransaction,
  businessId: number,
  sellingPrice: number,
  variantId: number,
) {
  await tx
    .update(productVariants)
    .set({
      sellingPrice,
    })
    .where(
      and(
        eq(productVariants.id, variantId),
        eq(productVariants.businessId, businessId),
      ),
    );
}
export async function insertInventoryStockOnConflictDoUpdate(
  tx: DbTransaction,
  businessId: number,
  locationId: number,
  variantId: number,
  receiveNow: number,
) {
  // One stock row per (business, variant, location): receiving into one
  // store never touches another store's stock.
  await tx
    .insert(inventoryStock)
    .values({
      businessId,
      locationId,
      variantId,
      quantity: receiveNow,
    })
    .onConflictDoUpdate({
      target: [
        inventoryStock.businessId,
        inventoryStock.variantId,
        inventoryStock.locationId,
      ],
      set: {
        quantity: sql`
              ${inventoryStock.quantity}
              + ${receiveNow}
            `,
      },
    });
}
export async function insertInventoryMovements(
  tx: DbTransaction,
  businessId: number,
  locationId: number,
  variantId: number,
  purchaseId: number,
  receiveNow: number,
) {
  await tx.insert(inventoryMovements).values({
    businessId,
    variantId,
    locationId,
    movementType: "purchase",
    referenceType: "purchase",
    referenceId: purchaseId,
    quantity: receiveNow,
  });
}
export async function insertInventoryBatches(
  tx: DbTransaction,
  businessId: number,
  locationId: number,
  receiveItem: Items,
  variantId: number,
  purchaseItemId: number,
) {
  let rows;

  if (receiveItem.trackingType === "batch") {
    rows = (receiveItem.batches ?? []).map((batch) => ({
      businessId,
      locationId,
      variantId,
      purchaseItemId,
      batchNumber: batch.batchNumber,
      purchasePrice: receiveItem.unitCost,
      quantityReceived: batch.quantity,
      quantityRemaining: batch.quantity,
      manufacturedDate: batch.manufacturedDate,
      expiryDate: batch.expiryDate,
    }));
  } else {
    // serial or no tracking: one automatic batch for this receive
    const quantity =
      receiveItem.trackingType === "serial"
        ? (receiveItem.serialNumbers ?? []).length
        : receiveItem.receiveNow;

    rows =
      quantity > 0
        ? [
            {
              businessId,
              locationId,
              variantId,
              purchaseItemId,
              batchNumber: `AUTO-${purchaseItemId}-${Date.now()}`, // batchNumber is notNull
              purchasePrice: receiveItem.unitCost,
              quantityReceived: quantity,
              quantityRemaining: quantity,
            },
          ]
        : [];
  }

  if (rows.length === 0) return [];

  // One insert per row: multi-row drizzle inserts emit the table's full
  // column list (with `default` placeholders), which would break against a
  // database that has not had the landed-cost columns (migration 0042)
  // applied yet. Single-row inserts only name the provided columns.
  const inserted: { id: number }[] = [];
  for (const row of rows) {
    const [batch] = await tx
      .insert(inventoryBatches)
      .values(row)
      .returning({ id: inventoryBatches.id });
    inserted.push(batch!);
  }
  return inserted;
}
export async function insertSerialNumbers(
  tx: DbTransaction,
  businessId: number,
  locationId: number,
  receiveItem: Items,
  variantId: number,
  purchaseItemId: number,
  batchId: number,
) {
  const serials = receiveItem.serialNumbers ?? [];

  const serialNumbersToInsert = serials.map((serialNumber) => ({
    businessId,
    locationId,
    variantId,
    purchaseItemId,
    serialNumber,
    batchId
  }));

  await tx.insert(serialNumbers).values(serialNumbersToInsert);
}
export async function getAllPurchaseItems(
  tx: DbTransaction,
  businessId: number,
  purchaseId: number,
) {
  return await tx
    .select({
      quantity: purchaseItems.quantity,
      receivedQuantity: purchaseItems.receivedQuantity,
      unitCost: purchaseItems.unitCost,
    })
    .from(purchaseItems)
    .where(
      and(
        eq(purchaseItems.purchaseId, purchaseId),
        eq(purchaseItems.businessId, businessId),
      ),
    );
}
type AllPurchaseItems = {
  quantity: number;
  receivedQuantity: number;
  unitCost: number;
};
export function calculatePurchaseStatus(allPurchaseItems: AllPurchaseItems[]) {
  const allItemsFullyReceived =
    allPurchaseItems.length > 0 &&
    allPurchaseItems.every((item) => item.receivedQuantity >= item.quantity);

  return allItemsFullyReceived ? "received" : "partially_received";
}

export function calculatePayments(
  allPurchaseItems: AllPurchaseItems[],
  paidAmount: number,
  paymentAmount: number,
  totalAmount: number,
) {
  const receivedAmount = allPurchaseItems.reduce(
    (sum, item) => sum + Number(item.receivedQuantity) * Number(item.unitCost),
    0,
  );

  const currentPaidAmount = Number(paidAmount ?? 0);

  const newPaymentAmount = Number(paymentAmount ?? 0);
  const paymentLimit = Math.max(
    0,
    Math.min(
      receivedAmount - currentPaidAmount,
      Number(totalAmount ?? receivedAmount) - currentPaidAmount,
    ),
  );

  if (newPaymentAmount < 0) {
    throw new NotFoundError("Payment amount cannot be negative.");
  }

  if (newPaymentAmount > paymentLimit) {
    throw new NotFoundError(
      `Payment cannot be greater than the available received balance (${paymentLimit.toFixed(2)}).`,
    );
  }

  const updatedPaidAmount = currentPaidAmount + newPaymentAmount;

  const updatedDueAmount = Math.max(
    0,
    Number(totalAmount ?? receivedAmount) - updatedPaidAmount,
  );
  return {
    updatedPaidAmount,
    receivedAmount,
    updatedDueAmount,
    newPaymentAmount,
  };
}
export function calculatePaymentStatus(
  updatedPaidAmount: number,
  totalAmount: number,
  receivedAmount: number,
) {
  let paymentStatus: "unpaid" | "partial" | "paid";

  if (updatedPaidAmount <= 0) {
    paymentStatus = "unpaid";
  } else if (updatedPaidAmount < Number(totalAmount ?? receivedAmount)) {
    paymentStatus = "partial";
  } else {
    paymentStatus = "paid";
  }
  return paymentStatus;
}
export async function updatePurchase(
  tx: DbTransaction,
  newStatus: "received" | "partially_received",
  updatedPaidAmount: number,
  updatedDueAmount: number,
  paymentStatus: "paid" | "unpaid" | "partial",
  businessId: number,
  purchaseId: number,
) {
  await tx
    .update(purchases)
    .set({
      status: newStatus,

      paidAmount: updatedPaidAmount,
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
}
export async function insertPurchasePayments(
  tx: DbTransaction,
  businessId: number,
  purchaseId: number,
  paymentMethod: "cash" | "bank_transfer" | "cheque" | "card" | "other",
  newPaymentAmount: number,
  paymentNotes: string | undefined,
) {
  await tx.insert(purchasePayments).values({
    businessId,
    purchaseId,
    method: paymentMethod,
    amount: newPaymentAmount,
    notes: paymentNotes,
    paymentDate: new Date(),
  });
}
