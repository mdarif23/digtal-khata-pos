import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbTransaction } from "../purchases/purchase.types.js";
import { inventoryMovements } from "../../db/schema/inventoryMovements.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import { BadRequestError } from "../../utils/handleError.js";

/**
 * Canonical inventory WRITE primitives (Phase 5).
 *
 * Scope: only what the purchases receive/return flows use today. Sales,
 * transfers and stock-counts keep their own (richer) write paths for now —
 * consolidating those is deliberately deferred to avoid touching their
 * behavior in this refactor.
 *
 * Every function takes the caller's transaction and the server-verified
 * businessId, and scopes all writes to it.
 */

export type StockMovementType =
  | "purchase"
  | "sale"
  | "return"
  | "adjustment"
  | "transfer_in"
  | "transfer_out";

/**
 * Stock movements are the inventory audit trail: one row per physical
 * change, with a polymorphic reference back to the source operation.
 */
export async function recordStockMovement(
  tx: DbTransaction,
  input: {
    businessId: number;
    variantId: number;
    locationId: number;
    movementType: StockMovementType;
    referenceType: string;
    referenceId: number;
    quantity: number;
  },
) {
  await tx.insert(inventoryMovements).values(input);
}

/** Receiving: add units to the (business, variant, location) stock row. */
export async function incrementStockForReceive(
  tx: DbTransaction,
  input: {
    businessId: number;
    locationId: number;
    variantId: number;
    quantity: number;
  },
) {
  // One stock row per (business, variant, location): receiving into one
  // store never touches another store's stock.
  await tx
    .insert(inventoryStock)
    .values({
      businessId: input.businessId,
      locationId: input.locationId,
      variantId: input.variantId,
      quantity: input.quantity,
    })
    .onConflictDoUpdate({
      target: [
        inventoryStock.businessId,
        inventoryStock.variantId,
        inventoryStock.locationId,
      ],
      set: {
        quantity: sql`${inventoryStock.quantity} + ${input.quantity}`,
      },
    });
}

/**
 * Returns/removals: subtract units at a location, refusing (via the
 * caller's row-locked stock read and the conditional update) to go below
 * zero. The caller re-checks availability; this is the last-line guard
 * against concurrent races.
 */
export async function decrementStockGuarded(
  tx: DbTransaction,
  input: {
    businessId: number;
    locationId: number;
    variantId: number;
    quantity: number;
  },
): Promise<boolean> {
  const [updated] = await tx
    .update(inventoryStock)
    .set({
      quantity: sql`${inventoryStock.quantity} - ${input.quantity}`,
    })
    .where(
      and(
        eq(inventoryStock.variantId, input.variantId),
        eq(inventoryStock.businessId, input.businessId),
        eq(inventoryStock.locationId, input.locationId),
        sql`${inventoryStock.quantity} >= ${input.quantity}`,
      ),
    )
    .returning({ variantId: inventoryStock.variantId });
  return Boolean(updated);
}

/** Purchase returns: in-stock serials transition to `returned`. */
export async function markSerialsReturned(
  tx: DbTransaction,
  input: { businessId: number; serialIds: number[] },
) {
  if (input.serialIds.length === 0) return;
  await tx
    .update(serialNumbers)
    .set({ status: "returned" })
    .where(
      and(
        eq(serialNumbers.businessId, input.businessId),
        inArray(serialNumbers.id, input.serialIds),
      ),
    );
}

export function assertStockDecremented(decremented: boolean, variantId: number) {
  if (!decremented) {
    throw new BadRequestError(
      `Stock changed while processing the return for variant ${variantId}. Please retry.`,
    );
  }
}
