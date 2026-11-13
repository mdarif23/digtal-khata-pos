import { sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { variantOptionsJoinSql, variantNameSql } from "../../utils/variantDisplay.js";

// Every function takes the caller's server-verified businessId (from
// requireBusinessContext) and injects it into every raw-SQL fragment so no
// dashboard aggregate can cross businesses.

export const dashboardPeriods = [
  "today",
  "yesterday",
  "7d",
  "30d",
  "60d",
  "90d",
  "365d",
] as const;
export type DashboardPeriod = (typeof dashboardPeriods)[number];

function getPeriodDays(period: DashboardPeriod): number {
  if (period === "today" || period === "yesterday") return 1;
  return Number(period.slice(0, -1));
}

/**
 * Business timezone (businesses.timezone, default Asia/Dhaka) as an inline
 * scalar subquery — businessId is a bound parameter, so the planner evaluates
 * it once as an InitPlan, not per row.
 */
function tzOf(businessId: number) {
  return sql`(SELECT timezone FROM businesses WHERE id = ${businessId} LIMIT 1)`;
}

/** The business-LOCAL calendar date (as a naive date/timestamp expression). */
function localToday(businessId: number) {
  return sql`(NOW() AT TIME ZONE ${tzOf(businessId)})::date`;
}

/**
 * Period boundaries are BUSINESS-LOCAL day boundaries converted to
 * timestamptz. Comparing `created_at` (timestamptz) against these pins the
 * exact same calendar the Finance ledger posts in — a 00:30 local sale lands
 * on the local day it belongs to, not the UTC one.
 */
function getCurrentPeriodStart(period: DashboardPeriod, businessId: number) {
  const days = getPeriodDays(period);
  const tz = tzOf(businessId);
  const localStart = sql`CASE
    WHEN ${period} = 'today' THEN ${localToday(businessId)}
    WHEN ${period} = 'yesterday' THEN ${localToday(businessId)} - INTERVAL '1 day'
    ELSE ${localToday(businessId)} - ((${days} - 1) * INTERVAL '1 day')
  END`;
  return sql`(${localStart}) AT TIME ZONE ${tz}`;
}

function getCurrentPeriodEnd(period: DashboardPeriod, businessId: number) {
  const tz = tzOf(businessId);
  const localEnd =
    period === "yesterday"
      ? localToday(businessId)
      : sql`${localToday(businessId)} + INTERVAL '1 day'`;
  return sql`(${localEnd}) AT TIME ZONE ${tz}`;
}

function getPreviousPeriodStart(period: DashboardPeriod, businessId: number) {
  const days = getPeriodDays(period);
  const tz = tzOf(businessId);
  const localPrev = sql`CASE
    WHEN ${period} = 'today' THEN ${localToday(businessId)} - INTERVAL '1 day'
    WHEN ${period} = 'yesterday' THEN ${localToday(businessId)} - INTERVAL '2 day'
    ELSE ${localToday(businessId)} - ((${days} - 1 + ${days}) * INTERVAL '1 day')
  END`;
  return sql`(${localPrev}) AT TIME ZONE ${tz}`;
}

/**
 * Optional location scope for dashboard queries — the same convention as the
 * reports module: undefined = business-wide, a value narrows to one
 * location's rows (access is validated in the controller, never here).
 */
function locFilter(
  qualified: string,
  locationId: number | undefined,
) {
  if (locationId === undefined) return sql``;
  return sql` AND ${sql.raw(qualified)}.location_id = ${locationId}`;
}


export function getSalesOverview(businessId: number, period: DashboardPeriod, locationId?: number) {
  // Buckets truncate the business-LOCAL wall clock. The timezone is joined
  // once as a CTE: Postgres cannot GROUP BY an expression containing a
  // subquery, so the bucket expression must reference biz.timezone instead.
  const bucket = (tzRef: string) =>
    period === "today" || period === "yesterday"
      ? sql`DATE_TRUNC('hour', created_at AT TIME ZONE biz.${sql.raw(tzRef)})`
      : getPeriodDays(period) <= 30
        ? sql`DATE_TRUNC('day', created_at AT TIME ZONE biz.${sql.raw(tzRef)})`
        : getPeriodDays(period) <= 90
          ? sql`DATE_TRUNC('week', created_at AT TIME ZONE biz.${sql.raw(tzRef)})`
          : sql`DATE_TRUNC('month', created_at AT TIME ZONE biz.${sql.raw(tzRef)})`;
  const label =
    period === "today" || period === "yesterday"
      ? sql`'HH24:00'`
      : getPeriodDays(period) <= 30
        ? sql`'Dy DD'`
        : getPeriodDays(period) <= 90
          ? sql`'DD Mon'`
          : sql`'Mon YY'`;
  return db.execute(sql`
    WITH biz AS (
      SELECT timezone FROM businesses WHERE id = ${businessId} LIMIT 1
    ),
    buckets AS (
      SELECT
        ${bucket("timezone")} AS bucket,
        COALESCE(SUM(final_total), 0) AS gross,
        COALESCE(
          SUM(CASE WHEN payment_status = 'paid' THEN final_total ELSE 0 END),
          0
        ) AS cash
      FROM sales
      CROSS JOIN biz
      WHERE sales.business_id = ${businessId}${locFilter("sales", locationId)}
        AND status IN ('completed', 'refunded')
        AND sales.created_at >= ${getCurrentPeriodStart(period, businessId)}
        AND sales.created_at < ${getCurrentPeriodEnd(period, businessId)}
      GROUP BY biz.timezone, ${bucket("timezone")}
    ),
    refund_buckets AS (
      SELECT
        ${bucket("timezone")} AS bucket,
        COALESCE(SUM(refund_total), 0) AS refunded
      FROM sale_refunds
      CROSS JOIN biz
      WHERE sale_refunds.business_id = ${businessId}${locFilter("sale_refunds", locationId)}
        AND sale_refunds.created_at >= ${getCurrentPeriodStart(period, businessId)}
        AND sale_refunds.created_at < ${getCurrentPeriodEnd(period, businessId)}
      GROUP BY biz.timezone, ${bucket("timezone")}
    )
    SELECT
      TO_CHAR(buckets.bucket, ${label}) AS month,
      (buckets.gross - COALESCE(refund_buckets.refunded, 0)) AS sales,
      buckets.cash AS cash
    FROM buckets
    LEFT JOIN refund_buckets ON refund_buckets.bucket = buckets.bucket
    ORDER BY buckets.bucket
  `);
}


export function getTopCategories(businessId: number, period: DashboardPeriod, locationId?: number) {
  return db.execute(sql`
    SELECT
      COALESCE(c.name, 'Uncategorized') AS category,
      COALESCE(SUM(si.quantity), 0) AS sold_items_by_category
    FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id
    INNER JOIN product_variants pv ON pv.id = si.variant_id
    INNER JOIN products p ON p.id = pv.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE s.business_id = ${businessId}${locFilter("s", locationId)}
      AND s.status IN ('completed', 'refunded')
      AND s.created_at >= ${getCurrentPeriodStart(period, businessId)}
      AND s.created_at < ${getCurrentPeriodEnd(period, businessId)}
    GROUP BY c.name
    ORDER BY sold_items_by_category DESC
    LIMIT 5
  `);
}


export function getProfitByCategory(businessId: number, period: DashboardPeriod, locationId?: number) {
  // Refund netting (refund-date attribution, same policy as getNetProfit):
  // the profit of refunded units is subtracted for refunds that HAPPENED in
  // the window, so this widget reconciles with the net-profit card instead of
  // counting refunded sales at full profit.
  return db.execute(sql`
    SELECT
      COALESCE(c.name, 'Uncategorized') AS category,
      COALESCE(SUM((si.selling_price - si.cost_at_sale) * si.quantity), 0)
        - COALESCE(refund_effect.refund_profit, 0)
        AS current_month_profit
    FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id
    INNER JOIN product_variants pv ON pv.id = si.variant_id
    INNER JOIN products p ON p.id = pv.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN (
      SELECT sri.sale_item_id,
             SUM(sri.quantity * (si2.selling_price - si2.cost_at_sale)) AS refund_profit
      FROM sale_refund_items sri
      INNER JOIN sale_refunds sr ON sr.id = sri.refund_id
      INNER JOIN sale_items si2 ON si2.id = sri.sale_item_id
      WHERE sr.business_id = ${businessId}
        AND sr.created_at >= ${getCurrentPeriodStart(period, businessId)}
        AND sr.created_at < ${getCurrentPeriodEnd(period, businessId)}
      GROUP BY sri.sale_item_id
    ) refund_effect ON refund_effect.sale_item_id = si.id
    WHERE s.business_id = ${businessId}${locFilter("s", locationId)}
      AND s.status IN ('completed', 'refunded')
      AND s.created_at >= ${getCurrentPeriodStart(period, businessId)}
      AND s.created_at < ${getCurrentPeriodEnd(period, businessId)}
    GROUP BY c.name, refund_effect.refund_profit
    ORDER BY current_month_profit DESC
    LIMIT 5
  `);
}


export function getTopItemsByGross(businessId: number, period: DashboardPeriod, locationId?: number) {
  // Variant-level: each row is one variant (Football (Small)), so the gross
  // of Small/Medium/Big stays distinguishable. The frontend aggregates the
  // rows per product when it wants a product-level rollup.
  return db.execute(sql`
    SELECT
      p.id AS product_id,
      p.name AS product_name,
      pv.id AS variant_id,
      ${variantNameSql(sql`p.name`, sql`vol.option_label`)} AS variant_name,
      vol.option_label AS variant_options,
      pv.sku AS sku,
      COALESCE(SUM(
        CASE
          WHEN s.created_at >= ${getCurrentPeriodStart(period, businessId)}
            AND s.created_at < ${getCurrentPeriodEnd(period, businessId)}
          THEN si.line_total
          ELSE 0
        END
      ), 0) AS current_month_gross,
      COALESCE(SUM(
        CASE
          WHEN s.created_at >= ${getCurrentPeriodStart(period, businessId)}
            AND s.created_at < ${getCurrentPeriodEnd(period, businessId)}
          THEN si.quantity
          ELSE 0
        END
      ), 0) AS current_month_quantity,
      COALESCE(SUM(
        CASE
          WHEN s.created_at >= ${getPreviousPeriodStart(period, businessId)}
            AND s.created_at < ${getCurrentPeriodStart(period, businessId)}
          THEN si.line_total
          ELSE 0
        END
      ), 0) AS last_month_gross,
      CASE
        WHEN SUM(
          CASE
            WHEN s.created_at >= ${getCurrentPeriodStart(period, businessId)}
              AND s.created_at < ${getCurrentPeriodEnd(period, businessId)}
            THEN si.line_total
            ELSE 0
          END
        ) > SUM(
          CASE
            WHEN s.created_at >= ${getPreviousPeriodStart(period, businessId)}
              AND s.created_at < ${getCurrentPeriodStart(period, businessId)}
            THEN si.line_total
            ELSE 0
          END
        ) THEN 'up'
        WHEN SUM(
          CASE
            WHEN s.created_at >= ${getCurrentPeriodStart(period, businessId)}
              AND s.created_at < ${getCurrentPeriodEnd(period, businessId)}
            THEN si.line_total
            ELSE 0
          END
        ) < SUM(
          CASE
            WHEN s.created_at >= ${getPreviousPeriodStart(period, businessId)}
              AND s.created_at < ${getCurrentPeriodStart(period, businessId)}
            THEN si.line_total
            ELSE 0
          END
        ) THEN 'down'
        ELSE 'steady'
      END AS trend
    FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id
    INNER JOIN product_variants pv ON pv.id = si.variant_id
    INNER JOIN products p ON p.id = pv.product_id
    ${variantOptionsJoinSql("pv", "vol")}
    WHERE s.business_id = ${businessId}${locFilter("s", locationId)}
      AND s.status IN ('completed', 'refunded')
      AND s.created_at >= ${getPreviousPeriodStart(period, businessId)}
      AND s.created_at < ${getCurrentPeriodEnd(period, businessId)}
    GROUP BY p.id, p.name, pv.id, pv.sku, vol.option_label
    ORDER BY current_month_gross DESC
    LIMIT 10
  `);
}


export function getProductsSummary(businessId: number, locationId?: number) {
  return db.execute(sql`
    WITH stock_summary AS (
      SELECT
        COUNT(pv.id) FILTER (
          WHERE COALESCE(stock.quantity, 0) > 0
            AND COALESCE(stock.quantity, 0) <= COALESCE(pv.alert_quantity, 0)
        ) AS low_stock,
        COUNT(pv.id) FILTER (
          WHERE COALESCE(stock.quantity, 0) <= 0
        ) AS stock_out,
        COALESCE(SUM(COALESCE(stock.quantity, 0)), 0) AS total_items
      FROM product_variants pv
      LEFT JOIN (
        -- Pre-aggregated per variant so a variant stocked in several
        -- locations is counted once, not once per stock row.
        SELECT variant_id, SUM(quantity) AS quantity
        FROM inventory_stock
        WHERE business_id = ${businessId}${locFilter("inventory_stock", locationId)}
        GROUP BY variant_id
      ) stock ON stock.variant_id = pv.id
      WHERE pv.business_id = ${businessId}
    ),
    stock_valuation AS (
      SELECT COALESCE(
        SUM(quantity_remaining * landed_cost_per_unit),
        0
      ) AS total_valuation
      FROM inventory_batches
      WHERE business_id = ${businessId}${locFilter("inventory_batches", locationId)}
    )
    SELECT
      stock_summary.low_stock,
      stock_summary.stock_out,
      stock_summary.total_items,
      stock_valuation.total_valuation
    FROM stock_summary
    CROSS JOIN stock_valuation
  `);
}


export function getSalesSummary(businessId: number, period: DashboardPeriod, locationId?: number) {
  return db.execute(sql`
    WITH period_sales AS (
      SELECT
        COALESCE(SUM(final_total) FILTER (
          WHERE created_at >= ${getCurrentPeriodStart(period, businessId)}
            AND created_at < ${getCurrentPeriodEnd(period, businessId)}
        ), 0) AS current_sales,
        COALESCE(SUM(final_total) FILTER (
          WHERE created_at >= ${getPreviousPeriodStart(period, businessId)}
            AND created_at < ${getCurrentPeriodStart(period, businessId)}
        ), 0) AS previous_sales
      FROM sales
      WHERE business_id = ${businessId}${locFilter("sales", locationId)}
        AND status IN ('completed', 'refunded')
    ),
    period_refunds AS (
      SELECT
        COALESCE(SUM(refund_total) FILTER (
          WHERE created_at >= ${getCurrentPeriodStart(period, businessId)}
            AND created_at < ${getCurrentPeriodEnd(period, businessId)}
        ), 0) AS current_return,
        COALESCE(SUM(refund_total) FILTER (
          WHERE created_at >= ${getPreviousPeriodStart(period, businessId)}
            AND created_at < ${getCurrentPeriodStart(period, businessId)}
        ), 0) AS previous_return
      FROM sale_refunds
      WHERE business_id = ${businessId}${locFilter("sale_refunds", locationId)}
    )
    SELECT
      current_sales - current_return AS current_net_sales,
      CASE
        WHEN previous_sales - previous_return = 0 THEN 0
        ELSE ROUND(
          (((current_sales - current_return) -
            (previous_sales - previous_return)) /
            (previous_sales - previous_return) * 100)::numeric,
          2
        )
      END AS sales_growth,
      current_return,
      CASE
        WHEN previous_return = 0 THEN 0
        ELSE ROUND(
          ((current_return - previous_return) / previous_return * 100)::numeric,
          2
        )
      END AS return_growth
    FROM period_sales
    CROSS JOIN period_refunds
  `);
}


export function getSalesActivity(businessId: number, period: DashboardPeriod, locationId?: number) {
  return db.execute(sql`
    SELECT
      COUNT(*) AS transaction_count,
      COALESCE(AVG(final_total), 0) AS average_sale
    FROM sales
    WHERE business_id = ${businessId}${locFilter("sales", locationId)}
      AND status IN ('completed', 'refunded')
      AND created_at >= ${getCurrentPeriodStart(period, businessId)}
      AND created_at < ${getCurrentPeriodEnd(period, businessId)}
  `);
}


export function getPaymentBreakdown(businessId: number, period: DashboardPeriod, locationId?: number) {
  // sale_payments carries no location: when a location scope is requested,
  // payments are scoped through their sale's location (inner join — payments
  // always belong to a sale in this business).
  const paymentsSource =
    locationId === undefined
      ? sql`sale_payments`
      : sql`(SELECT sp.* FROM sale_payments sp INNER JOIN sales s ON s.id = sp.sale_id AND s.business_id = sp.business_id WHERE s.location_id = ${locationId}) sale_payments`;
  return db.execute(sql`
    SELECT
      payment_method AS method,
      COALESCE(SUM(amount), 0) AS amount,
      COUNT(*) AS payment_count
    FROM ${paymentsSource}
    WHERE business_id = ${businessId}
      AND payment_date >= ${getCurrentPeriodStart(period, businessId)}
      AND payment_date < ${getCurrentPeriodEnd(period, businessId)}
    GROUP BY payment_method
    ORDER BY amount DESC
  `);
}


export function getNetProfit(businessId: number, period: DashboardPeriod, locationId?: number) {
  return db.execute(sql`
    WITH monthly_sales_profit AS (
      SELECT
        COALESCE(SUM(
          CASE
            WHEN s.created_at >= ${getCurrentPeriodStart(period, businessId)}
              AND s.created_at < ${getCurrentPeriodEnd(period, businessId)}
            THEN (si.selling_price - si.cost_at_sale) * si.quantity
            ELSE 0
          END
        ), 0) AS current_profit,
        COALESCE(SUM(
          CASE
            WHEN s.created_at >= ${getPreviousPeriodStart(period, businessId)}
              AND s.created_at < ${getCurrentPeriodStart(period, businessId)}
            THEN (si.selling_price - si.cost_at_sale) * si.quantity
            ELSE 0
          END
        ), 0) AS previous_profit
      FROM sale_items si
      INNER JOIN sales s ON s.id = si.sale_id
      WHERE s.business_id = ${businessId}${locFilter("s", locationId)}
        AND s.status IN ('completed', 'refunded')
        AND s.created_at >= ${getPreviousPeriodStart(period, businessId)}
        AND s.created_at < ${getCurrentPeriodEnd(period, businessId)}
    ),
    monthly_refund_profit AS (
      -- Identical definition to the Profit report: subtract the refund
      -- money actually paid out, add back the COGS of goods that returned
      -- to inventory (restocked). Non-restocked refunds keep their cost
      -- consumed (shrinkage), so only the refund money is removed.
      SELECT
        COALESCE(SUM(
          CASE
            WHEN sr.created_at >= ${getCurrentPeriodStart(period, businessId)}
              AND sr.created_at < ${getCurrentPeriodEnd(period, businessId)}
            THEN sri.refund_total - (CASE WHEN sr.status = 'restock'
              THEN si.cost_at_sale * sri.quantity ELSE 0 END)
            ELSE 0
          END
        ), 0) AS current_refund_profit,
        COALESCE(SUM(
          CASE
            WHEN sr.created_at >= ${getPreviousPeriodStart(period, businessId)}
              AND sr.created_at < ${getCurrentPeriodStart(period, businessId)}
            THEN sri.refund_total - (CASE WHEN sr.status = 'restock'
              THEN si.cost_at_sale * sri.quantity ELSE 0 END)
            ELSE 0
          END
        ), 0) AS previous_refund_profit
      FROM sale_refunds sr
      INNER JOIN sale_refund_items sri ON sri.refund_id = sr.id
      INNER JOIN sale_items si ON si.id = sri.sale_item_id
      WHERE sr.business_id = ${businessId}${locFilter("sr", locationId)}
        AND sr.created_at >= ${getPreviousPeriodStart(period, businessId)}
        AND sr.created_at < ${getCurrentPeriodEnd(period, businessId)}
    ),
    monthly_expenses AS (
      SELECT
        COALESCE(SUM(amount) FILTER (
          WHERE expense_date >= (${getCurrentPeriodStart(period, businessId)})::date
            AND expense_date < (${getCurrentPeriodEnd(period, businessId)})::date
        ), 0) AS current_expenses,
        COALESCE(SUM(amount) FILTER (
          WHERE expense_date >= (${getPreviousPeriodStart(period, businessId)})::date
            AND expense_date < (${getCurrentPeriodStart(period, businessId)})::date
        ), 0) AS previous_expenses
      FROM expenses
      WHERE business_id = ${businessId}
        AND deleted_at IS NULL${locFilter("expenses", locationId)}
    ),
    net_profit AS (
      SELECT
        sales_profit.current_profit - refund_profit.current_refund_profit -
          expenses.current_expenses AS current_net_profit,
        sales_profit.previous_profit - refund_profit.previous_refund_profit -
          expenses.previous_expenses AS previous_net_profit
      FROM monthly_sales_profit sales_profit
      CROSS JOIN monthly_refund_profit refund_profit
      CROSS JOIN monthly_expenses expenses
    )
    SELECT
      current_net_profit,
      CASE
        WHEN previous_net_profit = 0 THEN NULL
        ELSE ROUND(
          ((current_net_profit - previous_net_profit) / previous_net_profit * 100)::numeric,
          2
        )
      END AS profit_growth
    FROM net_profit
  `);
}


export function getInvoiceDues(businessId: number, locationId?: number) {
  return db.execute(sql`
    SELECT
      COALESCE(SUM(due_amount), 0) AS current_due,
      NULL::numeric AS invoice_due_growth_pct
    FROM sales
    WHERE business_id = ${businessId}${locFilter("sales", locationId)}
      AND status = 'completed'
      AND payment_status IN ('unpaid', 'partial')
  `);
}


export function getExpensesSummary(businessId: number, period: DashboardPeriod, locationId?: number) {
  return db.execute(sql`
    WITH monthly_expenses AS (
      SELECT
        COALESCE(SUM(amount) FILTER (
          WHERE expense_date >= (${getCurrentPeriodStart(period, businessId)})::date
            AND expense_date < (${getCurrentPeriodEnd(period, businessId)})::date
        ), 0) AS current_expenses,
        COALESCE(SUM(amount) FILTER (
          WHERE expense_date >= (${getPreviousPeriodStart(period, businessId)})::date
            AND expense_date < (${getCurrentPeriodStart(period, businessId)})::date
        ), 0) AS previous_expenses
      FROM expenses
      WHERE business_id = ${businessId}
        AND deleted_at IS NULL${locFilter("expenses", locationId)}
    )
    SELECT
      current_expenses,
      CASE
        WHEN previous_expenses = 0 THEN NULL
        ELSE ROUND(
          ((current_expenses - previous_expenses) / previous_expenses * 100)::numeric,
          2
        )
      END AS expenses_growth
    FROM monthly_expenses
  `);
}


export function getPurchasesSummary(businessId: number, period: DashboardPeriod, locationId?: number) {
  return db.execute(sql`
    WITH monthly_purchases AS (
      SELECT
        COALESCE(SUM(total_amount) FILTER (
          WHERE created_at >= ${getCurrentPeriodStart(period, businessId)}
            AND created_at < ${getCurrentPeriodEnd(period, businessId)}
        ), 0) AS current_purchases,
        COALESCE(SUM(total_amount) FILTER (
          WHERE created_at >= ${getPreviousPeriodStart(period, businessId)}
            AND created_at < ${getCurrentPeriodStart(period, businessId)}
        ), 0) AS previous_purchases
      FROM purchases
      WHERE business_id = ${businessId}${locFilter("purchases", locationId)}
    )
    SELECT
      current_purchases,
      CASE
        WHEN previous_purchases = 0 THEN NULL
        ELSE ROUND(
          ((current_purchases - previous_purchases) / previous_purchases * 100)::numeric,
          2
        )
      END AS purchases_growth
    FROM monthly_purchases
  `);
}


export function getReturnSummary(businessId: number, period: DashboardPeriod, locationId?: number) {
  return db.execute(sql`
    WITH monthly_returns AS (
      SELECT
        COALESCE(SUM(total_amount) FILTER (
          WHERE created_at >= ${getCurrentPeriodStart(period, businessId)}
            AND created_at < ${getCurrentPeriodEnd(period, businessId)}
        ), 0) AS current_returns,
        COALESCE(SUM(total_amount) FILTER (
          WHERE created_at >= ${getPreviousPeriodStart(period, businessId)}
            AND created_at < ${getCurrentPeriodStart(period, businessId)}
        ), 0) AS previous_returns
      FROM purchase_returns
      WHERE business_id = ${businessId}${locFilter("purchase_returns", locationId)}
    )
    SELECT
      current_returns,
      CASE
        WHEN previous_returns = 0 AND current_returns = 0 THEN 0
        WHEN previous_returns = 0 THEN NULL
        ELSE ROUND(
          ((current_returns - previous_returns) / previous_returns * 100)::numeric,
          2
        )
      END AS return_growth_pct
    FROM monthly_returns
  `);
}


export function getRecentSalesSummary(businessId: number, period: DashboardPeriod, locationId?: number) {
  return db.execute(sql`
    SELECT
      s.id,
      s.invoice_number,
      s.created_at,
      COALESCE(c.name, 'Walk-in customer') AS customer_name,
      s.final_total AS sold_price,
      s.payment_status,
      COUNT(si.id) AS item_count
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE s.business_id = ${businessId}${locFilter("s", locationId)}
      AND s.status = 'completed'
      AND s.created_at >= ${getCurrentPeriodStart(period, businessId)}
      AND s.created_at < ${getCurrentPeriodEnd(period, businessId)}
    GROUP BY s.id, s.invoice_number, s.created_at, c.name, s.final_total, s.payment_status
    ORDER BY s.created_at DESC
    LIMIT 5
  `);
}


export function getLowStockSummary(businessId: number, locationId?: number) {
  return db.execute(sql`
    SELECT
      pv.id,
      p.id AS product_id,
      p.name AS product_name,
      vol.option_label AS variant_options,
      ${variantNameSql(sql`p.name`, sql`vol.option_label`)} AS variant_name,
      pv.sku,
      COALESCE(p.status, 'active') AS status,
      COALESCE(stock.quantity, 0) AS quantity
    FROM product_variants pv
    INNER JOIN products p ON p.id = pv.product_id
    ${variantOptionsJoinSql("pv", "vol")}
    LEFT JOIN (
      -- One row per variant: a variant stocked in several locations must not
      -- duplicate the alert row.
      SELECT variant_id, SUM(quantity) AS quantity
      FROM inventory_stock
      WHERE business_id = ${businessId}${locFilter("inventory_stock", locationId)}
      GROUP BY variant_id
    ) stock ON stock.variant_id = pv.id
    WHERE pv.business_id = ${businessId}
      AND COALESCE(stock.quantity, 0) <= COALESCE(pv.alert_quantity, 0)
    ORDER BY COALESCE(stock.quantity, 0) ASC
    LIMIT 5
  `);
}


export function getStaleStockSummary(
  businessId: number,
  staleDays: number,
  staleLimit: number,
  locationId?: number,
) {
  return db.execute(sql`
    WITH last_sold AS (
      SELECT
        si.variant_id,
        MAX(s.created_at) AS last_sold_at
      FROM sale_items si
      INNER JOIN sales s ON s.id = si.sale_id
      WHERE s.business_id = ${businessId}${locFilter("s", locationId)}
        AND s.status = 'completed'
      GROUP BY si.variant_id
    ),
    stock_value AS (
      SELECT
        variant_id,
        SUM(quantity_remaining * landed_cost_per_unit) AS value
      FROM inventory_batches
      WHERE business_id = ${businessId}${locFilter("inventory_batches", locationId)}
      GROUP BY variant_id
    )
    SELECT
      pv.id,
      p.id AS product_id,
      p.name AS product_name,
      vol.option_label AS variant_options,
      ${variantNameSql(sql`p.name`, sql`vol.option_label`)} AS variant_name,
      pv.sku,
      stock.quantity,
      last_sold.last_sold_at,
      CASE
        WHEN last_sold.last_sold_at IS NULL THEN NULL
        ELSE GREATEST(
          FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - last_sold.last_sold_at)) / 86400),
          0
        )::integer
      END AS days_since_last_sale,
      COALESCE(stock_value.value, 0) AS stock_value
    FROM product_variants pv
    INNER JOIN products p ON p.id = pv.product_id
    ${variantOptionsJoinSql("pv", "vol")}
    INNER JOIN (
      -- One row per variant (stock summed across locations under the scope).
      SELECT variant_id, SUM(quantity) AS quantity
      FROM inventory_stock
      WHERE business_id = ${businessId}${locFilter("inventory_stock", locationId)}
      GROUP BY variant_id
    ) stock ON stock.variant_id = pv.id
    LEFT JOIN last_sold ON last_sold.variant_id = pv.id
    LEFT JOIN stock_value ON stock_value.variant_id = pv.id
    WHERE pv.business_id = ${businessId}
      AND stock.quantity > 0
      AND (
        last_sold.last_sold_at IS NULL
        OR last_sold.last_sold_at < CURRENT_TIMESTAMP - (${staleDays} * INTERVAL '1 day')
      )
    ORDER BY last_sold.last_sold_at ASC NULLS FIRST, stock.quantity DESC
    LIMIT ${staleLimit}
  `);
}


export function getTopSellingProducts(businessId: number, period: DashboardPeriod, locationId?: number) {
  // Variant-level rows, net of refunds: a fully refunded line is no longer a
  // "top selling" item (refund money per sale_item — the POS-005 money
  // convention — is subtracted from gross too).
  return db.execute(sql`
    WITH refund_per_item AS (
      SELECT
        sri.sale_item_id,
        SUM(sri.quantity) AS refunded_qty,
        SUM(sri.refund_total) AS refunded_money
      FROM sale_refund_items sri
      INNER JOIN sale_refunds sr ON sr.id = sri.refund_id
      WHERE sr.business_id = ${businessId}${locFilter("sr", locationId)}
      GROUP BY sri.sale_item_id
    )
    SELECT
      p.id AS product_id,
      p.name AS product_name,
      pv.id AS variant_id,
      vol.option_label AS variant_options,
      ${variantNameSql(sql`p.name`, sql`vol.option_label`)} AS variant_name,
      pv.sku AS sku,
      COALESCE(SUM(si.quantity - COALESCE(rf.refunded_qty, 0)), 0) AS top_selling,
      COALESCE(SUM(si.line_total - COALESCE(rf.refunded_money, 0)), 0) AS gross_sales,
      COALESCE(
        SUM(si.line_total - COALESCE(rf.refunded_money, 0))
          / NULLIF(SUM(si.quantity - COALESCE(rf.refunded_qty, 0)), 0),
        0
      ) AS sold_price
    FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id
    INNER JOIN product_variants pv ON pv.id = si.variant_id
    INNER JOIN products p ON p.id = pv.product_id
    ${variantOptionsJoinSql("pv", "vol")}
    LEFT JOIN refund_per_item rf ON rf.sale_item_id = si.id
    WHERE s.business_id = ${businessId}${locFilter("s", locationId)}
      AND s.status IN ('completed', 'refunded')
      AND s.created_at >= ${getCurrentPeriodStart(period, businessId)}
      AND s.created_at < ${getCurrentPeriodEnd(period, businessId)}
    GROUP BY p.id, p.name, pv.id, pv.sku, vol.option_label
    ORDER BY top_selling DESC
    LIMIT 8
  `);
}
