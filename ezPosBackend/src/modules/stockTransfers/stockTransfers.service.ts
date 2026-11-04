import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { locations } from "../../db/schema/locations.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { variantOptions } from "../../db/schema/variantOptions.js";
import { variantValues } from "../../db/schema/variantValues.js";
import { stockTransferItems } from "../../db/schema/stockTransfers.js";
import { stockTransfers } from "../../db/schema/stockTransfers.js";
import {
  foldVariantOptionRows,
  variantNameFromMap,
  variantOptionsFromMap,
} from "../../utils/variantDisplay.js";
import { roundMoney } from "../../utils/roundMoney.js";
import { nextDocumentNumber } from "../../utils/documentSequence.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../utils/handleError.js";
import { listAccessibleLocationIds } from "../locations/locations.service.js";
import type {
  CreateTransferInput,
  ReceiveTransferInput,
} from "./stockTransfers.validation.js";

type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface TransferItemView {
  id: number;
  variantId: number;
  sku: string | null;
  productName: string | null;
  variantOptions: string | null;
  variantName: string | null;
  quantity: number;
  quantityShipped: number;
  quantityReceived: number;
  unitCost: number;
}

export interface TransferDetail {
  id: number;
  transferNumber: string;
  fromLocationId: number;
  fromLocationName: string;
  toLocationId: number;
  toLocationName: string;
  status: string;
  notes: string | null;
  shippedAt: Date | null;
  receivedAt: Date | null;
  createdAt: Date | null;
  items: TransferItemView[];
}

/**
 * Server-side location-access check for BOTH transfer endpoints. The caller
 * must be an owner (wildcard) or hold assignments covering the locations
 * they operate on: both endpoints for drafts, the source for shipping, the
 * destination for receiving. Never trusts the frontend's location context.
 */
async function assertCallerAccessesLocations(
  businessId: number,
  userId: number,
  callerIsOwner: boolean,
  requiredLocationIds: number[],
): Promise<void> {
  if (callerIsOwner) return;
  const accessible = new Set(
    await listAccessibleLocationIds(businessId, userId, false),
  );
  const missing = requiredLocationIds.filter((id) => !accessible.has(id));
  if (missing.length > 0) {
    throw new ForbiddenError(
      "You do not have access to one or more locations in this transfer.",
    );
  }
}

async function loadActiveLocations(
  tx: Tx,
  businessId: number,
  locationIds: number[],
): Promise<Map<number, string>> {
  const rows = await tx
    .select({ id: locations.id, name: locations.name, status: locations.status })
    .from(locations)
    .where(
      and(eq(locations.businessId, businessId), inArray(locations.id, locationIds)),
    );
  const map = new Map<number, string>();
  for (const row of rows) {
    if (row.status !== "active") {
      throw new BadRequestError(
        `Location "${row.name}" is deactivated and cannot be used for transfers.`,
      );
    }
    map.set(row.id, row.name);
  }
  for (const id of locationIds) {
    if (!map.has(id)) {
      throw new BadRequestError("One or more locations do not exist.");
    }
  }
  return map;
}

export async function createTransfer(
  businessId: number,
  userId: number,
  callerIsOwner: boolean,
  input: CreateTransferInput,
): Promise<TransferDetail> {
  if (input.fromLocationId === input.toLocationId) {
    throw new BadRequestError(
      "Source and destination locations must be different.",
    );
  }
  await assertCallerAccessesLocations(businessId, userId, callerIsOwner, [
    input.fromLocationId,
    input.toLocationId,
  ]);

  const variantIds = [...new Set(input.items.map((item) => item.variantId))];

  return db.transaction(async (tx) => {
    await loadActiveLocations(tx, businessId, [
      input.fromLocationId,
      input.toLocationId,
    ]);

    const variants = await tx
      .select({ id: productVariants.id, sku: productVariants.sku })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.businessId, businessId),
          inArray(productVariants.id, variantIds),
        ),
      );
    if (variants.length !== variantIds.length) {
      throw new BadRequestError(
        "One or more variants do not exist in this business.",
      );
    }
    const skuByVariant = new Map(variants.map((v) => [v.id, v.sku]));

    // Merge duplicate variant lines defensively.
    const merged = new Map<number, number>();
    for (const item of input.items) {
      merged.set(
        item.variantId,
        (merged.get(item.variantId) ?? 0) + item.quantity,
      );
    }

    const number = await nextDocumentNumber(tx, businessId, "stock_transfer");
    const transferNumber = `TRF-${String(number).padStart(6, "0")}`;

    const [transfer] = await tx
      .insert(stockTransfers)
      .values({
        businessId,
        transferNumber,
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        notes: input.notes ?? null,
        createdByUserId: userId,
      })
      .returning();
    if (!transfer) {
      throw new Error("Transfer insert returned no row.");
    }

    await tx.insert(stockTransferItems).values(
      [...merged.entries()].map(([variantId, quantity]) => ({
        businessId,
        transferId: transfer.id,
        variantId,
        quantity,
      })),
    );

    return getTransferDetailInTx(tx, businessId, transfer.id);
  });
}

async function getTransferDetailInTx(
  tx: Tx,
  businessId: number,
  transferId: number,
): Promise<TransferDetail> {
  const [header] = await tx
    .select({
      id: stockTransfers.id,
      transferNumber: stockTransfers.transferNumber,
      fromLocationId: stockTransfers.fromLocationId,
      toLocationId: stockTransfers.toLocationId,
      status: stockTransfers.status,
      notes: stockTransfers.notes,
      shippedAt: stockTransfers.shippedAt,
      receivedAt: stockTransfers.receivedAt,
      createdAt: stockTransfers.createdAt,
    })
    .from(stockTransfers)
    .where(
      and(
        eq(stockTransfers.id, transferId),
        eq(stockTransfers.businessId, businessId),
      ),
    )
    .for("update");
  if (!header) {
    throw new NotFoundError("Transfer not found.");
  }
  const items = await listTransferItemsInTx(tx, businessId, transferId);
  return {
    ...header,
    fromLocationName: (await loadLocationNames(tx, businessId, [header.fromLocationId, header.toLocationId])).get(header.fromLocationId) ?? "",
    toLocationName: (await loadLocationNames(tx, businessId, [header.fromLocationId, header.toLocationId])).get(header.toLocationId) ?? "",
    items,
  };
}

async function loadLocationNames(
  tx: Tx,
  businessId: number,
  locationIds: number[],
): Promise<Map<number, string>> {
  const rows = await tx
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(
      and(eq(locations.businessId, businessId), inArray(locations.id, locationIds)),
    );
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function listTransferItemsInTx(
  tx: Tx,
  businessId: number,
  transferId: number,
): Promise<TransferItemView[]> {
  const rows = await tx
    .select({
      id: stockTransferItems.id,
      variantId: stockTransferItems.variantId,
      sku: productVariants.sku,
      productName: sql<string | null>`(
        SELECT p.name FROM products p
        WHERE p.id = ${productVariants.productId}
      )`,
      quantity: stockTransferItems.quantity,
      quantityShipped: stockTransferItems.quantityShipped,
      quantityReceived: stockTransferItems.quantityReceived,
      unitCost: stockTransferItems.unitCost,
    })
    .from(stockTransferItems)
    .innerJoin(
      productVariants,
      eq(productVariants.id, stockTransferItems.variantId),
    )
    .where(
      and(
        eq(stockTransferItems.transferId, transferId),
        eq(stockTransferItems.businessId, businessId),
      ),
    )
    .orderBy(asc(stockTransferItems.id));

  // Option labels batched per distinct variant (a join would fan out rows).
  const variantIds = [...new Set(rows.map((row) => row.variantId))];
  let optionsByVariant = new Map<number, string[]>();
  if (variantIds.length > 0) {
    const optRows = await tx
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
    unitCost: Number(row.unitCost),
    variantOptions: variantOptionsFromMap(optionsByVariant, row.variantId),
    variantName: variantNameFromMap(optionsByVariant, row.variantId, row.productName),
  }));
}

/**
 * Ships a draft transfer: consumes FIFO batches at the source location and
 * deducts its stock. The destination is NOT touched until receiving — the
 * shipped quantity is the in-transit balance. Row locks (FOR UPDATE) on the
 * stock rows prevent two concurrent ships from overselling the same stock.
 */
export async function shipTransfer(
  businessId: number,
  userId: number,
  callerIsOwner: boolean,
  transferId: number,
): Promise<TransferDetail> {
  return db.transaction(async (tx) => {
    const [transfer] = await tx
      .select()
      .from(stockTransfers)
      .where(
        and(
          eq(stockTransfers.id, transferId),
          eq(stockTransfers.businessId, businessId),
        ),
      )
      .for("update");
    if (!transfer) {
      throw new NotFoundError("Transfer not found.");
    }
    if (transfer.status !== "draft") {
      throw new ConflictError("Only draft transfers can be shipped.");
    }
    await assertCallerAccessesLocations(businessId, userId, callerIsOwner, [
      transfer.fromLocationId,
    ]);

    const items = await tx
      .select()
      .from(stockTransferItems)
      .where(
        and(
          eq(stockTransferItems.transferId, transferId),
          eq(stockTransferItems.businessId, businessId),
        ),
      )
      .for("update");

    for (const item of items) {
      const consumed = await consumeStockFifoAtLocation(
        tx,
        businessId,
        transfer.fromLocationId,
        item.variantId,
        item.quantity,
      );

      await tx
        .update(stockTransferItems)
        .set({
          quantityShipped: item.quantity,
          unitCost: consumed.quantity > 0
            ? roundMoney(consumed.totalCost / consumed.quantity)
            : 0,
        })
        .where(eq(stockTransferItems.id, item.id));

      await tx.insert(inventoryMovements).values({
        businessId,
        variantId: item.variantId,
        locationId: transfer.fromLocationId,
        movementType: "transfer_out",
        quantity: -item.quantity,
        referenceType: "stock_transfer",
        referenceId: transfer.id,
      });
    }

    await tx
      .update(stockTransfers)
      .set({ status: "shipped", shippedAt: new Date(), updatedAt: new Date() })
      .where(eq(stockTransfers.id, transferId));

    return getTransferDetailInTx(tx, businessId, transferId);
  });
}

interface ConsumedStock {
  quantity: number;
  totalCost: number;
}

/** FIFO batch consumption at a specific location — mirrors the sale path. */
async function consumeStockFifoAtLocation(
  tx: Tx,
  businessId: number,
  locationId: number,
  variantId: number,
  quantity: number,
): Promise<ConsumedStock> {
  const [stock] = await tx
    .select({ id: inventoryStock.id, quantity: inventoryStock.quantity })
    .from(inventoryStock)
    .where(
      and(
        eq(inventoryStock.variantId, variantId),
        eq(inventoryStock.businessId, businessId),
        eq(inventoryStock.locationId, locationId),
      ),
    )
    .for("update");

  const available = Number(stock?.quantity ?? 0);
  if (!stock || available < quantity) {
    throw new BadRequestError(
      `Insufficient stock at the source location for variant ${variantId}. Available: ${available}, requested: ${quantity}`,
    );
  }

  const batches = await tx
    .select()
    .from(inventoryBatches)
    .where(
      and(
        eq(inventoryBatches.variantId, variantId),
        eq(inventoryBatches.businessId, businessId),
        eq(inventoryBatches.locationId, locationId),
        gt(inventoryBatches.quantityRemaining, 0),
      ),
    )
    .orderBy(asc(inventoryBatches.id))
    .for("update");

  let remaining = quantity;
  let totalCost = 0;
  for (const batch of batches) {
    if (remaining === 0) break;
    const take = Math.min(batch.quantityRemaining, remaining);
    await tx
      .update(inventoryBatches)
      .set({ quantityRemaining: batch.quantityRemaining - take })
      .where(and(eq(inventoryBatches.id, batch.id), eq(inventoryBatches.businessId, businessId)));
    totalCost += take * Number(batch.purchasePrice);
    remaining -= take;
  }
  if (remaining > 0) {
    // Stock row had the quantity but batches did not — inconsistent state.
    throw new BadRequestError(
      `Batch records are short for variant ${variantId} at the source location. Refuse to ship.`,
    );
  }

  await tx
    .update(inventoryStock)
    .set({ quantity: sql`${inventoryStock.quantity} - ${quantity}` })
    .where(eq(inventoryStock.id, stock.id));

  return { quantity, totalCost: roundMoney(totalCost) };
}

/**
 * Receives a shipped (or partially received) transfer at the destination
 * location. Per-item quantities default to "receive everything remaining";
 * receiving less records the shortfall as shrinkage (nothing auto-restocks
 * the source — that is a deliberate human decision via a new transfer).
 * Destination batches carry the shipped unit cost for correct valuation.
 */
export async function receiveTransfer(
  businessId: number,
  userId: number,
  callerIsOwner: boolean,
  transferId: number,
  input: ReceiveTransferInput,
): Promise<TransferDetail> {
  return db.transaction(async (tx) => {
    const [transfer] = await tx
      .select()
      .from(stockTransfers)
      .where(
        and(
          eq(stockTransfers.id, transferId),
          eq(stockTransfers.businessId, businessId),
        ),
      )
      .for("update");
    if (!transfer) {
      throw new NotFoundError("Transfer not found.");
    }
    if (transfer.status !== "shipped" && transfer.status !== "partially_received") {
      throw new ConflictError(
        "Only shipped transfers can be received.",
      );
    }
    await assertCallerAccessesLocations(businessId, userId, callerIsOwner, [
      transfer.toLocationId,
    ]);

    const items = await tx
      .select()
      .from(stockTransferItems)
      .where(
        and(
          eq(stockTransferItems.transferId, transferId),
          eq(stockTransferItems.businessId, businessId),
        ),
      )
      .for("update");

    const requested = new Map<number, number>();
    if (input.items !== undefined) {
      for (const entry of input.items) {
        requested.set(entry.itemId, entry.quantity);
      }
    }

    for (const item of items) {
      const outstanding = item.quantityShipped - item.quantityReceived;
      const receiveNow =
        input.items === undefined ? outstanding : (requested.get(item.id) ?? 0);
      if (receiveNow === 0) continue;
      if (receiveNow < 0) {
        throw new BadRequestError("Received quantities cannot be negative.");
      }
      if (receiveNow > outstanding) {
        throw new BadRequestError(
          `Cannot receive more than was shipped for item ${item.id}. Outstanding: ${outstanding}`,
        );
      }

      // Upsert destination stock (one row per business+variant+location).
      await tx
        .insert(inventoryStock)
        .values({
          businessId,
          locationId: transfer.toLocationId,
          variantId: item.variantId,
          quantity: receiveNow,
        })
        .onConflictDoUpdate({
          target: [
            inventoryStock.businessId,
            inventoryStock.variantId,
            inventoryStock.locationId,
          ],
          set: {
            quantity: sql`${inventoryStock.quantity} + ${receiveNow}`,
          },
        });

      const [batch] = await tx
        .insert(inventoryBatches)
        .values({
          businessId,
          locationId: transfer.toLocationId,
          variantId: item.variantId,
          purchaseItemId: null,
          batchNumber: `TRF-${transfer.transferNumber}-${item.id}-${Date.now()}`,
          purchasePrice: roundMoney(Number(item.unitCost)),
          quantityReceived: receiveNow,
          quantityRemaining: receiveNow,
        })
        .returning({ id: inventoryBatches.id });

      await tx.insert(inventoryMovements).values({
        businessId,
        variantId: item.variantId,
        locationId: transfer.toLocationId,
        batchId: batch?.id ?? null,
        movementType: "transfer_in",
        quantity: receiveNow,
        referenceType: "stock_transfer",
        referenceId: transfer.id,
      });

      await tx
        .update(stockTransferItems)
        .set({ quantityReceived: item.quantityReceived + receiveNow })
        .where(eq(stockTransferItems.id, item.id));
    }

    const refreshed = await tx
      .select({
        quantity: stockTransferItems.quantity,
        quantityShipped: stockTransferItems.quantityShipped,
        quantityReceived: stockTransferItems.quantityReceived,
      })
      .from(stockTransferItems)
      .where(
        and(
          eq(stockTransferItems.transferId, transferId),
          eq(stockTransferItems.businessId, businessId),
        ),
      );
    const fullyReceived = refreshed.every(
      (item) => item.quantityReceived >= item.quantityShipped && item.quantityShipped > 0,
    );

    await tx
      .update(stockTransfers)
      .set({
        status: fullyReceived ? "received" : "partially_received",
        receivedAt: fullyReceived ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(stockTransfers.id, transferId));

    return getTransferDetailInTx(tx, businessId, transferId);
  });
}

/** Only drafts can be cancelled — shipped stock must be received (and any
 *  shortfall handled explicitly), never silently reversed. */
export async function cancelTransfer(
  businessId: number,
  userId: number,
  callerIsOwner: boolean,
  transferId: number,
): Promise<TransferDetail> {
  return db.transaction(async (tx) => {
    const [transfer] = await tx
      .select()
      .from(stockTransfers)
      .where(
        and(
          eq(stockTransfers.id, transferId),
          eq(stockTransfers.businessId, businessId),
        ),
      )
      .for("update");
    if (!transfer) {
      throw new NotFoundError("Transfer not found.");
    }
    if (transfer.status !== "draft") {
      throw new ConflictError(
        "Only draft transfers can be cancelled. Shipped transfers must be received.",
      );
    }
    await assertCallerAccessesLocations(businessId, userId, callerIsOwner, [
      transfer.fromLocationId,
      transfer.toLocationId,
    ]);

    await tx
      .update(stockTransfers)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(stockTransfers.id, transferId));

    return getTransferDetailInTx(tx, businessId, transferId);
  });
}

export interface TransferListItem {
  id: number;
  transferNumber: string;
  fromLocationId: number;
  fromLocationName: string;
  toLocationId: number;
  toLocationName: string;
  status: string;
  itemCount: number;
  totalQuantity: number;
  createdAt: Date | null;
  shippedAt: Date | null;
  receivedAt: Date | null;
}

export async function listTransfers(
  businessId: number,
  userId: number,
  callerIsOwner: boolean,
  status?: string,
): Promise<TransferListItem[]> {
  const accessibleIds = await listAccessibleLocationIds(
    businessId,
    userId,
    callerIsOwner,
  );
  // Staff see transfers touching THEIR locations only; owners see all.
  const scopePredicate =
    callerIsOwner || accessibleIds.length === 0
      ? callerIsOwner
        ? undefined
        : sql`false`
      : or(
          inArray(stockTransfers.fromLocationId, accessibleIds),
          inArray(stockTransfers.toLocationId, accessibleIds),
        );

  const rows = await db
    .select({
      id: stockTransfers.id,
      transferNumber: stockTransfers.transferNumber,
      fromLocationId: stockTransfers.fromLocationId,
      toLocationId: stockTransfers.toLocationId,
      status: stockTransfers.status,
      createdAt: stockTransfers.createdAt,
      shippedAt: stockTransfers.shippedAt,
      receivedAt: stockTransfers.receivedAt,
      itemCount: sql<number>`(
        SELECT count(*)::int FROM stock_transfer_items i WHERE i.transfer_id = ${stockTransfers.id}
      )`,
      totalQuantity: sql<number>`(
        SELECT COALESCE(SUM(i.quantity), 0)::int FROM stock_transfer_items i WHERE i.transfer_id = ${stockTransfers.id}
      )`,
    })
    .from(stockTransfers)
    .where(
      and(
        eq(stockTransfers.businessId, businessId),
        status !== undefined
          ? sql`${stockTransfers.status}::text = ${status}`
          : undefined,
        scopePredicate,
      ),
    )
    .orderBy(desc(stockTransfers.id))
    .limit(200);

  const names = await loadLocationNames(
    db,
    businessId,
    rows.flatMap((r) => [r.fromLocationId, r.toLocationId]),
  );

  return rows.map((row) => ({
    ...row,
    fromLocationName: names.get(row.fromLocationId) ?? "",
    toLocationName: names.get(row.toLocationId) ?? "",
  }));
}

export async function getTransferDetail(
  businessId: number,
  userId: number,
  callerIsOwner: boolean,
  transferId: number,
): Promise<TransferDetail> {
  const [header] = await db
    .select()
    .from(stockTransfers)
    .where(
      and(
        eq(stockTransfers.id, transferId),
        eq(stockTransfers.businessId, businessId),
      ),
    );
  if (!header) {
    throw new NotFoundError("Transfer not found.");
  }
  if (!callerIsOwner) {
    const accessible = new Set(
      await listAccessibleLocationIds(businessId, userId, false),
    );
    if (
      !accessible.has(header.fromLocationId) &&
      !accessible.has(header.toLocationId)
    ) {
      // Indistinguishable from non-existent — no enumeration leak.
      throw new NotFoundError("Transfer not found.");
    }
  }
  return db.transaction(async (tx) =>
    getTransferDetailInTx(tx, businessId, transferId),
  );
}
