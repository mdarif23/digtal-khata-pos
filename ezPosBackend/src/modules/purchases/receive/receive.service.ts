import { purchaseItems } from "../../../db/schema/purchaseItems.js";
import { and, eq, sql } from "drizzle-orm";
import type { DbTransaction } from "../purchase.types.js";
import { inventoryBatches } from "../../../db/schema/inventoryBatches.js";
import type { Items } from "./receive.types.js";
import { serialNumbers } from "../../../db/schema/serialNumbers.js";
import { purchases } from "../../../db/schema/purchases.js";
import { purchasePayments } from "../../../db/schema/purchasePayments.js";
import { productVariants } from "../../../db/schema/productVariants.js";
import { receivedAmountFromBatches } from "./receive.calculations.js";

// Every function takes the caller's server-verified businessId (from
// requireBusinessContext) and scopes all reads and writes to it.
// Pure calculations live in receive.calculations.ts; inventory writes
// (stock/movements) live in modules/inventory — this file keeps the
// receive-specific writers (batches, serials) and purchase persistence.

export async function updatePurchaseItems(
  tx: DbTransaction,
  businessId: number,
  purchaseItemId: number,
  newReceivedQuantity: number,
) {
  // D1 (batch-authoritative): the line's unit_cost stays the PO order cost.
  // The cost entered at each receive session is persisted on that session's
  // inventory_batches rows (purchase_price), never overwritten here.
  await tx
    .update(purchaseItems)
    .set({
      receivedQuantity: newReceivedQuantity,
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

/**
 * Value of goods received, batch-authoritative (D1): Σ quantity_received ×
 * purchase_price over this purchase's batches. Legacy fallback (received
 * units with no batch rows at all) uses the line costs — see
 * receivedAmountFromBatches in receive.calculations.ts.
 */
export async function getPurchaseReceivedAmountInTx(
  tx: DbTransaction,
  businessId: number,
  purchaseId: number,
): Promise<number> {
  const [batchTotal] = await tx
    .select({
      total: sql<string>`COALESCE(SUM(${inventoryBatches.quantityReceived} * ${inventoryBatches.purchasePrice}), 0)`,
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
        eq(purchaseItems.purchaseId, purchaseId),
        eq(purchaseItems.businessId, businessId),
      ),
    );

  const lineItems = await getAllPurchaseItems(tx, businessId, purchaseId);

  return receivedAmountFromBatches(Number(batchTotal?.total ?? 0), lineItems);
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
