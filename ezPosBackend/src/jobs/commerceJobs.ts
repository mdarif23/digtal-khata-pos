import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { inventoryReservations } from "../db/schema/inventoryReservations.js";
import { inventoryStock } from "../db/schema/inventoryStock.js";
import { sales } from "../db/schema/sales.js";

/**
 * Commerce sweeps (Phase 9.1): expire stale online-order reservations.
 *
 * An expired reservation releases its stock hold and cancels the still-
 * pending sale. Lock ordering matches confirmOnlineOrder (sale row first,
 * then reservations) so the two paths cannot deadlock.
 */
export async function sweepExpiredReservations(
  now: Date = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({
        id: inventoryReservations.id,
        saleId: inventoryReservations.saleId,
        stockId: inventoryReservations.stockId,
        quantity: inventoryReservations.quantity,
      })
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.status, "active"),
          lt(inventoryReservations.expiresAt, now),
        ),
      )
      .for("update", { skipLocked: true });

    let expired = 0;
    for (const reservation of due) {
      if (reservation.saleId) {
        // Lock the sale first (same order as confirmation) and cancel it
        // only if it is still pending — a confirmed/paid sale owns its
        // reservation as 'confirmed', which this sweep never selects.
        const [sale] = await tx
          .select({ id: sales.id, status: sales.status })
          .from(sales)
          .where(eq(sales.id, reservation.saleId))
          .for("update");
        if (sale && sale.status === "pending") {
          await tx
            .update(sales)
            .set({ status: "cancelled" })
            .where(eq(sales.id, sale.id));
        }
      }
      await tx
        .update(inventoryReservations)
        .set({ status: "expired" })
        .where(eq(inventoryReservations.id, reservation.id));
      await tx
        .update(inventoryStock)
        .set({
          reservedQuantity: sql`greatest(0, ${inventoryStock.reservedQuantity} - ${reservation.quantity})`,
        })
        .where(eq(inventoryStock.id, reservation.stockId));
      expired += 1;
    }
    return expired;
  });
}

export async function runCommerceSweeps(
  now: Date = new Date(),
): Promise<{ reservationsExpired: number; heldSalesExpired: number; expiryNotifications: number }> {
  const results = { reservationsExpired: 0, heldSalesExpired: 0, expiryNotifications: 0 };
  try {
    results.reservationsExpired = await sweepExpiredReservations(now);
  } catch (err) {
    console.error("Reservation expiry sweep failed:", err);
  }
  try {
    const { expireHeldSales } = await import(
      "../modules/heldSales/heldSales.service.js"
    );
    results.heldSalesExpired = await expireHeldSales();
  } catch (err) {
    console.error("Held-sale expiry sweep failed:", err);
  }
  try {
    results.expiryNotifications = await sweepExpiringInventory();
  } catch (err) {
    console.error("Expiring-inventory sweep failed:", err);
  }
  return results;
}

/**
 * Expiring-inventory notifications (Module 14): batches expiring within 7
 * days with stock remaining, deduped per batch per day.
 */
async function sweepExpiringInventory(): Promise<number> {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../db/schema/index.js");
  const { notifyExpiringBatches } = await import(
    "../services/notifications.js"
  );
  const result = await db.execute(sql`
    SELECT b.id AS "batchId", p.name AS "productName",
           b.expiry_date::text AS "expiryDate",
           b.quantity_remaining AS "quantity",
           b.business_id AS "businessId"
    FROM inventory_batches b
    JOIN product_variants v ON v.id = b.variant_id
    JOIN products p ON p.id = v.product_id
    WHERE b.quantity_remaining > 0
      AND b.expiry_date IS NOT NULL
      AND b.expiry_date <= (CURRENT_DATE + INTERVAL '7 days')
    LIMIT 100
  `);
  const rows = result.rows as {
    batchId: number;
    productName: string;
    expiryDate: string;
    quantity: number;
    businessId: number;
  }[];
  const byBusiness = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = byBusiness.get(row.businessId) ?? [];
    list.push(row);
    byBusiness.set(row.businessId, list);
  }
  for (const [businessId, list] of byBusiness) {
    await notifyExpiringBatches(businessId, list);
  }
  return rows.length;
}
