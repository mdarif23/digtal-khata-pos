import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import type { ReorderSuggestion } from "../reorder/reorder.service.js";

/**
 * Smart Reorder Planning (Smart Procurement Phase 4).
 *
 * One read-time computation feeds BOTH the reorder suggestions endpoint
 * (Module 2C, refactored to delegate here) and the reorder dashboard — a
 * single inventory rule, never two conflicting ones:
 *
 *   available = (current stock − reserved) + outstanding POs + in-transit
 *   transfers inbound to the location
 *
 * Suggestions and the dashboard derive from `product_variants` monitoring
 * settings: a variant is monitored when it has a reorder point OR a
 * positive alert quantity. Suggested quantities honor the configured
 * reorder quantity; without one, the shortfall to the reorder point is
 * proposed — and when neither is configured nothing is invented (the
 * buyer decides). Estimation uses the last actual received unit cost.
 */

export type ReorderStatus =
  | "out_of_stock"
  | "low_stock"
  | "needs_reorder"
  | "healthy";

export interface ReorderRow {
  variantId: number;
  productId: number;
  productName: string;
  sku: string | null;
  categoryName: string;
  unitName: string | null;
  currentStock: number;
  reservedQuantity: number;
  outstandingOnOrder: number;
  inTransitQuantity: number;
  availableQuantity: number;
  reorderPoint: number | null;
  reorderQuantity: number | null;
  alertQuantity: number;
  status: ReorderStatus;
  suggestedQuantity: number | null;
  lastUnitCost: number | null;
  estimatedValue: number | null;
  lastSupplierId: number | null;
  lastSupplierName: string | null;
}

export interface ReorderDashboardSummary {
  outOfStock: number;
  lowStock: number;
  needsReorder: number;
  attentionCount: number;
  noSupplierCount: number;
  missingPriceCount: number;
  totalEstimatedValue: number;
  supplierCount: number;
}

export interface SupplierReorderGroup {
  supplierId: number | null;
  supplierName: string | null;
  itemCount: number;
  totalQuantity: number;
  estimatedValue: number;
  minimumOrderValue: number | null;
  targetOrderValue: number | null;
}

export type ReorderStatusFilter =
  | "all"
  | "attention"
  | "out_of_stock"
  | "low_stock"
  | "needs_reorder"
  | "healthy";

/** The shared metrics CTE: every monitored variant with full netting. */
function reorderBaseCte(businessId: number, locationId: number): SQL {
  return sql`
    WITH metrics AS (
      SELECT
        pv.id AS variant_id,
        prod.id AS product_id,
        prod.name AS product_name,
        pv.sku,
        COALESCE(cat.name, 'Uncategorized') AS category_name,
        u.name AS unit_name,
        COALESCE(st.quantity, 0) AS current_stock,
        COALESCE(st.reserved_quantity, 0) AS reserved_quantity,
        COALESCE(o.qty, 0) AS on_order,
        COALESCE(it.qty, 0) AS in_transit,
        GREATEST(COALESCE(st.quantity, 0) - COALESCE(st.reserved_quantity, 0), 0)
          + COALESCE(o.qty, 0) + COALESCE(it.qty, 0) AS available,
        pv.reorder_point,
        pv.reorder_quantity,
        COALESCE(pv.alert_quantity, 0) AS alert_quantity,
        lp.unit_cost AS last_unit_cost,
        lp.supplier_id AS last_supplier_id,
        s.name AS last_supplier_name,
        CASE
          WHEN COALESCE(pv.reorder_quantity, 0) > 0 THEN pv.reorder_quantity
          WHEN pv.reorder_point IS NOT NULL THEN GREATEST(
            pv.reorder_point - (GREATEST(COALESCE(st.quantity, 0) - COALESCE(st.reserved_quantity, 0), 0)
              + COALESCE(o.qty, 0) + COALESCE(it.qty, 0)), 1)
          ELSE NULL
        END AS suggested,
        CASE
          WHEN COALESCE(st.quantity, 0) <= 0 THEN 'out_of_stock'
          WHEN COALESCE(pv.alert_quantity, 0) > 0
            AND COALESCE(st.quantity, 0) <= COALESCE(pv.alert_quantity, 0) THEN 'low_stock'
          WHEN pv.reorder_point IS NOT NULL
            AND (GREATEST(COALESCE(st.quantity, 0) - COALESCE(st.reserved_quantity, 0), 0)
              + COALESCE(o.qty, 0) + COALESCE(it.qty, 0)) <= pv.reorder_point THEN 'needs_reorder'
          ELSE 'healthy'
        END AS status
      FROM product_variants pv
      JOIN products prod ON prod.id = pv.product_id
      LEFT JOIN categories cat ON cat.id = prod.category_id
      LEFT JOIN units u ON u.id = prod.unit_id
      LEFT JOIN inventory_stock st ON st.variant_id = pv.id
        AND st.business_id = ${businessId} AND st.location_id = ${locationId}
      LEFT JOIN (
        SELECT pi.variant_id,
               SUM(pi.quantity - pi.received_quantity - pi."cancelled_quantity   ") AS qty
        FROM purchase_items pi
        JOIN purchases p ON p.id = pi.purchase_id
        WHERE pi.business_id = ${businessId}
          AND p.business_id = ${businessId}
          AND p.status NOT IN ('received')
        GROUP BY pi.variant_id
      ) o ON o.variant_id = pv.id
      LEFT JOIN (
        SELECT sti.variant_id,
               SUM(sti.quantity_shipped - sti.quantity_received) AS qty
        FROM stock_transfer_items sti
        JOIN stock_transfers stt ON stt.id = sti.transfer_id
        WHERE sti.business_id = ${businessId}
          AND stt.business_id = ${businessId}
          AND stt.to_location_id = ${locationId}
          AND stt.status IN ('shipped', 'partially_received')
        GROUP BY sti.variant_id
      ) it ON it.variant_id = pv.id
      LEFT JOIN (
        SELECT DISTINCT ON (pi.variant_id)
          pi.variant_id, pi.unit_cost, p.supplier_id
        FROM purchase_items pi
        JOIN purchases p ON p.id = pi.purchase_id
        WHERE pi.business_id = ${businessId}
          AND p.business_id = ${businessId}
        ORDER BY pi.variant_id, p.id DESC, pi.id DESC
      ) lp ON lp.variant_id = pv.id
      LEFT JOIN suppliers s ON s.id = lp.supplier_id
      WHERE pv.business_id = ${businessId}
        AND (pv.reorder_point IS NOT NULL OR COALESCE(pv.alert_quantity, 0) > 0)
    )`;
}

function statusFilterSql(status: ReorderStatusFilter | undefined): SQL {
  switch (status) {
    case "attention":
      return sql` AND m.status <> 'healthy'`;
    case "out_of_stock":
    case "low_stock":
    case "needs_reorder":
    case "healthy":
      return sql` AND m.status = ${status}`;
    default:
      return sql``;
  }
}

function searchFilterSql(search: string | undefined): SQL {
  const needle = search ? `%${search}%` : null;
  return needle
    ? sql` AND (m.product_name ILIKE ${needle} OR m.sku ILIKE ${needle})`
    : sql``;
}

interface MetricsRow {
  variantId: number;
  productId: number;
  productName: string;
  sku: string | null;
  categoryName: string;
  unitName: string | null;
  currentStock: number;
  reservedQuantity: number;
  outstandingOnOrder: number;
  inTransitQuantity: number;
  availableQuantity: number;
  reorderPoint: number | null;
  reorderQuantity: number | null;
  alertQuantity: number;
  status: ReorderStatus;
  suggestedQuantity: number | null;
  lastUnitCost: number | null;
  estimatedValue: number | null;
  lastSupplierId: number | null;
  lastSupplierName: string | null;
}

const METRICS_SELECT = sql`
  SELECT
    m.variant_id AS "variantId",
    m.product_id AS "productId",
    m.product_name AS "productName",
    m.sku,
    m.category_name AS "categoryName",
    m.unit_name AS "unitName",
    m.current_stock::float8 AS "currentStock",
    m.reserved_quantity::float8 AS "reservedQuantity",
    m.on_order::float8 AS "outstandingOnOrder",
    m.in_transit::float8 AS "inTransitQuantity",
    m.available::float8 AS "availableQuantity",
    m.reorder_point AS "reorderPoint",
    m.reorder_quantity AS "reorderQuantity",
    m.alert_quantity::float8 AS "alertQuantity",
    m.status AS "status",
    m.suggested::float8 AS "suggestedQuantity",
    m.last_unit_cost::float8 AS "lastUnitCost",
    CASE WHEN m.suggested IS NOT NULL AND m.last_unit_cost IS NOT NULL
         THEN ROUND(m.suggested * m.last_unit_cost, 2)::float8
         ELSE NULL END AS "estimatedValue",
    m.last_supplier_id AS "lastSupplierId",
    m.last_supplier_name AS "lastSupplierName"
  FROM metrics m`;

/** All monitored variants for a location with the full netting applied. */
export async function computeReorderRows(
  businessId: number,
  locationId: number,
): Promise<ReorderRow[]> {
  const result = await db.execute(sql`
    ${reorderBaseCte(businessId, locationId)}
    ${METRICS_SELECT}
    ORDER BY CASE m.status
        WHEN 'out_of_stock' THEN 0
        WHEN 'low_stock' THEN 1
        WHEN 'needs_reorder' THEN 2
        ELSE 3
      END ASC,
      m.product_name ASC, m.sku ASC
  `);
  return result.rows as unknown as ReorderRow[];
}

export async function getReorderDashboard(
  businessId: number,
  locationId: number,
  params: {
    page: number;
    limit: number;
    search?: string | undefined;
    status?: ReorderStatusFilter | undefined;
  },
): Promise<{
  summary: ReorderDashboardSummary;
  suppliers: SupplierReorderGroup[];
  data: ReorderRow[];
  total: number;
  page: number;
  limit: number;
}> {
  const base = reorderBaseCte(businessId, locationId);
  const filters = sql`${statusFilterSql(params.status)}${searchFilterSql(params.search)}`;

  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const [countResult, rowsResult, summaryResult, suppliersResult] =
    await Promise.all([
      db.execute(sql`
        ${base}
        SELECT COUNT(*)::int AS total
        FROM metrics m
        WHERE 1 = 1${filters}
      `),
      db.execute(sql`
        ${base}
        ${METRICS_SELECT}
        WHERE 1 = 1${filters}
        ORDER BY CASE m.status
            WHEN 'out_of_stock' THEN 0
            WHEN 'low_stock' THEN 1
            WHEN 'needs_reorder' THEN 2
            ELSE 3
          END ASC,
          m.product_name ASC, m.sku ASC
        LIMIT ${limit} OFFSET ${offset}
      `),
      db.execute(sql`
        ${base}
        SELECT
          COUNT(*) FILTER (WHERE m.status = 'out_of_stock')::int AS "outOfStock",
          COUNT(*) FILTER (WHERE m.status = 'low_stock')::int AS "lowStock",
          COUNT(*) FILTER (WHERE m.status = 'needs_reorder')::int AS "needsReorder",
          COUNT(*) FILTER (WHERE m.status <> 'healthy')::int AS "attentionCount",
          COUNT(*) FILTER (WHERE m.status <> 'healthy' AND m.last_supplier_id IS NULL)::int AS "noSupplierCount",
          COUNT(*) FILTER (WHERE m.status <> 'healthy' AND (m.last_unit_cost IS NULL OR m.last_unit_cost = 0))::int AS "missingPriceCount",
          COALESCE(SUM(CASE WHEN m.status <> 'healthy'
            THEN ROUND(m.suggested * m.last_unit_cost, 2) END), 0)::float8 AS "totalEstimatedValue",
          COUNT(DISTINCT CASE WHEN m.status <> 'healthy' THEN m.last_supplier_id END)::int AS "supplierCount"
        FROM metrics m
      `),
      db.execute(sql`
        ${base}
        SELECT
          m.last_supplier_id AS "supplierId",
          s.name AS "supplierName",
          COUNT(*)::int AS "itemCount",
          COALESCE(SUM(m.suggested), 0)::float8 AS "totalQuantity",
          COALESCE(SUM(ROUND(m.suggested * m.last_unit_cost, 2)), 0)::float8 AS "estimatedValue",
          s.minimum_order_value::float8 AS "minimumOrderValue",
          s.target_order_value::float8 AS "targetOrderValue"
        FROM metrics m
        LEFT JOIN suppliers s ON s.id = m.last_supplier_id
        WHERE m.status <> 'healthy' AND m.suggested IS NOT NULL
          AND m.last_supplier_id IS NOT NULL
        GROUP BY m.last_supplier_id, s.name, s.minimum_order_value, s.target_order_value
        ORDER BY 4 DESC
      `),
    ]);

  const summaryRow = summaryResult.rows[0] as {
    outOfStock: number;
    lowStock: number;
    needsReorder: number;
    attentionCount: number;
    noSupplierCount: number;
    missingPriceCount: number;
    totalEstimatedValue: number;
    supplierCount: number;
  };

  return {
    summary: {
      outOfStock: Number(summaryRow?.outOfStock ?? 0),
      lowStock: Number(summaryRow?.lowStock ?? 0),
      needsReorder: Number(summaryRow?.needsReorder ?? 0),
      attentionCount: Number(summaryRow?.attentionCount ?? 0),
      noSupplierCount: Number(summaryRow?.noSupplierCount ?? 0),
      missingPriceCount: Number(summaryRow?.missingPriceCount ?? 0),
      totalEstimatedValue: Number(summaryRow?.totalEstimatedValue ?? 0),
      supplierCount: Number(summaryRow?.supplierCount ?? 0),
    },
    suppliers: suppliersResult.rows as unknown as SupplierReorderGroup[],
    data: rowsResult.rows as unknown as ReorderRow[],
    total: Number(countResult.rows[0]?.total ?? 0),
    page,
    limit,
  };
}

/**
 * Maps the shared computation onto the Module 2C suggestion shape. The
 * candidate rule is unchanged: a variant is suggested when its netted
 * availability has reached the reorder point.
 */
export function rowsToSuggestions(
  rows: ReorderRow[],
): ReorderSuggestion[] {
  return rows
    .filter((row) => row.status === "needs_reorder")
    .map((row) => ({
      variantId: row.variantId,
      productId: row.productId,
      productName: row.productName,
      sku: row.sku,
      currentStock: row.currentStock,
      outstandingOnOrder: row.outstandingOnOrder,
      reorderPoint: row.reorderPoint ?? 0,
      reorderQuantity: row.reorderQuantity,
      suggestedQuantity:
        row.suggestedQuantity === null
          ? Math.max(1, (row.reorderPoint ?? 0) - row.availableQuantity)
          : row.suggestedQuantity,
      lastSupplierId: row.lastSupplierId,
      lastSupplierName: row.lastSupplierName,
      lastUnitCost: row.lastUnitCost,
    }));
}
