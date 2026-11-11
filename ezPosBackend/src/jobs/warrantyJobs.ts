/**
 * Warranty sweeps (migration 0064, Phase 7) — in-app notification reminders,
 * following the commerceJobs sweep conventions: dynamic imports to avoid
 * dependency cycles, bounded LIMIT, per-day dedupe keys embedding the entity
 * id, and a counts object for the scheduler rollup.
 */
export async function runWarrantySweeps(): Promise<{
  warrantyExpiryNotified: number;
  pickupReminders: number;
  supplierReminders: number;
}> {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../db/schema/index.js");
  const { notifyInTx } = await import("../services/notifications.js");

  // 1. Customer warranties expiring within 7 days (active only, expiry is
  // derived — D3). One notification per warranty, deduped per day.
  const expiring = await db.execute(sql`
    SELECT cw.id AS "warrantyId", cw.business_id AS "businessId",
           cw.warranty_number AS "warrantyNumber",
           cw.expiry_date::date::text AS "expiryDate",
           p.name AS "productName"
    FROM customer_warranties cw
    INNER JOIN products p ON p.id = cw.product_id
    WHERE cw.status = 'active'
      AND cw.expiry_date >= now()
      AND cw.expiry_date < now() + INTERVAL '7 days'
    LIMIT 100
  `);
  let warrantyExpiryNotified = 0;
  for (const raw of expiring.rows) {
    const row = raw as {
      warrantyId: number;
      businessId: number;
      warrantyNumber: string;
      expiryDate: string;
      productName: string;
    };
    await notifyInTx(db, {
      businessId: row.businessId,
      kind: "warranty_expiring",
      severity: "warning",
      title: "Warranty expiring soon",
      body: `${row.productName} warranty ${row.warrantyNumber} expires on ${row.expiryDate}.`,
      payload: { warrantyId: row.warrantyId },
      dedupeKey: `warranty_expiry:${row.warrantyId}`,
    });
    warrantyExpiryNotified += 1;
  }

  // 2. Finished repairs waiting for customer pickup for 3+ days.
  const readyClaims = await db.execute(sql`
    SELECT wc.id AS "claimId", wc.business_id AS "businessId",
           wc.claim_number AS "claimNumber"
    FROM warranty_claims wc
    WHERE wc.status = 'ready_for_pickup'
      AND wc.updated_at < now() - INTERVAL '3 days'
    LIMIT 100
  `);
  let pickupReminders = 0;
  for (const raw of readyClaims.rows) {
    const row = raw as { claimId: number; businessId: number; claimNumber: string };
    await notifyInTx(db, {
      businessId: row.businessId,
      kind: "warranty_claim",
      severity: "info",
      title: "Claim awaiting customer pickup",
      body: `Warranty claim ${row.claimNumber} has been ready for pickup since 3+ days.`,
      payload: { claimId: row.claimId },
      dedupeKey: `warranty_ready:${row.claimId}`,
    });
    pickupReminders += 1;
  }

  // 3. Supplier claims with no response for 3+ days.
  const awaitingSupplier = await db.execute(sql`
    SELECT swc.id AS "claimId", swc.business_id AS "businessId",
           swc.claim_number AS "claimNumber", sup.name AS "supplierName"
    FROM supplier_warranty_claims swc
    INNER JOIN suppliers sup ON sup.id = swc.supplier_id
    WHERE swc.status IN ('submitted', 'sent_to_supplier')
      AND swc.updated_at < now() - INTERVAL '3 days'
    LIMIT 100
  `);
  let supplierReminders = 0;
  for (const raw of awaitingSupplier.rows) {
    const row = raw as {
      claimId: number;
      businessId: number;
      claimNumber: string;
      supplierName: string;
    };
    await notifyInTx(db, {
      businessId: row.businessId,
      kind: "supplier_warranty_claim",
      severity: "info",
      title: "Supplier claim awaiting response",
      body: `Supplier claim ${row.claimNumber} (${row.supplierName}) has been waiting since 3+ days.`,
      payload: { claimId: row.claimId },
      dedupeKey: `supplier_claim:${row.claimId}`,
    });
    supplierReminders += 1;
  }

  return { warrantyExpiryNotified, pickupReminders, supplierReminders };
}
