import { and, asc, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { heldSales } from "../../db/schema/heldSales.js";
import { users } from "../../db/schema/users.js";
import { env } from "../../config/env.js";
import { NotFoundError } from "../../utils/handleError.js";
import { recordAuditInTx } from "../../services/audit.js";
import { publishRealtime } from "../realtime/realtime.service.js";
import type { DbTransaction } from "../purchases/purchase.types.js";

/**
 * Shared held sales (Module 1: cross-register holds, Module 11: concurrent
 * registers). Holds are scoped to business+location; any cashier with
 * pos.create_sale there can retrieve or discard them. Expired holds are
 * cleaned lazily on list and by the scheduler sweep.
 */

export interface HeldSaleItem {
  variantId: number;
  /** ENTERED quantity — in the line's selling unit (base when no UOM). */
  quantity: number;
  discount?: { type: "percentage" | "fixed"; value: number } | null;
  serialNumbers?: string[];
  productName: string;
  /** UOM (migration 0062): packaging unit + entered qty; re-resolved at
   * resume (factor/price are never trusted from the hold). */
  uomConversionId?: number | null;
  enteredQuantity?: number | null;
}

function ttlMs(): number | null {
  const hours = env.heldSalesTtlHours;
  if (hours === null || hours <= 0) return null;
  return hours * 60 * 60 * 1000;
}

/** Deletes expired holds; returns how many were removed. */
export async function expireHeldSales(
  tx: DbTransaction | typeof db = db,
): Promise<number> {
  const deleted = await tx
    .delete(heldSales)
    .where(isNotNull(heldSales.expiresAt) && lt(heldSales.expiresAt, new Date()))
    .returning({ id: heldSales.id });
  return deleted.length;
}

export async function createHeldSale(input: {
  businessId: number;
  locationId: number;
  actorUserId: number;
  name: string;
  items: HeldSaleItem[];
  note?: string | null;
}): Promise<{ id: number; name: string }> {
  if (input.items.length === 0) {
    throw new NotFoundError("A held sale requires at least one item.");
  }
  const ttl = ttlMs();
  const created = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(heldSales)
      .values({
        businessId: input.businessId,
        locationId: input.locationId,
        heldByUserId: input.actorUserId,
        name: input.name,
        items: input.items,
        note: input.note ?? null,
        expiresAt: ttl !== null ? new Date(Date.now() + ttl) : null,
      })
      .returning({ id: heldSales.id, name: heldSales.name });
    if (!created) throw new NotFoundError("Could not hold the sale.");
    await recordAuditInTx(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      action: "sale.held",
      entityType: "held_sale",
      entityId: created.id,
      metadata: {
        name: created.name,
        itemCount: input.items.length,
        locationId: input.locationId,
      },
    });
    return created;
  });
  publishRealtime(input.businessId, input.locationId, {
    kind: "held_sales.changed",
    locationId: input.locationId,
  });
  return created;
}

export async function listHeldSales(businessId: number, locationId: number) {
  // Lazy expiry: expired rows are removed whenever the list is read, so the
  // TTL holds even if the scheduler sweep is disabled.
  await expireHeldSales();
  const rows = await db
    .select({
      id: heldSales.id,
      name: heldSales.name,
      items: heldSales.items,
      note: heldSales.note,
      createdAt: heldSales.createdAt,
      expiresAt: heldSales.expiresAt,
      heldByName: users.fullName,
    })
    .from(heldSales)
    .innerJoin(users, eq(users.id, heldSales.heldByUserId))
    .where(
      and(
        eq(heldSales.businessId, businessId),
        eq(heldSales.locationId, locationId),
      ),
    )
    .orderBy(asc(heldSales.createdAt));
  return rows.map((row) => ({
    ...row,
    itemCount: row.items.length,
  }));
}

export async function deleteHeldSale(
  businessId: number,
  locationId: number,
  id: number,
  actorUserId: number | null,
): Promise<{ deleted: boolean }> {
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(heldSales)
      .where(
        and(
          eq(heldSales.id, id),
          eq(heldSales.businessId, businessId),
          eq(heldSales.locationId, locationId),
        ),
      )
      .returning({ id: heldSales.id });
    if (!deleted) return { deleted: false };
    await recordAuditInTx(tx, {
      businessId,
      actorUserId,
      action: "sale.hold_discarded",
      entityType: "held_sale",
      entityId: id,
      metadata: {},
    });
    publishRealtime(businessId, locationId, {
      kind: "held_sales.changed",
      locationId,
    });
    return { deleted: true };
  });
  publishRealtime(businessId, locationId, {
    kind: "held_sales.changed",
    locationId,
  });
  return { deleted: true };
}