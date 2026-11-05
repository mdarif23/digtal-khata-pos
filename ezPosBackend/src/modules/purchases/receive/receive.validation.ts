import {
  and,
  eq,
  inArray,
  type ExtractTablesWithRelations,
} from "drizzle-orm";
import { purchases } from "../../../db/schema/purchases.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../utils/handleError.js";
import type { Items, PurchaseItem } from "./receive.types.js";
import type { PgTransaction } from "drizzle-orm/pg-core/session";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres/session";
import { purchaseItems } from "../../../db/schema/purchaseItems.js";
import { serialNumbers } from "../../../db/schema/serialNumbers.js";

type Tx = PgTransaction<
  NodePgQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

// BASIC REQUEST VALIDATION
// Business-rule violations are 400s (BadRequestError), not 404s: the request
// reached the right resource — its content is wrong.
export function basicRequestValidation(items: Items[]) {
  if (items.length === 0) {
    throw new BadRequestError("At least one purchase item is required.");
  }

  // Prevent duplicate item IDs in the request
  const itemIds = items.map((item) => item.itemId);
  const uniqueItemIds = new Set(itemIds);

  if (uniqueItemIds.size !== itemIds.length) {
    throw new BadRequestError("Duplicate purchase item IDs are not allowed.");
  }
  return itemIds;
}
//purchase Validation
export async function purchaseValidation(tx: Tx, businessId: number, purchaseId: number) {
  const [purchase] = await tx
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.id, purchaseId),
        eq(purchases.businessId, businessId),
      ),
    )
    .for("update");

  if (!purchase) {
    throw new NotFoundError("Purchase order not found.");
  }

  if (purchase.status === "received") {
    throw new ConflictError(
      "This purchase has already been completely received.",
    );
  }
  return purchase;
}
//purchase items validation
export async function purchaseItemsValidation(
  tx: Tx,
  businessId: number,
  purchaseId: number,
  itemIds: number[],
) {
  const existingItems = await tx
    .select()
    .from(purchaseItems)
    .where(
      and(
        eq(purchaseItems.purchaseId, purchaseId),
        eq(purchaseItems.businessId, businessId),
        inArray(purchaseItems.id, itemIds),
      ),
    )
    .for("update");

  if (existingItems.length !== itemIds.length) {
    const foundIds = new Set(existingItems.map((item) => item.id));

    const missingIds = itemIds.filter((id) => !foundIds.has(id));

    throw new BadRequestError(
      `These purchase items do not belong to this purchase: ${missingIds.join(
        ", ",
      )}`,
    );
  }
  return existingItems;
}
//receiveItemsValidation
export async function receiveItemsValidation(
  purchaseItem: PurchaseItem,
  receiveItem: Items,
) {
  // -------------------------------------------------------
  // Receive quantity
  // -------------------------------------------------------

  if (receiveItem.receiveNow <= 0) {
    return; // Skip items with zero or negative receiveNow
  }

  const remainingQuantity =
    purchaseItem.quantity - purchaseItem.receivedQuantity;

  // Strict receiving:
  // Do not allow receiving more than ordered.
  if (receiveItem.receiveNow > remainingQuantity) {
    throw new BadRequestError(
      `Cannot receive ${receiveItem.receiveNow} for item ${purchaseItem.id}. ` +
        `Only ${remainingQuantity} remaining.`,
    );
  }
}
//batchValidation
export function batchValidation(purchaseItem: PurchaseItem, receiveItem: Items) {
  const batches = receiveItem.batches ?? [];
  if (batches.length === 0) {
    throw new BadRequestError(
      `Batch information is required for item ${purchaseItem.id}.`,
    );
  }

  const batchQuantity = batches.reduce((sum, batch) => sum + batch.quantity, 0);

  if (batchQuantity !== receiveItem.receiveNow) {
    throw new BadRequestError(
      `Batch quantity (${batchQuantity}) must equal ` +
        `receive quantity (${receiveItem.receiveNow}) ` +
        `for item ${purchaseItem.id}.`,
    );
  }

  // Duplicate batch numbers within one receive would silently create two
  // same-named batch rows for the variant. (The same batch number arriving
  // on a DIFFERENT purchase order remains legitimate and is allowed.)
  const batchNumbers = batches.map((batch) => batch.batchNumber.trim());
  if (new Set(batchNumbers).size !== batchNumbers.length) {
    throw new BadRequestError(
      `Duplicate batch numbers are not allowed within a single receive for item ${purchaseItem.id}.`,
    );
  }

  // Validate individual batch quantities
  for (const batch of batches) {
    if (batch.quantity <= 0) {
      throw new BadRequestError(`Batch quantity must be greater than zero.`);
    }

    if (!batch.batchNumber.trim()) {
      throw new BadRequestError(`Batch number is required.`);
    }
  }
}
//serialNumberValidation
export function serialNumberValidation(
  purchaseItem: PurchaseItem,
  receiveItem: Items,
) {
  const serials = receiveItem.serialNumbers ?? [];

  if (serials.length !== receiveItem.receiveNow) {
    throw new BadRequestError(
      `Item ${purchaseItem.id} requires ${receiveItem.receiveNow} ` +
        `serial numbers, but ${serials.length} were provided.`,
    );
  }

  const uniqueSerials = new Set(serials);

  if (uniqueSerials.size !== serials.length) {
    throw new BadRequestError(`Duplicate serial numbers are not allowed.`);
  }

  for (const serial of serials) {
    if (!serial.trim()) {
      throw new BadRequestError(`Serial number cannot be empty.`);
    }
  }
}

/**
 * Serials are unique per business (serial_numbers_business_serial_unique).
 * Pre-check BEFORE writing so a duplicate surfaces as a clear 400 instead of
 * a raw constraint violation. Also catches the same serial listed for two
 * different items in one request.
 */
export async function serialAvailabilityValidation(
  tx: Tx,
  businessId: number,
  items: Items[],
) {
  const serialsByValue = new Map<string, number>();
  for (const item of items) {
    if (item.trackingType !== "serial" || item.receiveNow <= 0) continue;
    for (const serial of item.serialNumbers ?? []) {
      const normalized = serial.trim();
      if (serialsByValue.has(normalized)) {
        throw new BadRequestError(
          `Serial number "${normalized}" is listed for more than one item in this receive.`,
        );
      }
      serialsByValue.set(normalized, item.itemId);
    }
  }
  if (serialsByValue.size === 0) return;

  const existing = await tx
    .select({ serialNumber: serialNumbers.serialNumber })
    .from(serialNumbers)
    .where(
      and(
        eq(serialNumbers.businessId, businessId),
        inArray(serialNumbers.serialNumber, [...serialsByValue.keys()]),
      ),
    );

  if (existing.length > 0) {
    const offenders = [...new Set(existing.map((row) => row.serialNumber))]
      .slice(0, 5)
      .join(", ");
    throw new BadRequestError(
      `Serial number(s) already exist in this business: ${offenders}` +
        (existing.length > 5 ? "…" : ""),
    );
  }
}
