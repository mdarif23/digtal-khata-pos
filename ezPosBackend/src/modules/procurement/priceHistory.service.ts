import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { units } from "../../db/schema/units.js";
import { NotFoundError } from "../../utils/handleError.js";
import type {
  PriceHistoryQuery,
  PriceOverviewQuery,
} from "./schemas/priceHistory.schema.js";

/**
 * Product Price Intelligence (Smart Procurement Phase 1).
 *
 * Purchase price history is DERIVED at read time from the received
 * purchase lines — there is no separate history table to drift or
 * backfill. A "price event" is a purchase item with receivedQuantity > 0
 * whose purchase is `received` or `partially_received`; its price is
 * `purchase_items.unit_cost`, which the receiving flow sets to the actual
 * received unit cost. Drafts do not exist and unreceived lines are
 * excluded, so cancelled/undelivered quantities never enter history.
 * Partially received purchases contribute only their received quantity
 * (the average is weighted by received quantity).
 */

export interface PriceOverviewRow {
  variantId: number;
  sku: string | null;
  productId: number;
  productName: string;
  categoryName: string;
  unitName: string | null;
  latestPrice: number | null;
  previousPrice: number | null;
  lowestPrice: number;
  highestPrice: number;
  averagePrice: number | null;
  purchaseCount: number;
  totalReceivedQuantity: number;
  lastPurchaseDate: string | Date | null;
  lastSupplierId: number | null;
  lastSupplierName: string | null;
  priceChangePercent: number | null;
}

export interface SupplierPriceRow {
  supplierId: number | null;
  supplierName: string | null;
  latestPrice: number | null;
  previousPrice: number | null;
  lowestPrice: number;
  highestPrice: number;
  averagePrice: number | null;
  purchaseCount: number;
  lastPurchaseDate: string | Date | null;
  priceChangePercent: number | null;
  /** Latest recorded quotation from this supplier, normalized per unit. */
  latestQuotation: number | null;
  lastObservationDate: string | Date | null;
}

export interface ObservationRecord {
  id: number;
  observationDate: string;
  supplierId: number | null;
  supplierName: string | null;
  quotedPrice: number;
  packageQuantity: number | null;
  unitPrice: number | null;
  notes: string | null;
}

export interface PriceEventRecord {
  purchaseId: number;
  purchaseOrderNumber: string;
  purchaseDate: string | Date;
  supplierId: number | null;
  supplierName: string | null;
  unitCost: number;
  quantity: number;
  receivedQuantity: number;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface PriceHistoryDetail {
  variant: {
    variantId: number;
    productId: number;
    productName: string;
    sku: string | null;
    unitName: string | null;
    sellingPrice: number;
  };
  summary: {
    latestPrice: number | null;
    previousPrice: number | null;
    lowestPrice: number | null;
    highestPrice: number | null;
    averagePrice: number | null;
    purchaseCount: number;
    totalReceivedQuantity: number;
    lastPurchaseDate: string | Date | null;
    priceChangeAmount: number | null;
    priceChangePercent: number | null;
  };
  suppliers: SupplierPriceRow[];
  records: Paginated<PriceEventRecord>;
  /** Market quotations ("Quick Price Check") — always labeled as quotations. */
  observations: {
    data: ObservationRecord[];
    total: number;
  };
}

/**
 * The received price events CTE shared by every query in this module.
 * Filters (date range, supplier) prune events before aggregation so the
 * comparison always answers "for this range / this supplier".
 */
function receivedEventsCte(
  businessId: number,
  params: { from?: string | undefined; to?: string | undefined; supplierId?: number | undefined },
): SQL {
  return sql`
    WITH events AS (
      SELECT pi.id AS item_id,
             pi.variant_id,
             pi.unit_cost,
             pi.quantity,
             pi.received_quantity,
             p.id AS purchase_id,
             p.purchase_date,
             p.supplier_id
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi.purchase_id
      WHERE pi.business_id = ${businessId}
        AND p.business_id = ${businessId}
        AND pi.received_quantity > 0
        AND p.status IN ('received', 'partially_received')
        ${params.from ? sql`AND p.purchase_date >= ${params.from}::date` : sql``}
        ${params.to
          ? sql`AND p.purchase_date < (${params.to}::date + INTERVAL '1 day')`
          : sql``}
        ${params.supplierId ? sql`AND p.supplier_id = ${params.supplierId}` : sql``}
    )`;
}

function productFilters(
  params: { search?: string | undefined; categoryId?: number | undefined },
): SQL {
  const searchFilter = params.search ? `%${params.search}%` : null;
  return sql`
    ${params.categoryId ? sql`AND prod.category_id = ${params.categoryId}` : sql``}
    ${searchFilter
      ? sql`AND (prod.name ILIKE ${searchFilter} OR pv.sku ILIKE ${searchFilter})`
      : sql``}`;
}

function round2(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}

export async function getPriceOverview(
  businessId: number,
  params: PriceOverviewQuery,
): Promise<Paginated<PriceOverviewRow>> {
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;
  const events = receivedEventsCte(businessId, params);
  const filters = productFilters(params);

  const countQuery = await db.execute(sql`
    ${events}
    SELECT COUNT(DISTINCT e.variant_id)::int AS total
    FROM events e
    JOIN product_variants pv ON pv.id = e.variant_id
      AND pv.business_id = ${businessId}
    JOIN products prod ON prod.id = pv.product_id
    WHERE 1 = 1${filters}
  `);

  const listQuery = await db.execute(sql`
    ${events}
    SELECT
      pv.id AS "variantId",
      pv.sku,
      prod.id AS "productId",
      prod.name AS "productName",
      COALESCE(cat.name, 'Uncategorized') AS "categoryName",
      u.name AS "unitName",
      agg."lowestPrice",
      agg."highestPrice",
      agg."averagePrice",
      agg."purchaseCount",
      agg."totalReceivedQuantity",
      latest.unit_cost::float8 AS "latestPrice",
      latest.purchase_date AS "lastPurchaseDate",
      latest.supplier_id AS "lastSupplierId",
      latest.supplier_name AS "lastSupplierName",
      prev.unit_cost::float8 AS "previousPrice",
      CASE
        WHEN prev.unit_cost IS NOT NULL AND prev.unit_cost > 0
        THEN ROUND(((latest.unit_cost - prev.unit_cost) / prev.unit_cost * 100)::numeric, 2)::float8
        ELSE NULL
      END AS "priceChangePercent"
    FROM product_variants pv
    JOIN products prod ON prod.id = pv.product_id
    LEFT JOIN categories cat ON cat.id = prod.category_id
    LEFT JOIN units u ON u.id = prod.unit_id
    JOIN (
      SELECT variant_id,
             MIN(unit_cost)::float8 AS "lowestPrice",
             MAX(unit_cost)::float8 AS "highestPrice",
             ROUND((SUM(unit_cost * received_quantity) / NULLIF(SUM(received_quantity), 0))::numeric, 2)::float8 AS "averagePrice",
             COUNT(*)::int AS "purchaseCount",
             SUM(received_quantity)::float8 AS "totalReceivedQuantity"
      FROM events
      GROUP BY variant_id
    ) agg ON agg.variant_id = pv.id
    LEFT JOIN LATERAL (
      SELECT e.unit_cost, e.purchase_date, e.supplier_id, s.name AS supplier_name
      FROM events e
      LEFT JOIN suppliers s ON s.id = e.supplier_id
      WHERE e.variant_id = pv.id
      ORDER BY e.purchase_date DESC, e.item_id DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT e.unit_cost
      FROM events e
      WHERE e.variant_id = pv.id
      ORDER BY e.purchase_date DESC, e.item_id DESC
      OFFSET 1 LIMIT 1
    ) prev ON true
    WHERE pv.business_id = ${businessId}${filters}
    ORDER BY prod.name ASC, pv.sku ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    data: listQuery.rows as unknown as PriceOverviewRow[],
    total: Number(countQuery.rows[0]?.total ?? 0),
    page,
    limit,
  };
}

export async function getVariantPriceHistory(
  businessId: number,
  variantId: number,
  params: PriceHistoryQuery,
): Promise<PriceHistoryDetail> {
  const [variant] = await db
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      sku: productVariants.sku,
      unitName: units.name,
      sellingPrice: productVariants.sellingPrice,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(units, eq(units.id, products.unitId))
    .where(
      and(
        eq(productVariants.id, variantId),
        eq(productVariants.businessId, businessId),
      ),
    )
    .limit(1);
  if (!variant) throw new NotFoundError("Variant not found.");

  const events = receivedEventsCte(businessId, params);

  const summaryQuery = await db.execute(sql`
    ${events}
    SELECT
      (SELECT e.unit_cost FROM events e
       ORDER BY e.purchase_date DESC, e.item_id DESC LIMIT 1)::float8 AS "latestPrice",
      (SELECT e.unit_cost FROM events e
       ORDER BY e.purchase_date DESC, e.item_id DESC OFFSET 1 LIMIT 1)::float8 AS "previousPrice",
      MIN(e.unit_cost)::float8 AS "lowestPrice",
      MAX(e.unit_cost)::float8 AS "highestPrice",
      ROUND((SUM(e.unit_cost * e.received_quantity) / NULLIF(SUM(e.received_quantity), 0))::numeric, 2)::float8 AS "averagePrice",
      COUNT(*)::int AS "purchaseCount",
      COALESCE(SUM(e.received_quantity), 0)::float8 AS "totalReceivedQuantity",
      MAX(e.purchase_date) AS "lastPurchaseDate"
    FROM events e
  `);

  const supplierQuery = await db.execute(sql`
    ${events}
    SELECT
      e.supplier_id AS "supplierId",
      s.name AS "supplierName",
      (SELECT e2.unit_cost FROM events e2
       WHERE e2.supplier_id = e.supplier_id
       ORDER BY e2.purchase_date DESC, e2.item_id DESC LIMIT 1)::float8 AS "latestPrice",
      (SELECT e2.unit_cost FROM events e2
       WHERE e2.supplier_id = e.supplier_id
       ORDER BY e2.purchase_date DESC, e2.item_id DESC OFFSET 1 LIMIT 1)::float8 AS "previousPrice",
      MIN(e.unit_cost)::float8 AS "lowestPrice",
      MAX(e.unit_cost)::float8 AS "highestPrice",
      ROUND((SUM(e.unit_cost * e.received_quantity) / NULLIF(SUM(e.received_quantity), 0))::numeric, 2)::float8 AS "averagePrice",
      COUNT(*)::int AS "purchaseCount",
      MAX(e.purchase_date) AS "lastPurchaseDate",
      obs."latestQuotation",
      obs."lastObservationDate",
      CASE
        WHEN (SELECT e2.unit_cost FROM events e2 WHERE e2.supplier_id = e.supplier_id
              ORDER BY e2.purchase_date DESC, e2.item_id DESC OFFSET 1 LIMIT 1) > 0
        THEN ROUND((
              (SELECT e2.unit_cost FROM events e2 WHERE e2.supplier_id = e.supplier_id
               ORDER BY e2.purchase_date DESC, e2.item_id DESC LIMIT 1)
              - (SELECT e2.unit_cost FROM events e2 WHERE e2.supplier_id = e.supplier_id
                 ORDER BY e2.purchase_date DESC, e2.item_id DESC OFFSET 1 LIMIT 1))
              / (SELECT e2.unit_cost FROM events e2 WHERE e2.supplier_id = e.supplier_id
                 ORDER BY e2.purchase_date DESC, e2.item_id DESC OFFSET 1 LIMIT 1) * 100
            ::numeric, 2)::float8
        ELSE NULL
      END AS "priceChangePercent"
    FROM events e
    LEFT JOIN suppliers s ON s.id = e.supplier_id
    LEFT JOIN LATERAL (
      SELECT
        ROUND(CASE WHEN po.package_quantity IS NOT NULL AND po.package_quantity > 0
                   THEN po.quoted_price / po.package_quantity
                   ELSE po.quoted_price END::numeric, 2)::float8 AS "latestQuotation",
        po.observation_date AS "lastObservationDate"
      FROM price_observations po
      WHERE po.business_id = ${businessId}
        AND po.variant_id = ${variantId}
        AND po.supplier_id = e.supplier_id
      ORDER BY po.observation_date DESC, po.id DESC
      LIMIT 1
    ) obs ON true
    GROUP BY e.supplier_id, s.name, obs."latestQuotation", obs."lastObservationDate"
    ORDER BY 3 ASC NULLS LAST
  `);

  const observationsQuery = await db.execute(sql`
    SELECT
      po.id,
      po.observation_date AS "observationDate",
      po.supplier_id AS "supplierId",
      s.name AS "supplierName",
      po.quoted_price::float8 AS "quotedPrice",
      po.package_quantity::float8 AS "packageQuantity",
      ROUND(CASE WHEN po.package_quantity IS NOT NULL AND po.package_quantity > 0
                 THEN po.quoted_price / po.package_quantity
                 ELSE po.quoted_price END::numeric, 2)::float8 AS "unitPrice",
      po.notes
    FROM price_observations po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.business_id = ${businessId}
      AND po.variant_id = ${variantId}
    ORDER BY po.observation_date DESC, po.id DESC
    LIMIT 20
  `);
  const observationsCount = await db.execute(sql`
    SELECT COUNT(*)::int AS total
    FROM price_observations po
    WHERE po.business_id = ${businessId}
      AND po.variant_id = ${variantId}
  `);

  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const recordsCount = await db.execute(sql`
    ${events}
    SELECT COUNT(*)::int AS total FROM events e
  `);
  const recordsQuery = await db.execute(sql`
    ${events}
    SELECT
      e.purchase_id AS "purchaseId",
      p.purchase_order_number AS "purchaseOrderNumber",
      e.purchase_date,
      e.supplier_id AS "supplierId",
      s.name AS "supplierName",
      e.unit_cost::float8 AS "unitCost",
      e.quantity::float8 AS "quantity",
      e.received_quantity::float8 AS "receivedQuantity"
    FROM events e
    JOIN purchases p ON p.id = e.purchase_id
    LEFT JOIN suppliers s ON s.id = e.supplier_id
    ORDER BY e.purchase_date DESC, e.item_id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const summaryRow = summaryQuery.rows[0] as {
    latestPrice: number | null;
    previousPrice: number | null;
    lowestPrice: number | null;
    highestPrice: number | null;
    averagePrice: number | null;
    purchaseCount: number;
    totalReceivedQuantity: number;
    lastPurchaseDate: string | Date | null;
  };

  const changeAmount =
    summaryRow.latestPrice !== null && summaryRow.previousPrice !== null
      ? round2(summaryRow.latestPrice - summaryRow.previousPrice)
      : null;
  const changePercent =
    changeAmount !== null && summaryRow.previousPrice !== null && summaryRow.previousPrice > 0
      ? Number(((changeAmount / summaryRow.previousPrice) * 100).toFixed(2))
      : null;

  return {
    variant: {
      variantId: variant.variantId,
      productId: variant.productId,
      productName: variant.productName,
      sku: variant.sku,
      unitName: variant.unitName,
      sellingPrice: Number(variant.sellingPrice),
    },
    summary: {
      latestPrice: summaryRow.latestPrice,
      previousPrice: summaryRow.previousPrice,
      lowestPrice: summaryRow.lowestPrice,
      highestPrice: summaryRow.highestPrice,
      averagePrice: summaryRow.averagePrice,
      purchaseCount: summaryRow.purchaseCount,
      totalReceivedQuantity: summaryRow.totalReceivedQuantity,
      lastPurchaseDate: summaryRow.lastPurchaseDate,
      priceChangeAmount: changeAmount,
      priceChangePercent: changePercent,
    },
    suppliers: supplierQuery.rows as unknown as SupplierPriceRow[],
    records: {
      data: recordsQuery.rows as unknown as PriceEventRecord[],
      total: Number(recordsCount.rows[0]?.total ?? 0),
      page,
      limit,
    },
    observations: {
      data: observationsQuery.rows as unknown as ObservationRecord[],
      total: Number(observationsCount.rows[0]?.total ?? 0),
    },
  };
}
