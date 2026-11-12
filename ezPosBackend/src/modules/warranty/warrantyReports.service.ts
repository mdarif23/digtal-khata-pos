import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { roundMoney } from "../../utils/roundMoney.js";

/**
 * Warranty reports & overview (Phase 6). Raw SQL in the reports.service.ts
 * style; every query is business-scoped and honours the optional location
 * filter resolved by the controller. Expired/expiring are derived views over
 * expiry_date (D3).
 *
 * Analytics rules (audit §10):
 * - claim COUNT ≠ units AFFECTED ≠ money. Every report surfaces them as
 *   separate columns.
 * - claim rate denominators are stated: claims per covered units issued.
 */

type QueryRow = Record<string, unknown>;

function locationClause(locationId: number | undefined, alias: string): SQL {
  if (locationId == null) return sql``;
  return sql` AND ${sql.raw(alias)}.location_id = ${locationId}`;
}

function dateClause(from: unknown, to: unknown, alias: string, column: string): SQL {
  const clauses: SQL[] = [];
  if (typeof from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    clauses.push(sql`${sql.raw(alias)}.${sql.raw(column)} >= ${from}::timestamp`);
  }
  if (typeof to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    clauses.push(sql`${sql.raw(alias)}.${sql.raw(column)} < (${to}::date + INTERVAL '1 day')`);
  }
  return clauses.length ? sql` AND ${sql.join(clauses, sql` AND `)}` : sql``;
}

/** Dashboard cards for the Warranty Management overview page. */
export async function getWarrantyOverview(businessId: number, locationId?: number) {
  const loc = locationClause(locationId, "cw");
  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE cw.status = 'active' AND cw.expiry_date >= now())::int
        AS active_warranties,
      COUNT(*) FILTER (WHERE cw.status = 'active' AND cw.expiry_date >= now()
        AND cw.expiry_date < now() + INTERVAL '30 days')::int
        AS expiring_soon,
      COUNT(*) FILTER (WHERE cw.status = 'active' AND cw.expiry_date < now())::int
        AS expired_warranties,
      COALESCE(SUM(cw.quantity) FILTER (WHERE cw.status = 'active' AND cw.expiry_date >= now()), 0)::int
        AS covered_units,
      (SELECT COUNT(*)::int FROM warranty_claims wc
        WHERE wc.business_id = ${businessId} AND wc.status NOT IN ('closed','cancelled','rejected')
          ${locationId != null ? sql` AND wc.location_id = ${locationId}` : sql``})
        AS open_claims,
      (SELECT COUNT(*)::int FROM warranty_claims wc
        WHERE wc.business_id = ${businessId} AND wc.status = 'submitted'
          ${locationId != null ? sql` AND wc.location_id = ${locationId}` : sql``})
        AS pending_inspections,
      (SELECT COUNT(*)::int FROM warranty_claims wc
        WHERE wc.business_id = ${businessId} AND wc.status IN ('repairing','waiting_parts')
          ${locationId != null ? sql` AND wc.location_id = ${locationId}` : sql``})
        AS in_repair,
      (SELECT COUNT(*)::int FROM warranty_claims wc
        WHERE wc.business_id = ${businessId} AND wc.status = 'ready_for_pickup'
          ${locationId != null ? sql` AND wc.location_id = ${locationId}` : sql``})
        AS ready_for_pickup,
      (SELECT COALESCE(SUM(wc.repair_cost), 0) FROM warranty_claims wc
        WHERE wc.business_id = ${businessId}
          ${locationId != null ? sql` AND wc.location_id = ${locationId}` : sql``})::float8
        AS total_repair_cost,
      (SELECT COUNT(*)::int FROM supplier_warranty_claims swc
        WHERE swc.business_id = ${businessId} AND swc.status NOT IN ('closed','cancelled','rejected'))
        AS open_supplier_claims
    FROM customer_warranties cw
    WHERE cw.business_id = ${businessId}${loc}
  `);
  const row = (result.rows[0] ?? {}) as QueryRow;
  return {
    activeWarranties: Number(row.active_warranties ?? 0),
    expiringSoon: Number(row.expiring_soon ?? 0),
    expiredWarranties: Number(row.expired_warranties ?? 0),
    coveredUnits: Number(row.covered_units ?? 0),
    openClaims: Number(row.open_claims ?? 0),
    pendingInspections: Number(row.pending_inspections ?? 0),
    inRepair: Number(row.in_repair ?? 0),
    readyForPickup: Number(row.ready_for_pickup ?? 0),
    totalRepairCost: roundMoney(Number(row.total_repair_cost ?? 0)),
    openSupplierClaims: Number(row.open_supplier_claims ?? 0),
  };
}

/**
 * Expiry report: every issued warranty with its derived expiry bucket.
 * Shape matches the batch-expiry report: { data, total, page, limit }.
 */
export async function getExpiryReport(
  businessId: number,
  locationId: number | undefined,
  query: Record<string, unknown>,
) {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const limit = Math.min(1000, Math.max(1, Number(query.limit ?? 50) || 50));
  const loc = locationClause(locationId, "cw");
  const dates = dateClause(query.dateFrom, query.dateTo, "cw", "start_date");
  const bucket =
    typeof query.bucket === "string" &&
    ["valid", "expiring_soon", "expired", "all"].includes(query.bucket)
      ? query.bucket
      : "all";

  const bucketCondition =
    bucket === "all"
      ? sql``
      : bucket === "valid"
        ? sql` AND cw.expiry_date >= now() + INTERVAL '30 days'`
        : bucket === "expiring_soon"
          ? sql` AND cw.expiry_date >= now() AND cw.expiry_date < now() + INTERVAL '30 days'`
          : sql` AND cw.expiry_date < now()`;

  const countResult = await db.execute(sql`
    SELECT COUNT(*)::int AS total
    FROM customer_warranties cw
    WHERE cw.business_id = ${businessId}${loc}${dates}${bucketCondition}
  `);
  const total = Number((countResult.rows[0] as QueryRow | undefined)?.total ?? 0);

  const listResult = await db.execute(sql`
    SELECT
      cw.id,
      cw.warranty_number,
      cw.status,
      CASE
        WHEN cw.status <> 'active' THEN cw.status
        WHEN cw.expiry_date < now() THEN 'expired'
        WHEN cw.expiry_date < now() + INTERVAL '30 days' THEN 'expiring_soon'
        ELSE 'valid'
      END AS bucket,
      cw.serial_number,
      cw.quantity,
      cw.returned_quantity,
      cw.provider,
      cw.start_date,
      cw.expiry_date,
      s.invoice_number,
      c.name AS customer_name,
      p.name AS product_name,
      (SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
        FROM variant_values vv
        INNER JOIN variant_options vo ON vo.id = vv.option_id
        WHERE vv.variant_id = cw.variant_id) AS variant_label,
      l.name AS location_name
    FROM customer_warranties cw
    LEFT JOIN sales s ON s.id = cw.sale_id AND s.business_id = cw.business_id
    LEFT JOIN customers c ON c.id = cw.customer_id
    INNER JOIN products p ON p.id = cw.product_id
    LEFT JOIN locations l ON l.id = cw.location_id AND l.business_id = cw.business_id
    WHERE cw.business_id = ${businessId}${loc}${dates}${bucketCondition}
    ORDER BY cw.expiry_date ASC
    LIMIT ${limit} OFFSET ${(page - 1) * limit}
  `);

  return { data: listResult.rows, total, page, limit };
}

/**
 * Claims report: counts by status/type, units affected, per-product rows.
 * Claim rate = claims / covered units issued for that product (stated).
 */
export async function getClaimsReport(
  businessId: number,
  locationId: number | undefined,
  query: Record<string, unknown>,
) {
  const loc = locationClause(locationId, "wc");
  const dates = dateClause(query.dateFrom, query.dateTo, "wc", "created_at");

  const byStatus = await db.execute(sql`
    SELECT wc.status, wc.claim_type, COUNT(*)::int AS claim_count
    FROM warranty_claims wc
    WHERE wc.business_id = ${businessId}${loc}${dates}
    GROUP BY wc.status, wc.claim_type
    ORDER BY claim_count DESC
  `);

  const byProduct = await db.execute(sql`
    SELECT
      wc.product_id,
      p.name AS product_name,
      COUNT(*)::int AS claim_count,
      COUNT(DISTINCT wc.id)::int AS claims,
      COALESCE(SUM(CASE WHEN cw.serial_id IS NOT NULL THEN 1 ELSE cw.quantity END), 0)::int AS units_affected,
      COALESCE(SUM(wc.repair_cost), 0)::float8 AS repair_cost,
      (SELECT COALESCE(SUM(cw2.quantity), 0) FROM customer_warranties cw2
        WHERE cw2.business_id = ${businessId} AND cw2.product_id = wc.product_id) AS covered_units_issued
    FROM warranty_claims wc
    INNER JOIN customer_warranties cw ON cw.id = wc.warranty_id AND cw.business_id = wc.business_id
    INNER JOIN products p ON p.id = wc.product_id
    WHERE wc.business_id = ${businessId}${loc}${dates}
    GROUP BY wc.product_id, p.name
    ORDER BY claim_count DESC
  `);

  const productRows = byProduct.rows.map((raw) => {
    const row = raw as QueryRow;
    const claims = Number(row.claims ?? 0);
    const covered = Number(row.covered_units_issued ?? 0);
    return {
      productId: Number(row.product_id),
      productName: String(row.product_name ?? ""),
      claimCount: claims,
      unitsAffected: Number(row.units_affected ?? 0),
      repairCost: roundMoney(Number(row.repair_cost ?? 0)),
      coveredUnitsIssued: covered,
      // Stated denominator: covered units issued for the product.
      claimRate: covered > 0 ? roundMoney((claims / covered) * 100) : null,
    };
  });

  return {
    byStatus: byStatus.rows.map((raw) => {
      const row = raw as QueryRow;
      return {
        status: String(row.status ?? ""),
        claimType: String(row.claim_type ?? ""),
        claimCount: Number(row.claim_count ?? 0),
      };
    }),
    byProduct: productRows,
  };
}

/**
 * Cost report: the shop's warranty-related expense (repair cost recorded on
 * claims) vs the stock value of replacements given away.
 */
export async function getCostsReport(
  businessId: number,
  locationId: number | undefined,
  query: Record<string, unknown>,
) {
  const loc = locationClause(locationId, "wc");
  const dates = dateClause(query.dateFrom, query.dateTo, "wc", "created_at");

  const totals = await db.execute(sql`
    SELECT
      COALESCE(SUM(wc.repair_cost), 0)::float8 AS total_repair_cost,
      COUNT(*) FILTER (WHERE wc.resolution_type = 'replacement')::int AS replacements_given,
      COUNT(*) FILTER (WHERE wc.resolution_type = 'repair')::int AS repairs_done,
      COUNT(*) FILTER (WHERE wc.status = 'rejected')::int AS claims_rejected
    FROM warranty_claims wc
    WHERE wc.business_id = ${businessId}${loc}${dates}
  `);
  const totalRow = (totals.rows[0] ?? {}) as QueryRow;

  // Replacement stock value: each replacement claim is valued at the current
  // average landed cost of its replacement variant's batches.
  const replacementStockValue = await db.execute(sql`
    SELECT COALESCE(SUM(per_claim.value), 0)::float8 AS value
    FROM (
      SELECT wc.id,
        (SELECT COALESCE(AVG(ib.landed_cost_per_unit), 0)
         FROM inventory_batches ib
         WHERE ib.variant_id = wc.replacement_variant_id
           AND ib.business_id = wc.business_id) AS value
      FROM warranty_claims wc
      WHERE wc.business_id = ${businessId}
        AND wc.resolution_type = 'replacement'
        AND wc.replacement_variant_id IS NOT NULL
        ${locationId != null ? sql` AND wc.location_id = ${locationId}` : sql``}
    ) per_claim
  `);

  const perMonth = await db.execute(sql`
    SELECT
      date_trunc('month', wc.created_at)::date AS month,
      COALESCE(SUM(wc.repair_cost), 0)::float8 AS repair_cost,
      COUNT(*)::int AS claim_count
    FROM warranty_claims wc
    WHERE wc.business_id = ${businessId}${loc}${dates}
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT 24
  `);

  return {
    totalRepairCost: roundMoney(Number(totalRow.total_repair_cost ?? 0)),
    replacementsGiven: Number(totalRow.replacements_given ?? 0),
    repairsDone: Number(totalRow.repairs_done ?? 0),
    claimsRejected: Number(totalRow.claims_rejected ?? 0),
    replacementStockValue: roundMoney(
      Number((replacementStockValue.rows[0] as QueryRow | undefined)?.value ?? 0),
    ),
    perMonth: perMonth.rows.map((raw) => {
      const row = raw as QueryRow;
      return {
        month: row.month,
        repairCost: roundMoney(Number(row.repair_cost ?? 0)),
        claimCount: Number(row.claim_count ?? 0),
      };
    }),
  };
}

/**
 * Supplier recovery report: per supplier — claims, defective units,
 * replacements received, value recovered vs the shop's own warranty cost.
 */
export async function getSupplierRecoveryReport(
  businessId: number,
  locationId: number | undefined,
  query: Record<string, unknown>,
) {
  const loc = locationId != null ? sql` AND swc.location_id = ${locationId}` : sql``;
  const dates = dateClause(query.dateFrom, query.dateTo, "swc", "created_at");

  const result = await db.execute(sql`
    SELECT
      swc.supplier_id,
      sup.name AS supplier_name,
      COUNT(*)::int AS claim_count,
      COALESCE(SUM(swc.defective_quantity), 0)::int AS defective_units,
      COALESCE(SUM(swc.replacement_quantity), 0)::int AS replacement_units,
      COALESCE(SUM(swc.recovery_amount), 0)::float8 AS recovered_amount,
      COALESCE(SUM(swc.cost_amount), 0)::float8 AS shop_cost
    FROM supplier_warranty_claims swc
    INNER JOIN suppliers sup ON sup.id = swc.supplier_id
    WHERE swc.business_id = ${businessId}${loc}${dates}
    GROUP BY swc.supplier_id, sup.name
    ORDER BY recovered_amount DESC
  `);

  return result.rows.map((raw) => {
    const row = raw as QueryRow;
    const recovered = roundMoney(Number(row.recovered_amount ?? 0));
    const shopCost = roundMoney(Number(row.shop_cost ?? 0));
    return {
      supplierId: Number(row.supplier_id),
      supplierName: String(row.supplier_name ?? ""),
      claimCount: Number(row.claim_count ?? 0),
      defectiveUnits: Number(row.defective_units ?? 0),
      replacementUnits: Number(row.replacement_units ?? 0),
      recoveredAmount: recovered,
      shopCost,
      // Net supplier recovery: what the supplier gave back minus what the
      // shop spent chasing the warranty.
      netRecovery: roundMoney(recovered - shopCost),
    };
  });
}
