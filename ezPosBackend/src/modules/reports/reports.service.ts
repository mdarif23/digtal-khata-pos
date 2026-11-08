import { sql } from "drizzle-orm";
import { roundMoney } from "../../utils/roundMoney.js";
import { variantOptionsJoinSql, variantNameSql } from "../../utils/variantDisplay.js";
import { db } from "../../db/schema/index.js";
import type { DateRangeQuery } from "./reports.validation.js";

function getDateBounds(params: DateRangeQuery) {
  const period = params.period || "this_month";
  if (period === "custom" && params.startDate && params.endDate) {
    return {
      start: `${params.startDate} 00:00:00`,
      end: `${params.endDate} 23:59:59.999`,
      startDateOnly: params.startDate,
      endDateOnly: params.endDate,
    };
  }

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  const fmt = (date: Date) => {
    const yr = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, "0");
    const da = String(date.getDate()).padStart(2, "0");
    return `${yr}-${mo}-${da}`;
  };

  let startDate: string;
  let endDate: string;

  if (period === "today") {
    startDate = fmt(now);
    endDate = fmt(now);
  } else if (period === "yesterday") {
    const yest = new Date(y, m, d - 1);
    startDate = fmt(yest);
    endDate = fmt(yest);
  } else if (period === "7d") {
    const past = new Date(y, m, d - 6);
    startDate = fmt(past);
    endDate = fmt(now);
  } else if (period === "30d") {
    const past = new Date(y, m, d - 29);
    startDate = fmt(past);
    endDate = fmt(now);
  } else if (period === "last_month") {
    const firstDayLastMonth = new Date(y, m - 1, 1);
    const lastDayLastMonth = new Date(y, m, 0);
    startDate = fmt(firstDayLastMonth);
    endDate = fmt(lastDayLastMonth);
  } else if (period === "this_year") {
    const firstDayYear = new Date(y, 0, 1);
    startDate = fmt(firstDayYear);
    endDate = fmt(now);
  } else {
    // this_month
    const firstDay = new Date(y, m, 1);
    startDate = fmt(firstDay);
    endDate = fmt(now);
  }

  return {
    start: `${startDate} 00:00:00`,
    end: `${endDate} 23:59:59.999`,
    startDateOnly: startDate,
    endDateOnly: endDate,
  };
}

/**
 * Optional location scope for report queries. Undefined = business-wide
 * aggregate (the caller's access was verified in the controller); a value
 * narrows the report to one location's rows.
 */
function locationFilter(alias: string, locationId: number | undefined) {
  if (locationId === undefined) return sql``;
  return sql` AND ${sql.raw(alias)}.location_id = ${locationId}`;
}

// ----------------------------------------------------
// 1. SALES REPORTS
// ----------------------------------------------------

export async function getSalesSummaryReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);

  // Refund impact uses the POS-005 definition (refund money out, COGS back
  // only for restocked goods) and is attributed to the refund's own date —
  // the money leaves on the day the refund happens. Same convention as the
  // dashboard's net-profit widget and the Profit report, so period totals
  // reconcile across widgets.
  const dailyResult = await db.execute(sql`
    WITH items_cost AS (
      SELECT
        si.sale_id,
        SUM((si.selling_price - si.cost_at_sale) * si.quantity) AS profit
      FROM sale_items si
      INNER JOIN sales s ON s.id = si.sale_id
      WHERE s.status IN ('completed', 'refunded')
        AND s.business_id = ${businessId}${locationFilter("s", locationId)}
        AND s.created_at >= ${start}::timestamp
        AND s.created_at <= ${end}::timestamp
      GROUP BY si.sale_id
    ),
    sale_stream AS (
      SELECT
        s.id,
        DATE(s.created_at)::text AS bucket_date,
        s.final_total,
        s.discount,
        COALESCE(ic.profit, 0) AS item_profit
      FROM sales s
      LEFT JOIN items_cost ic ON ic.sale_id = s.id
      WHERE s.status IN ('completed', 'refunded')
        AND s.business_id = ${businessId}${locationFilter("s", locationId)}
        AND s.created_at >= ${start}::timestamp
        AND s.created_at <= ${end}::timestamp
    ),
    refund_stream AS (
      SELECT
        DATE(sr.created_at)::text AS bucket_date,
        COALESCE(SUM(sri.refund_total), 0) AS refund_money,
        COALESCE(SUM(
          CASE WHEN sr.status = 'restock'
            THEN si.cost_at_sale * sri.quantity
            ELSE 0
          END
        ), 0) AS restocked_cost
      FROM sale_refunds sr
      INNER JOIN sale_refund_items sri ON sri.refund_id = sr.id
      INNER JOIN sale_items si ON si.id = sri.sale_item_id
      WHERE sr.business_id = ${businessId}${locationFilter("sr", locationId)}
        AND sr.created_at >= ${start}::timestamp
        AND sr.created_at <= ${end}::timestamp
      GROUP BY 1
    ),
    sales_by_day AS (
      SELECT
        bucket_date,
        COUNT(id)::int AS invoice_count,
        COALESCE(SUM(final_total), 0)::numeric AS gross_sales,
        COALESCE(SUM(discount), 0)::numeric AS total_discount,
        COALESCE(SUM(item_profit), 0)::numeric AS item_profit
      FROM sale_stream
      GROUP BY bucket_date
    )
    SELECT
      d.bucket_date AS sale_date,
      COALESCE(d.invoice_count, 0)::int AS invoice_count,
      COALESCE(d.gross_sales, 0)::numeric AS gross_sales,
      COALESCE(d.total_discount, 0)::numeric AS total_discount,
      COALESCE(r.refund_money, 0)::numeric AS total_refunds,
      (COALESCE(d.gross_sales, 0) - COALESCE(r.refund_money, 0))::numeric AS net_sales,
      (COALESCE(d.item_profit, 0) - COALESCE(r.refund_money, 0) + COALESCE(r.restocked_cost, 0))::numeric AS gross_profit
    FROM sales_by_day d
    FULL OUTER JOIN refund_stream r ON r.bucket_date = d.bucket_date
    ORDER BY 1 ASC
  `);

  const totalsResult = await db.execute(sql`
    WITH items_cost AS (
      SELECT
        si.sale_id,
        SUM((si.selling_price - si.cost_at_sale) * si.quantity) AS profit
      FROM sale_items si
      INNER JOIN sales s ON s.id = si.sale_id
      WHERE s.status IN ('completed', 'refunded')
        AND s.business_id = ${businessId}${locationFilter("s", locationId)}
        AND s.created_at >= ${start}::timestamp
        AND s.created_at <= ${end}::timestamp
      GROUP BY si.sale_id
    ),
    refund_impact AS (
      SELECT
        COALESCE(SUM(sri.refund_total), 0) AS refund_money,
        COALESCE(SUM(
          CASE WHEN sr.status = 'restock'
            THEN si.cost_at_sale * sri.quantity
            ELSE 0
          END
        ), 0) AS restocked_cost
      FROM sale_refunds sr
      INNER JOIN sale_refund_items sri ON sri.refund_id = sr.id
      INNER JOIN sale_items si ON si.id = sri.sale_item_id
      WHERE sr.business_id = ${businessId}${locationFilter("sr", locationId)}
        AND sr.created_at >= ${start}::timestamp
        AND sr.created_at <= ${end}::timestamp
    ),
    sale_totals AS (
      SELECT
        COUNT(s.id)::int AS total_invoices,
        COALESCE(SUM(s.final_total), 0)::numeric AS total_gross_sales,
        COALESCE(SUM(s.discount), 0)::numeric AS total_discount,
        COALESCE(SUM(COALESCE(ic.profit, 0)), 0)::numeric AS total_item_profit
      FROM sales s
      LEFT JOIN items_cost ic ON ic.sale_id = s.id
      WHERE s.status IN ('completed', 'refunded')
        AND s.business_id = ${businessId}${locationFilter("s", locationId)}
        AND s.created_at >= ${start}::timestamp
        AND s.created_at <= ${end}::timestamp
    )
    SELECT
      st.total_invoices,
      st.total_gross_sales,
      st.total_discount,
      COALESCE(ri.refund_money, 0)::numeric AS total_refunds,
      (st.total_gross_sales - COALESCE(ri.refund_money, 0))::numeric AS total_net_sales,
      (st.total_item_profit - COALESCE(ri.refund_money, 0) + COALESCE(ri.restocked_cost, 0))::numeric AS total_gross_profit,
      CASE
        WHEN COALESCE(st.total_gross_sales, 0) > 0
        THEN ROUND(
          (st.total_item_profit - COALESCE(ri.refund_money, 0) + COALESCE(ri.restocked_cost, 0))
            / st.total_gross_sales * 100, 2)
        ELSE 0
      END AS overall_profit_margin
    FROM sale_totals st
    CROSS JOIN refund_impact ri
  `);

  return {
    rows: dailyResult.rows,
    totals: totalsResult.rows[0] || {},
    periodBounds: { start, end },
  };
}

export async function getSalesByInvoiceReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const searchFilter = params.search ? `%${params.search}%` : null;

  const countQuery = await db.execute(sql`
    SELECT COUNT(DISTINCT s.id)::int AS total
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.business_id = ${businessId}${locationFilter("s", locationId)}
    AND s.created_at >= ${start}::timestamp 
      AND s.created_at <= ${end}::timestamp
      ${params.paymentStatus ? sql`AND s.payment_status = ${params.paymentStatus}` : sql``}
      ${params.customerId ? sql`AND s.customer_id = ${params.customerId}` : sql``}
      ${
        searchFilter
          ? sql`AND (s.invoice_number ILIKE ${searchFilter} OR c.name ILIKE ${searchFilter} OR c.phone ILIKE ${searchFilter})`
          : sql``
      }
  `);

  const listQuery = await db.execute(sql`
    SELECT 
      s.id,
      s.invoice_number AS "invoiceNumber",
      s.created_at AS "createdAt",
      COALESCE(c.name, 'Walk-in Customer') AS "customerName",
      COALESCE(c.phone, '-') AS "customerPhone",
      s.subtotal::numeric,
      s.discount::numeric,
      s.vat::numeric,
      s.final_total::numeric AS "finalTotal",
      s.payment_status AS "paymentStatus",
      s.due_amount::numeric AS "dueAmount",
      s.status,
      COUNT(si.id)::int AS "itemCount",
      COALESCE(MAX(sr.refund_total), 0)::numeric AS "refundAmount"
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN (
      SELECT sale_id, SUM(refund_total) AS refund_total
      FROM sale_refunds
      WHERE business_id = ${businessId}
      GROUP BY sale_id
    ) sr ON sr.sale_id = s.id
    WHERE s.business_id = ${businessId}${locationFilter("s", locationId)}
    AND s.created_at >= ${start}::timestamp 
      AND s.created_at <= ${end}::timestamp
      ${params.paymentStatus ? sql`AND s.payment_status = ${params.paymentStatus}` : sql``}
      ${params.customerId ? sql`AND s.customer_id = ${params.customerId}` : sql``}
      ${
        searchFilter
          ? sql`AND (s.invoice_number ILIKE ${searchFilter} OR c.name ILIKE ${searchFilter} OR c.phone ILIKE ${searchFilter})`
          : sql``
      }
    GROUP BY s.id, c.name, c.phone
    ORDER BY s.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    data: listQuery.rows,
    total: Number(countQuery.rows[0]?.total || 0),
    page,
    limit,
  };
}

export async function getProductSalesReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const searchFilter = params.search ? `%${params.search}%` : null;

  const countQuery = await db.execute(sql`
    SELECT COUNT(DISTINCT pv.id)::int AS total
    FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id
    INNER JOIN product_variants pv ON pv.id = si.variant_id
    INNER JOIN products p ON p.id = pv.product_id
    LEFT JOIN categories cat ON cat.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id
    WHERE s.status IN ('completed', 'refunded')
      AND s.business_id = ${businessId}${locationFilter("s", locationId)}
      AND s.created_at >= ${start}::timestamp 
      AND s.created_at <= ${end}::timestamp
      ${params.categoryId ? sql`AND p.category_id = ${params.categoryId}` : sql``}
      ${params.brandId ? sql`AND p.brand_id = ${params.brandId}` : sql``}
      ${searchFilter ? sql`AND (p.name ILIKE ${searchFilter} OR pv.sku ILIKE ${searchFilter})` : sql``}
  `);

  const listQuery = await db.execute(sql`
    SELECT
      p.id AS "productId",
      p.name AS "productName",
      pv.id AS "variantId",
      vol.option_label AS "variantOptions",
      ${variantNameSql(sql`p.name`, sql`vol.option_label`)} AS "variantName",
      COALESCE(cat.name, 'Uncategorized') AS "categoryName",
      COALESCE(b.name, '-') AS "brandName",
      pv.sku,
      COALESCE(u.abbreviation, u.name) AS "unitLabel",
      SUM(si.quantity)::int AS "qtySold",
      COALESCE(SUM(si.selling_price * si.quantity), 0)::numeric AS "grossSales",
      COALESCE(SUM(si.discount * si.quantity), 0)::numeric AS "totalDiscount",
      COALESCE(SUM(si.line_total), 0)::numeric AS "netSales",
      COALESCE(SUM(si.cost_at_sale * si.quantity), 0)::numeric AS "totalCost",
      COALESCE(SUM((si.selling_price - si.cost_at_sale) * si.quantity), 0)::numeric AS "grossProfit",
      CASE
        WHEN COALESCE(SUM(si.line_total), 0) > 0
        THEN ROUND(COALESCE(SUM((si.selling_price - si.cost_at_sale) * si.quantity), 0) / SUM(si.line_total) * 100, 2)
        ELSE 0
      END AS "profitMargin"
    FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id
    INNER JOIN product_variants pv ON pv.id = si.variant_id
    INNER JOIN products p ON p.id = pv.product_id
    LEFT JOIN units u ON u.id = p.unit_id
    LEFT JOIN categories cat ON cat.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id
    ${variantOptionsJoinSql("pv", "vol")}
    WHERE s.status IN ('completed', 'refunded')
      AND s.business_id = ${businessId}${locationFilter("s", locationId)}
      AND s.created_at >= ${start}::timestamp
      AND s.created_at <= ${end}::timestamp
      ${params.categoryId ? sql`AND p.category_id = ${params.categoryId}` : sql``}
      ${params.brandId ? sql`AND p.brand_id = ${params.brandId}` : sql``}
      ${searchFilter ? sql`AND (p.name ILIKE ${searchFilter} OR pv.sku ILIKE ${searchFilter})` : sql``}
    GROUP BY p.id, p.name, pv.id, pv.sku, u.abbreviation, u.name, cat.name, b.name, vol.option_label
    ORDER BY "qtySold" DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    data: listQuery.rows,
    total: Number(countQuery.rows[0]?.total || 0),
    page,
    limit,
  };
}

export async function getCustomerSalesReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const searchFilter = params.search ? `%${params.search}%` : null;

  const countQuery = await db.execute(sql`
    SELECT COUNT(DISTINCT s.customer_id)::int AS total
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.status IN ('completed', 'refunded')
      AND s.business_id = ${businessId}${locationFilter("s", locationId)}
      AND s.created_at >= ${start}::timestamp 
      AND s.created_at <= ${end}::timestamp
      ${searchFilter ? sql`AND (c.name ILIKE ${searchFilter} OR c.phone ILIKE ${searchFilter})` : sql``}
  `);

  const listQuery = await db.execute(sql`
    SELECT 
      COALESCE(c.id, 0) AS "customerId",
      COALESCE(c.name, 'Walk-in Customer') AS "customerName",
      COALESCE(c.phone, '-') AS phone,
      COUNT(DISTINCT s.id)::int AS "invoiceCount",
      COALESCE(SUM(s.final_total), 0)::numeric AS "totalSales",
      COALESCE(SUM(s.due_amount), 0)::numeric AS "outstandingDue",
      COALESCE(SUM(s.discount), 0)::numeric AS "totalDiscount"
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.status IN ('completed', 'refunded')
      AND s.business_id = ${businessId}${locationFilter("s", locationId)}
      AND s.created_at >= ${start}::timestamp 
      AND s.created_at <= ${end}::timestamp
      ${searchFilter ? sql`AND (c.name ILIKE ${searchFilter} OR c.phone ILIKE ${searchFilter})` : sql``}
    GROUP BY c.id, c.name, c.phone
    ORDER BY "totalSales" DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    data: listQuery.rows,
    total: Number(countQuery.rows[0]?.total || 0),
    page,
    limit,
  };
}

export async function getPaymentMethodReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);

  // sale_payments carries no location: when a location scope is requested it
  // is applied through the payment's sale.
  const result = await db.execute(sql`
    SELECT
      sp.payment_method AS "paymentMethod",
      COUNT(*)::int AS "paymentCount",
      COALESCE(SUM(sp.amount), 0)::numeric AS "totalAmount"
    FROM sale_payments sp
    INNER JOIN sales s ON s.id = sp.sale_id AND s.business_id = sp.business_id
    WHERE sp.business_id = ${businessId}${locationFilter("s", locationId)}
      AND sp.payment_date >= ${start}::timestamp
      AND sp.payment_date <= ${end}::timestamp
    GROUP BY sp.payment_method
    ORDER BY "totalAmount" DESC
  `);

  return result.rows;
}

export async function getSaleRefundsReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const countQuery = await db.execute(sql`
    SELECT COUNT(sr.id)::int AS total
    FROM sale_refunds sr
    WHERE sr.business_id = ${businessId}${locationFilter("sr", locationId)}
    AND sr.created_at >= ${start}::timestamp 
      AND sr.created_at <= ${end}::timestamp
  `);

  const listQuery = await db.execute(sql`
    SELECT 
      sr.id,
      sr.created_at AS "createdAt",
      s.invoice_number AS "invoiceNumber",
      COALESCE(c.name, 'Walk-in Customer') AS "customerName",
      sr.reason,
      COALESCE(sr.status, 'completed') AS status,
      sr.refund_total::numeric AS "refundTotal"
    FROM sale_refunds sr
    INNER JOIN sales s ON s.id = sr.sale_id
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE sr.business_id = ${businessId}${locationFilter("sr", locationId)}
    AND sr.created_at >= ${start}::timestamp 
      AND sr.created_at <= ${end}::timestamp
    ORDER BY sr.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    data: listQuery.rows,
    total: Number(countQuery.rows[0]?.total || 0),
    page,
    limit,
  };
}

// ----------------------------------------------------
// 2. FINANCIAL & PROFITABILITY REPORTS
// ----------------------------------------------------

export async function getProfitReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);

  // Refund accounting (POS-005): profit = item profit − refund money paid
  // out + the cost of goods that came back to inventory (restocked refunds
  // return an asset, so their COGS reverses; non-restocked refunds leave
  // the cost consumed — that loss shows up as shrinkage, not profit).
  const refundImpact = await db.execute(sql`
    SELECT
      COALESCE(SUM(sri.refund_total), 0)::numeric AS "refundMoney",
      COALESCE(SUM(
        CASE WHEN sr.status = 'restock'
          THEN si.cost_at_sale * sri.quantity
          ELSE 0
        END
      ), 0)::numeric AS "restockedCost",
      COALESCE(cat.name, 'Uncategorized') AS "categoryName"
    FROM sale_refunds sr
    INNER JOIN sale_refund_items sri ON sri.refund_id = sr.id
    INNER JOIN sale_items si ON si.id = sri.sale_item_id
    INNER JOIN sales s ON s.id = sr.sale_id
    INNER JOIN product_variants pv ON pv.id = si.variant_id
    INNER JOIN products p ON p.id = pv.product_id
    LEFT JOIN categories cat ON cat.id = p.category_id
    WHERE sr.business_id = ${businessId}
      AND s.business_id = ${businessId}${locationFilter("s", locationId)}
      AND s.created_at >= ${start}::timestamp
      AND s.created_at <= ${end}::timestamp
    GROUP BY cat.id, cat.name
  `);

  const categoryProfit = await db.execute(sql`
    SELECT 
      COALESCE(cat.name, 'Uncategorized') AS "categoryName",
      COALESCE(SUM(si.line_total), 0)::numeric AS "netSales",
      COALESCE(SUM(si.cost_at_sale * si.quantity), 0)::numeric AS "totalCost",
      COALESCE(SUM((si.selling_price - si.cost_at_sale) * si.quantity), 0)::numeric AS "grossProfit",
      CASE 
        WHEN COALESCE(SUM(si.line_total), 0) > 0 
        THEN ROUND(COALESCE(SUM((si.selling_price - si.cost_at_sale) * si.quantity), 0) / SUM(si.line_total) * 100, 2)
        ELSE 0 
      END AS "profitMargin"
    FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id
    INNER JOIN product_variants pv ON pv.id = si.variant_id
    INNER JOIN products p ON p.id = pv.product_id
    LEFT JOIN categories cat ON cat.id = p.category_id
    WHERE s.status IN ('completed', 'refunded')
      AND s.business_id = ${businessId}${locationFilter("s", locationId)}
      AND s.created_at >= ${start}::timestamp 
      AND s.created_at <= ${end}::timestamp
    GROUP BY cat.id, cat.name
    ORDER BY "grossProfit" DESC
  `);

  // Apply the refund impact per category (revenue given back minus COGS
  // that returned to stock).
  const impactByCategory = new Map(
    refundImpact.rows.map((row: Record<string, unknown>) => [
      String(row.categoryName),
      {
        refundMoney: Number(row.refundMoney),
        restockedCost: Number(row.restockedCost),
      },
    ]),
  );
  const categories = categoryProfit.rows.map((row: Record<string, unknown>) => {
    const categoryName = String(row.categoryName);
    const impact = impactByCategory.get(categoryName) ?? {
      refundMoney: 0,
      restockedCost: 0,
    };
    const grossProfit = Number(row.grossProfit) - impact.refundMoney + impact.restockedCost;
    const netSales = Number(row.netSales);
    return {
      ...row,
      grossProfit,
      profitMargin:
        netSales > 0 ? Math.round((grossProfit / netSales) * 100 * 100) / 100 : 0,
    };
  });

  const totalRefundMoney = [...impactByCategory.values()].reduce(
    (sum, impact) => sum + impact.refundMoney,
    0,
  );
  const totalRestockedCost = [...impactByCategory.values()].reduce(
    (sum, impact) => sum + impact.restockedCost,
    0,
  );

  const totals = await db.execute(sql`
    SELECT 
      COALESCE(SUM(si.line_total), 0)::numeric AS "totalNetSales",
      COALESCE(SUM(si.cost_at_sale * si.quantity), 0)::numeric AS "totalCost",
      COALESCE(SUM((si.selling_price - si.cost_at_sale) * si.quantity), 0)::numeric AS "totalGrossProfit",
      CASE 
        WHEN COALESCE(SUM(si.line_total), 0) > 0 
        THEN ROUND(COALESCE(SUM((si.selling_price - si.cost_at_sale) * si.quantity), 0) / SUM(si.line_total) * 100, 2)
        ELSE 0 
      END AS "overallMargin"
    FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id
    WHERE s.status IN ('completed', 'refunded')
      AND s.business_id = ${businessId}${locationFilter("s", locationId)}
      AND s.created_at >= ${start}::timestamp 
      AND s.created_at <= ${end}::timestamp
  `);

  const totalsRow = (totals.rows[0] || {}) as Record<string, unknown>;
  const adjustedGrossProfit =
    Number(totalsRow.totalGrossProfit ?? 0) - totalRefundMoney + totalRestockedCost;
  const totalNetSales = Number(totalsRow.totalNetSales ?? 0);

  return {
    categories,
    totals: {
      ...totalsRow,
      totalRefundMoney,
      totalRestockedCost,
      // Final gross profit after refund accounting — the number that must
      // match the dashboard's net-profit definition (minus expenses there).
      adjustedGrossProfit,
      overallMargin:
        totalNetSales > 0
          ? Math.round((adjustedGrossProfit / totalNetSales) * 100 * 100) / 100
          : 0,
    },
  };
}

export async function getExpenseReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { startDateOnly, endDateOnly } = getDateBounds(params);
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const countQuery = await db.execute(sql`
    SELECT COUNT(e.id)::int AS total
    FROM expenses e
    WHERE e.business_id = ${businessId}${locationFilter("e", locationId)}
      AND e.deleted_at IS NULL
      AND e.expense_date >= ${startDateOnly}::date
      AND e.expense_date <= ${endDateOnly}::date
  `);

  const listQuery = await db.execute(sql`
    SELECT 
      e.id,
      e.expense_date AS "expenseDate",
      e.title,
      COALESCE(ec.category_name, 'Uncategorized') AS "categoryName",
      e.amount::numeric,
      COALESCE(e.payment_method, '-') AS "paymentMethod",
      COALESCE(e.reference_no, '-') AS "referenceNo",
      e.note
    FROM expenses e
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    WHERE e.business_id = ${businessId}${locationFilter("e", locationId)}
      AND e.deleted_at IS NULL
      AND e.expense_date >= ${startDateOnly}::date
      AND e.expense_date <= ${endDateOnly}::date
    ORDER BY e.expense_date DESC, e.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const categoryTotals = await db.execute(sql`
    SELECT 
      COALESCE(ec.category_name, 'Uncategorized') AS "categoryName",
      COUNT(e.id)::int AS "expenseCount",
      COALESCE(SUM(e.amount), 0)::numeric AS "totalAmount"
    FROM expenses e
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    WHERE e.business_id = ${businessId}${locationFilter("e", locationId)}
      AND e.deleted_at IS NULL
      AND e.expense_date >= ${startDateOnly}::date
      AND e.expense_date <= ${endDateOnly}::date
    GROUP BY ec.category_name
    ORDER BY "totalAmount" DESC
  `);

  const grandTotal = await db.execute(sql`
    SELECT 
      COUNT(e.id)::int AS "totalCount",
      COALESCE(SUM(e.amount), 0)::numeric AS "grandTotal"
    FROM expenses e
    WHERE e.business_id = ${businessId}${locationFilter("e", locationId)}
      AND e.deleted_at IS NULL
      AND e.expense_date >= ${startDateOnly}::date
      AND e.expense_date <= ${endDateOnly}::date
  `);

  return {
    data: listQuery.rows,
    total: Number(countQuery.rows[0]?.total || 0),
    categoryTotals: categoryTotals.rows,
    summary: grandTotal.rows[0] || {},
    page,
    limit,
  };
}

export async function getCustomerReceivablesReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const searchFilter = params.search ? `%${params.search}%` : null;

  const result = await db.execute(sql`
    SELECT 
      c.id,
      c.name,
      c.phone,
      c.address,
      COUNT(s.id)::int AS "invoiceCount",
      COALESCE(SUM(s.final_total), 0)::numeric AS "totalInvoiced",
      COALESCE(SUM(s.due_amount), 0)::numeric AS "outstandingDue"
    FROM customers c
    INNER JOIN sales s ON s.customer_id = c.id
    WHERE s.status = 'completed' 
      AND s.business_id = ${businessId}${locationFilter("s", locationId)}
      AND s.payment_status IN ('unpaid', 'partial')
      ${searchFilter ? sql`AND (c.name ILIKE ${searchFilter} OR c.phone ILIKE ${searchFilter})` : sql``}
    GROUP BY c.id, c.name, c.phone, c.address
    HAVING SUM(s.due_amount) > 0
    ORDER BY "outstandingDue" DESC
  `);

  const totals = await db.execute(sql`
    SELECT 
      COUNT(DISTINCT c.id)::int AS "customerCount",
      COALESCE(SUM(s.due_amount), 0)::numeric AS "totalReceivable"
    FROM customers c
    INNER JOIN sales s ON s.customer_id = c.id
    WHERE s.status = 'completed' 
      AND s.business_id = ${businessId}${locationFilter("s", locationId)}
      AND s.payment_status IN ('unpaid', 'partial')
  `);

  return {
    customers: result.rows,
    totals: totals.rows[0] || {},
  };
}

// ----------------------------------------------------
// 3. INVENTORY REPORTS
// ----------------------------------------------------

export async function getStockReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const searchFilter = params.search ? `%${params.search}%` : null;

  const countQuery = await db.execute(sql`
    SELECT COUNT(pv.id)::int AS total
    FROM product_variants pv
    INNER JOIN products p ON p.id = pv.product_id
    WHERE p.business_id = ${businessId}${locationFilter("p", locationId)}
      AND (p.status != 'deleted' OR p.status IS NULL)
      ${params.categoryId ? sql`AND p.category_id = ${params.categoryId}` : sql``}
      ${params.brandId ? sql`AND p.brand_id = ${params.brandId}` : sql``}
      ${searchFilter ? sql`AND (p.name ILIKE ${searchFilter} OR pv.sku ILIKE ${searchFilter} OR pv.barcode ILIKE ${searchFilter})` : sql``}
  `);

  const listQuery = await db.execute(sql`
    SELECT
      p.id AS "productId",
      p.name AS "productName",
      pv.id AS "variantId",
      vol.option_label AS "variantOptions",
      ${variantNameSql(sql`p.name`, sql`vol.option_label`)} AS "variantName",
      COALESCE(cat.name, 'Uncategorized') AS "categoryName",
      COALESCE(b.name, '-') AS "brandName",
      pv.sku,
      COALESCE(pv.barcode, '-') AS barcode,
      pv.selling_price::numeric AS "sellingPrice",
      COALESCE(pv.alert_quantity, 0)::int AS "alertQuantity",
      COALESCE(ist.quantity, 0)::int AS "currentStock",
      COALESCE(ist.reserved_quantity, 0)::int AS reserved,
      COALESCE(ib.stock_value, 0)::numeric AS "stockValue",
      CASE
        WHEN COALESCE(ist.quantity, 0) <= 0 THEN 'out_of_stock'
        WHEN COALESCE(ist.quantity, 0) <= COALESCE(pv.alert_quantity, 0) THEN 'low_stock'
        ELSE 'in_stock'
      END AS "stockStatus"
    FROM product_variants pv
    INNER JOIN products p ON p.id = pv.product_id
    LEFT JOIN categories cat ON cat.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id
    ${variantOptionsJoinSql("pv", "vol")}
    LEFT JOIN (
      -- Pre-aggregated per variant: joining inventory_stock rows directly
      -- duplicates batch valuation rows (and splits the variant into one row
      -- per location) once a variant is stocked in more than one location.
      SELECT variant_id, SUM(quantity) AS quantity, SUM(reserved_quantity) AS reserved_quantity
      FROM inventory_stock
      WHERE business_id = ${businessId}${locationFilter("inventory_stock", locationId)}
      GROUP BY variant_id
    ) ist ON ist.variant_id = pv.id
    LEFT JOIN (
      SELECT variant_id, SUM(quantity_remaining * landed_cost_per_unit) AS stock_value
      FROM inventory_batches
      WHERE business_id = ${businessId}${locationFilter("inventory_batches", locationId)}
      GROUP BY variant_id
    ) ib ON ib.variant_id = pv.id
    WHERE p.business_id = ${businessId}${locationFilter("p", locationId)}
      AND (p.status != 'deleted' OR p.status IS NULL)
      ${params.categoryId ? sql`AND p.category_id = ${params.categoryId}` : sql``}
      ${params.brandId ? sql`AND p.brand_id = ${params.brandId}` : sql``}
      ${searchFilter ? sql`AND (p.name ILIKE ${searchFilter} OR pv.sku ILIKE ${searchFilter} OR pv.barcode ILIKE ${searchFilter})` : sql``}
    ORDER BY p.name ASC, pv.sku ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const valuationQuery = await db.execute(sql`
    SELECT
      COALESCE(SUM(quantity_remaining * landed_cost_per_unit), 0)::numeric AS "totalValuation",
      COALESCE(SUM(quantity_remaining), 0)::int AS "totalUnits"
    FROM inventory_batches
    WHERE business_id = ${businessId}${locationFilter("inventory_batches", locationId)}
  `);

  return {
    data: listQuery.rows,
    total: Number(countQuery.rows[0]?.total || 0),
    valuation: valuationQuery.rows[0] || {},
    page,
    limit,
  };
}

export async function getStockMovementReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const countQuery = await db.execute(sql`
    SELECT COUNT(im.id)::int AS total
    FROM inventory_movements im
    WHERE im.business_id = ${businessId}${locationFilter("im", locationId)}
      AND im.created_at >= ${start}::timestamp
      AND im.created_at <= ${end}::timestamp
  `);

  const listQuery = await db.execute(sql`
    SELECT
      im.id,
      im.created_at AS "createdAt",
      p.id AS "productId",
      p.name AS "productName",
      pv.id AS "variantId",
      vol.option_label AS "variantOptions",
      ${variantNameSql(sql`p.name`, sql`vol.option_label`)} AS "variantName",
      pv.sku,
      im.movement_type AS "movementType",
      im.quantity::int,
      im.reference_type AS "referenceType",
      COALESCE(im.reference_id, 0)::int AS "referenceId"
    FROM inventory_movements im
    INNER JOIN product_variants pv ON pv.id = im.variant_id
    INNER JOIN products p ON p.id = pv.product_id
    ${variantOptionsJoinSql("pv", "vol")}
    WHERE im.business_id = ${businessId}${locationFilter("im", locationId)}
      AND im.created_at >= ${start}::timestamp
      AND im.created_at <= ${end}::timestamp
    ORDER BY im.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    data: listQuery.rows,
    total: Number(countQuery.rows[0]?.total || 0),
    page,
    limit,
  };
}

export async function getBatchExpiryReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const countQuery = await db.execute(sql`
    SELECT COUNT(ib.id)::int AS total
    FROM inventory_batches ib
    WHERE ib.business_id = ${businessId}${locationFilter("ib", locationId)}
      AND ib.quantity_remaining > 0
  `);

  const listQuery = await db.execute(sql`
    SELECT
      ib.id,
      ib.batch_number AS "batchNumber",
      p.id AS "productId",
      p.name AS "productName",
      pv.id AS "variantId",
      vol.option_label AS "variantOptions",
      ${variantNameSql(sql`p.name`, sql`vol.option_label`)} AS "variantName",
      pv.sku,
      ib.purchase_price::numeric AS "purchasePrice",
      ib.quantity_received::int AS "quantityReceived",
      ib.quantity_remaining::int AS "quantityRemaining",
      ib.manufactured_date AS "manufacturedDate",
      ib.expiry_date AS "expiryDate",
      CASE
        WHEN ib.expiry_date IS NULL THEN 'no_expiry'
        WHEN ib.expiry_date < CURRENT_DATE THEN 'expired'
        WHEN ib.expiry_date < CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
        ELSE 'valid'
      END AS "expiryStatus"
    FROM inventory_batches ib
    INNER JOIN product_variants pv ON pv.id = ib.variant_id
    INNER JOIN products p ON p.id = pv.product_id
    ${variantOptionsJoinSql("pv", "vol")}
    WHERE ib.business_id = ${businessId}${locationFilter("ib", locationId)}
      AND ib.quantity_remaining > 0
    ORDER BY ib.expiry_date ASC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    data: listQuery.rows,
    total: Number(countQuery.rows[0]?.total || 0),
    page,
    limit,
  };
}

// ----------------------------------------------------
// 4. PURCHASE REPORTS
// ----------------------------------------------------

/**
 * Purchase item report: one row per purchase line (variant-level), with the
 * supplier, order and the line's own historical unit cost.
 */
export async function getPurchaseItemsReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const searchFilter = params.search ? `%${params.search}%` : null;

  const whereClause = sql`
    WHERE pi.business_id = ${businessId}
      AND pu.purchase_date >= ${start}::timestamp
      AND pu.purchase_date <= ${end}::timestamp
      ${locationFilter("pu", locationId)}
      ${params.supplierId ? sql`AND pu.supplier_id = ${params.supplierId}` : sql``}
      ${params.categoryId ? sql`AND prod.category_id = ${params.categoryId}` : sql``}
      ${searchFilter
        ? sql`AND (prod.name ILIKE ${searchFilter} OR pv.sku ILIKE ${searchFilter} OR pu.purchase_order_number ILIKE ${searchFilter})`
        : sql``}
  `;

  const countQuery = await db.execute(sql`
    SELECT COUNT(pi.id)::int AS total
    FROM purchase_items pi
    INNER JOIN purchases pu ON pu.id = pi.purchase_id AND pu.business_id = pi.business_id
    INNER JOIN product_variants pv ON pv.id = pi.variant_id
    INNER JOIN products prod ON prod.id = pv.product_id
    ${whereClause}
  `);

  const listQuery = await db.execute(sql`
    SELECT
      pi.id,
      pu.id AS "purchaseId",
      pu.purchase_order_number AS "purchaseOrderNumber",
      pu.purchase_date AS "purchaseDate",
      COALESCE(sup.name, '-') AS "supplierName",
      prod.id AS "productId",
      prod.name AS "productName",
      pv.id AS "variantId",
      vol.option_label AS "variantOptions",
      ${variantNameSql(sql`prod.name`, sql`vol.option_label`)} AS "variantName",
      pv.sku,
      COALESCE(cat.name, 'Uncategorized') AS "categoryName",
      pi.quantity::float8 AS "quantityOrdered",
      pi.received_quantity::float8 AS "quantityReceived",
      pi.unit_cost::numeric AS "unitCost",
      pi.discount::numeric AS "discount",
      pi.tax::numeric AS "tax",
      pi.total::numeric AS "lineTotal"
    FROM purchase_items pi
    INNER JOIN purchases pu ON pu.id = pi.purchase_id AND pu.business_id = pi.business_id
    INNER JOIN product_variants pv ON pv.id = pi.variant_id
    INNER JOIN products prod ON prod.id = pv.product_id
    LEFT JOIN suppliers sup ON sup.id = pu.supplier_id
    LEFT JOIN categories cat ON cat.id = prod.category_id
    ${variantOptionsJoinSql("pv", "vol")}
    ${whereClause}
    ORDER BY pu.purchase_date DESC, pi.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    data: listQuery.rows,
    total: Number(countQuery.rows[0]?.total || 0),
    page,
    limit,
  };
}

/**
 * Sales return (refund) item report: one row per refunded line. The refunded
 * variant comes through sale_refund_items.sale_item_id → sale_items — the
 * only reliable variant reference on refund rows.
 */
export async function getSaleRefundItemsReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const searchFilter = params.search ? `%${params.search}%` : null;

  const whereClause = sql`
    WHERE sr.business_id = ${businessId}
      AND sr.created_at >= ${start}::timestamp
      AND sr.created_at <= ${end}::timestamp
      ${locationFilter("sr", locationId)}
      ${params.customerId ? sql`AND s.customer_id = ${params.customerId}` : sql``}
      ${searchFilter
        ? sql`AND (prod.name ILIKE ${searchFilter} OR pv.sku ILIKE ${searchFilter} OR s.invoice_number ILIKE ${searchFilter})`
        : sql``}
  `;

  const countQuery = await db.execute(sql`
    SELECT COUNT(sri.id)::int AS total
    FROM sale_refund_items sri
    INNER JOIN sale_refunds sr ON sr.id = sri.refund_id
    INNER JOIN sales s ON s.id = sr.sale_id
    INNER JOIN sale_items si ON si.id = sri.sale_item_id
    INNER JOIN product_variants pv ON pv.id = si.variant_id
    INNER JOIN products prod ON prod.id = pv.product_id
    ${whereClause}
  `);

  const listQuery = await db.execute(sql`
    SELECT
      sri.id,
      sr.id AS "refundId",
      sr.created_at AS "refundedAt",
      s.invoice_number AS "invoiceNumber",
      COALESCE(c.name, 'Walk-in Customer') AS "customerName",
      COALESCE(sr.status, 'completed') AS "disposition",
      sr.reason,
      prod.id AS "productId",
      prod.name AS "productName",
      pv.id AS "variantId",
      vol.option_label AS "variantOptions",
      ${variantNameSql(sql`prod.name`, sql`vol.option_label`)} AS "variantName",
      pv.sku,
      sri.quantity::float8 AS "quantityReturned",
      sri.refund_price::numeric AS "refundPrice",
      sri.refund_total::numeric AS "refundTotal"
    FROM sale_refund_items sri
    INNER JOIN sale_refunds sr ON sr.id = sri.refund_id
    INNER JOIN sales s ON s.id = sr.sale_id
    LEFT JOIN customers c ON c.id = s.customer_id
    INNER JOIN sale_items si ON si.id = sri.sale_item_id
    INNER JOIN product_variants pv ON pv.id = si.variant_id
    INNER JOIN products prod ON prod.id = pv.product_id
    ${variantOptionsJoinSql("pv", "vol")}
    ${whereClause}
    ORDER BY sr.created_at DESC, sri.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    data: listQuery.rows,
    total: Number(countQuery.rows[0]?.total || 0),
    page,
    limit,
  };
}

export async function getPurchaseSummaryReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const countQuery = await db.execute(sql`
    SELECT COUNT(p.id)::int AS total
    FROM purchases p
    WHERE p.business_id = ${businessId}${locationFilter("p", locationId)}
      AND p.created_at >= ${start}::timestamp
      AND p.created_at <= ${end}::timestamp
      ${params.supplierId ? sql`AND p.supplier_id = ${params.supplierId}` : sql``}
  `);

  const listQuery = await db.execute(sql`
    SELECT 
      p.id,
      p.purchase_order_number AS "purchaseOrderNumber",
      p.purchase_date AS "purchaseDate",
      p.created_at AS "createdAt",
      COALESCE(s.name, 'Unknown Supplier') AS "supplierName",
      p.total_amount::numeric AS "totalAmount",
      p.paid_amount::numeric AS "paidAmount",
      p.due_amount::numeric AS "dueAmount",
      p.status,
      p.payment_status AS "paymentStatus"
    FROM purchases p
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.business_id = ${businessId}${locationFilter("p", locationId)}
      AND p.created_at >= ${start}::timestamp
      AND p.created_at <= ${end}::timestamp
      ${params.supplierId ? sql`AND p.supplier_id = ${params.supplierId}` : sql``}
    ORDER BY p.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const totals = await db.execute(sql`
    SELECT 
      COUNT(p.id)::int AS "totalPurchases",
      COALESCE(SUM(p.total_amount), 0)::numeric AS "grandTotalAmount",
      COALESCE(SUM(p.paid_amount), 0)::numeric AS "grandPaidAmount",
      COALESCE(SUM(p.due_amount), 0)::numeric AS "grandDueAmount"
    FROM purchases p
    WHERE p.business_id = ${businessId}${locationFilter("p", locationId)}
      AND p.created_at >= ${start}::timestamp
      AND p.created_at <= ${end}::timestamp
      ${params.supplierId ? sql`AND p.supplier_id = ${params.supplierId}` : sql``}
  `);

  return {
    data: listQuery.rows,
    total: Number(countQuery.rows[0]?.total || 0),
    totals: totals.rows[0] || {},
    page,
    limit,
  };
}

export async function getSupplierPayablesReport(businessId: number, locationId?: number) {
  const result = await db.execute(sql`
    SELECT 
      s.id,
      s.name,
      s.phone,
      s.email,
      COUNT(p.id)::int AS "purchaseCount",
      COALESCE(SUM(p.total_amount), 0)::numeric AS "totalPurchased",
      COALESCE(SUM(p.paid_amount), 0)::numeric AS "totalPaid",
      COALESCE(SUM(p.due_amount), 0)::numeric AS "outstandingDue"
    FROM suppliers s
    INNER JOIN purchases p ON p.supplier_id = s.id
    WHERE s.business_id = ${businessId}${locationFilter("s", locationId)}
      AND p.business_id = ${businessId}${locationFilter("p", locationId)}
      AND p.payment_status IN ('unpaid', 'partial')
    GROUP BY s.id, s.name, s.phone, s.email
    HAVING SUM(p.due_amount) > 0
    ORDER BY "outstandingDue" DESC
  `);

  const totals = await db.execute(sql`
    SELECT 
      COUNT(DISTINCT s.id)::int AS "supplierCount",
      COALESCE(SUM(p.due_amount), 0)::numeric AS "totalPayable"
    FROM suppliers s
    INNER JOIN purchases p ON p.supplier_id = s.id
    WHERE s.business_id = ${businessId}${locationFilter("s", locationId)}
      AND p.business_id = ${businessId}${locationFilter("p", locationId)}
      AND p.payment_status IN ('unpaid', 'partial')
  `);

  return {
    suppliers: result.rows,
    totals: totals.rows[0] || {},
  };
}



// ----------------------------------------------------
// 5. COMMERCIAL ADDITIONS: HOURLY, TAX, SHRINKAGE, REGISTER CLOSE
// ----------------------------------------------------

export async function getHourlySalesReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);

  // Sales totals and item counts are aggregated in separate CTEs: joining
  // sale_items into the sales aggregate multiplies SUM(final_total) by each
  // sale's item count.
  const hourlyData = await db.execute(sql`
    WITH hours AS (
      SELECT generate_series(0, 23) AS hour_num
    ),
    hourly_sales AS (
      SELECT
        EXTRACT(HOUR FROM s.created_at)::int AS hour_num,
        COUNT(*)::int AS transaction_count,
        COALESCE(SUM(s.final_total), 0)::numeric AS gross_sales
      FROM sales s
      WHERE s.status IN ('completed', 'refunded')
        AND s.business_id = ${businessId}${locationFilter("s", locationId)}
        AND s.created_at >= ${start}::timestamp
        AND s.created_at <= ${end}::timestamp
      GROUP BY EXTRACT(HOUR FROM s.created_at)
    ),
    hourly_items AS (
      SELECT
        EXTRACT(HOUR FROM s.created_at)::int AS hour_num,
        COALESCE(SUM(si.quantity), 0)::int AS items_sold
      FROM sale_items si
      INNER JOIN sales s ON s.id = si.sale_id
      WHERE s.status IN ('completed', 'refunded')
        AND s.business_id = ${businessId}${locationFilter("s", locationId)}
        AND s.created_at >= ${start}::timestamp
        AND s.created_at <= ${end}::timestamp
      GROUP BY EXTRACT(HOUR FROM s.created_at)
    )
    SELECT
      h.hour_num AS "hourNum",
      TO_CHAR(TO_TIMESTAMP(h.hour_num::text, 'HH24'), 'HH12:00 AM') || ' - ' || TO_CHAR(TO_TIMESTAMP(((h.hour_num + 1) % 24)::text, 'HH24'), 'HH12:00 AM') AS "hourLabel",
      COALESCE(hs.transaction_count, 0)::int AS "transactionCount",
      COALESCE(hs.gross_sales, 0)::numeric AS "grossSales",
      COALESCE(hi.items_sold, 0)::int AS "itemsSold",
      CASE
        WHEN COALESCE(hs.transaction_count, 0) > 0
        THEN ROUND(COALESCE(hs.gross_sales, 0) / hs.transaction_count, 2)
        ELSE 0
      END AS "averageOrderValue"
    FROM hours h
    LEFT JOIN hourly_sales hs ON hs.hour_num = h.hour_num
    LEFT JOIN hourly_items hi ON hi.hour_num = h.hour_num
    ORDER BY h.hour_num ASC
  `);

  const summary = await db.execute(sql`
    WITH sale_totals AS (
      SELECT
        COUNT(*)::int AS "totalTransactions",
        COALESCE(SUM(s.final_total), 0)::numeric AS "totalSales"
      FROM sales s
      WHERE s.status IN ('completed', 'refunded')
        AND s.business_id = ${businessId}${locationFilter("s", locationId)}
        AND s.created_at >= ${start}::timestamp
        AND s.created_at <= ${end}::timestamp
    ),
    item_totals AS (
      SELECT COALESCE(SUM(si.quantity), 0)::int AS "totalItemsSold"
      FROM sale_items si
      INNER JOIN sales s ON s.id = si.sale_id
      WHERE s.status IN ('completed', 'refunded')
        AND s.business_id = ${businessId}${locationFilter("s", locationId)}
        AND s.created_at >= ${start}::timestamp
        AND s.created_at <= ${end}::timestamp
    )
    SELECT
      st."totalTransactions",
      st."totalSales",
      COALESCE(it."totalItemsSold", 0) AS "totalItemsSold",
      CASE
        WHEN st."totalTransactions" > 0
        THEN ROUND(st."totalSales" / st."totalTransactions", 2)
        ELSE 0
      END AS "overallAOV"
    FROM sale_totals st
    CROSS JOIN item_totals it
  `);

  return {
    hours: hourlyData.rows,
    summary: summary.rows[0] || {},
  };
}

export async function getTaxReconciliationReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);

  const salesTax = await db.execute(sql`
    SELECT 
      COUNT(id)::int AS "taxableInvoices",
      COALESCE(SUM(subtotal), 0)::numeric AS "taxableSales",
      COALESCE(SUM(vat), 0)::numeric AS "outputVat",
      COALESCE(SUM(final_total), 0)::numeric AS "totalGrossSales"
    FROM sales
    WHERE status IN ('completed', 'refunded')
      AND business_id = ${businessId}
      AND created_at >= ${start}::timestamp 
      AND created_at <= ${end}::timestamp
  `);

  const purchaseTax = await db.execute(sql`
    SELECT 
      COUNT(id)::int AS "purchaseOrdersCount",
      COALESCE(SUM(subtotal), 0)::numeric AS "taxablePurchases",
      COALESCE(SUM(tax), 0)::numeric AS "inputVat",
      COALESCE(SUM(total_amount), 0)::numeric AS "totalPurchases"
    FROM purchases
    WHERE business_id = ${businessId}
    AND created_at >= ${start}::timestamp 
      AND created_at <= ${end}::timestamp
  `);

  const dailyBreakdown = await db.execute(sql`
    WITH daily_sales AS (
      SELECT 
        DATE(created_at)::text AS tx_date,
        COALESCE(SUM(subtotal), 0)::numeric AS sales_subtotal,
        COALESCE(SUM(vat), 0)::numeric AS output_vat
      FROM sales
      WHERE status IN ('completed', 'refunded')
        AND business_id = ${businessId}
        AND created_at >= ${start}::timestamp 
        AND created_at <= ${end}::timestamp
      GROUP BY DATE(created_at)
    ),
    daily_purchases AS (
      SELECT 
        DATE(created_at)::text AS tx_date,
        COALESCE(SUM(subtotal), 0)::numeric AS purchase_subtotal,
        COALESCE(SUM(tax), 0)::numeric AS input_vat
      FROM purchases
      WHERE business_id = ${businessId}
      AND created_at >= ${start}::timestamp 
        AND created_at <= ${end}::timestamp
      GROUP BY DATE(created_at)
    )
    SELECT 
      COALESCE(s.tx_date, p.tx_date) AS "reportDate",
      COALESCE(s.sales_subtotal, 0)::numeric AS "taxableSales",
      COALESCE(s.output_vat, 0)::numeric AS "outputVat",
      COALESCE(p.purchase_subtotal, 0)::numeric AS "taxablePurchases",
      COALESCE(p.input_vat, 0)::numeric AS "inputVat",
      (COALESCE(s.output_vat, 0) - COALESCE(p.input_vat, 0))::numeric AS "netVatPayable"
    FROM daily_sales s
    FULL OUTER JOIN daily_purchases p ON p.tx_date = s.tx_date
    ORDER BY "reportDate" DESC
  `);

  const outputVat = Number(salesTax.rows[0]?.outputVat || 0);
  const inputVat = Number(purchaseTax.rows[0]?.inputVat || 0);
  const netTaxLiability = outputVat - inputVat;

  return {
    salesTax: salesTax.rows[0] || {},
    purchaseTax: purchaseTax.rows[0] || {},
    netTaxLiability,
    dailyBreakdown: dailyBreakdown.rows,
  };
}

export async function getInventoryShrinkageReport(businessId: number, params: DateRangeQuery, locationId?: number) {
  const { start, end } = getDateBounds(params);
  const page = params.page || 1;
  const limit = params.limit || 50;
  const offset = (page - 1) * limit;

  const countQuery = await db.execute(sql`
    SELECT COUNT(im.id)::int AS total
    FROM inventory_movements im
    WHERE im.movement_type = 'adjustment'
      AND im.quantity < 0
      AND im.business_id = ${businessId}${locationFilter("im", locationId)}
      AND im.created_at >= ${start}::timestamp 
      AND im.created_at <= ${end}::timestamp
  `);

  const listQuery = await db.execute(sql`
    SELECT
      im.id,
      im.created_at AS "createdAt",
      p.id AS "productId",
      p.name AS "productName",
      pv.id AS "variantId",
      vol.option_label AS "variantOptions",
      ${variantNameSql(sql`p.name`, sql`vol.option_label`)} AS "variantName",
      pv.sku,
      COALESCE(cat.name, 'Uncategorized') AS "categoryName",
      CASE
        WHEN im.reference_type LIKE 'stock_adjustment:%'
        THEN SUBSTRING(im.reference_type FROM 18)
        ELSE 'correction'
      END AS reason,
      ABS(im.quantity)::int AS "unitsLost",
      pv.selling_price::numeric AS "unitRetailPrice",
      COALESCE(ib.purchase_price, pv.selling_price * 0.7)::numeric AS "unitCost",
      (ABS(im.quantity) * COALESCE(ib.purchase_price, pv.selling_price * 0.7))::numeric AS "costLoss",
      (ABS(im.quantity) * pv.selling_price)::numeric AS "retailLoss"
    FROM inventory_movements im
    INNER JOIN product_variants pv ON pv.id = im.variant_id
    INNER JOIN products p ON p.id = pv.product_id
    LEFT JOIN categories cat ON cat.id = p.category_id
    ${variantOptionsJoinSql("pv", "vol")}
    LEFT JOIN (
      SELECT variant_id, AVG(landed_cost_per_unit) AS purchase_price
      FROM inventory_batches
      WHERE business_id = ${businessId}
      GROUP BY variant_id
    ) ib ON ib.variant_id = pv.id
    WHERE im.movement_type = 'adjustment'
      AND im.quantity < 0
      AND im.business_id = ${businessId}${locationFilter("im", locationId)}
      AND im.created_at >= ${start}::timestamp 
      AND im.created_at <= ${end}::timestamp
    ORDER BY im.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const summary = await db.execute(sql`
    SELECT 
      COUNT(im.id)::int AS "incidentCount",
      COALESCE(SUM(ABS(im.quantity)), 0)::int AS "totalUnitsLost",
      COALESCE(SUM(ABS(im.quantity) * COALESCE(ib.purchase_price, pv.selling_price * 0.7)), 0)::numeric AS "totalCostLoss",
      COALESCE(SUM(ABS(im.quantity) * pv.selling_price), 0)::numeric AS "totalRetailLoss"
    FROM inventory_movements im
    INNER JOIN product_variants pv ON pv.id = im.variant_id
    LEFT JOIN (
      SELECT variant_id, AVG(landed_cost_per_unit) AS purchase_price
      FROM inventory_batches
      WHERE business_id = ${businessId}
      GROUP BY variant_id
    ) ib ON ib.variant_id = pv.id
    WHERE im.movement_type = 'adjustment'
      AND im.quantity < 0
      AND im.business_id = ${businessId}${locationFilter("im", locationId)}
      AND im.created_at >= ${start}::timestamp 
      AND im.created_at <= ${end}::timestamp
  `);

  const byReason = await db.execute(sql`
    SELECT 
      CASE 
        WHEN im.reference_type LIKE 'stock_adjustment:%' 
        THEN SUBSTRING(im.reference_type FROM 18)
        ELSE 'correction'
      END AS reason,
      COUNT(im.id)::int AS "incidentCount",
      COALESCE(SUM(ABS(im.quantity)), 0)::int AS "unitsLost",
      COALESCE(SUM(ABS(im.quantity) * COALESCE(ib.purchase_price, pv.selling_price * 0.7)), 0)::numeric AS "costLoss"
    FROM inventory_movements im
    INNER JOIN product_variants pv ON pv.id = im.variant_id
    LEFT JOIN (
      SELECT variant_id, AVG(landed_cost_per_unit) AS purchase_price
      FROM inventory_batches
      WHERE business_id = ${businessId}
      GROUP BY variant_id
    ) ib ON ib.variant_id = pv.id
    WHERE im.movement_type = 'adjustment'
      AND im.quantity < 0
      AND im.business_id = ${businessId}${locationFilter("im", locationId)}
      AND im.created_at >= ${start}::timestamp 
      AND im.created_at <= ${end}::timestamp
    GROUP BY reason
    ORDER BY "costLoss" DESC
  `);

  return {
    incidents: listQuery.rows,
    total: Number(countQuery.rows[0]?.total || 0),
    summary: summary.rows[0] || {},
    byReason: byReason.rows,
    page,
    limit,
  };
}

export async function getRegisterCloseReport(
  businessId: number,
  params: DateRangeQuery,
  locationId?: number,
) {
  const { start, end, startDateOnly, endDateOnly } = getDateBounds(params);

  // Per-session Z-report rows: closed sessions in the window (plus open
  // ones for live context). Cash figures come from the session's own
  // transaction ledger — the same source the session's expected cash is
  // computed from — so the variance math cannot double-count split
  // payments (only the cash portion is recorded as a `sale` transaction).
  const sessionsResult = await db.execute(sql`
    SELECT
      rs.id AS "sessionId",
      r.name AS "registerName",
      l.name AS "locationName",
      u.full_name AS "cashierName",
      rs.status,
      rs.opening_cash::numeric AS "openingCash",
      COALESCE(SUM(rt.amount) FILTER (WHERE rt.type = 'sale'), 0)::numeric AS "cashSales",
      COALESCE(SUM(rt.amount) FILTER (WHERE rt.type = 'cash_in'), 0)::numeric AS "cashIn",
      COALESCE(SUM(rt.amount) FILTER (WHERE rt.type = 'cash_out'), 0)::numeric AS "cashOut",
      COALESCE(SUM(rt.amount) FILTER (WHERE rt.type = 'cash_refund'), 0)::numeric AS "cashRefunds",
      COALESCE(SUM(rt.amount) FILTER (WHERE rt.type = 'safe_withdrawal'), 0)::numeric AS "safeWithdrawals",
      COALESCE(SUM(rt.amount) FILTER (WHERE rt.type = 'safe_deposit'), 0)::numeric AS "safeDeposits",
      COALESCE(SUM(rt.amount) FILTER (WHERE rt.type = 'adjustment_in'), 0)::numeric AS "adjustmentsIn",
      COALESCE(SUM(rt.amount) FILTER (WHERE rt.type = 'adjustment_out'), 0)::numeric AS "adjustmentsOut",
      CASE
        WHEN rs.status = 'closed' THEN rs.expected_cash
        ELSE rs.opening_cash
          + COALESCE(SUM(
              CASE
                WHEN rt.type IN ('cash_out', 'cash_refund', 'safe_deposit', 'adjustment_out')
                  THEN -rt.amount
                ELSE rt.amount
              END
            ), 0)
      END::numeric AS "expectedCash",
      rs.counted_cash::numeric AS "countedCash",
      rs.difference::numeric AS "difference",
      ncs."nonCashSales",
      rf.refunds,
      rs.opened_at,
      rs.closed_at
    FROM register_sessions rs
    INNER JOIN registers r ON r.id = rs.register_id
    INNER JOIN locations l ON l.id = r.location_id
    INNER JOIN users u ON u.id = rs.user_id
    LEFT JOIN register_transactions rt ON rt.session_id = rs.id
    LEFT JOIN LATERAL (
      -- Non-cash payments of the sales rung up by this session's cashier at
      -- this location during the shift. sale_payments has no session link, so
      -- the sale's location + cashier + window is the scope (same convention
      -- as the refunds LATERAL below) — never the business-wide total.
      SELECT COALESCE(SUM(sp.amount) FILTER (WHERE sp.payment_method <> 'cash'), 0) AS "nonCashSales"
      FROM sale_payments sp
      INNER JOIN sales s ON s.id = sp.sale_id AND s.business_id = sp.business_id
      WHERE s.business_id = rs.business_id
        AND s.location_id = r.location_id
        AND s.cashier_user_id = rs.user_id
        AND s.created_at >= rs.opened_at
        AND s.created_at <= COALESCE(rs.closed_at, now())
    ) ncs ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(sr.refund_total), 0) AS refunds
      FROM sale_refunds sr
      WHERE sr.business_id = rs.business_id
        AND sr.location_id = r.location_id
        AND sr.created_at >= rs.opened_at
        AND sr.created_at <= COALESCE(rs.closed_at, now())
    ) rf ON TRUE
    WHERE rs.business_id = ${businessId}
      AND (
        (rs.status = 'closed' AND rs.closed_at >= ${start}::timestamp AND rs.closed_at <= ${end}::timestamp)
        OR (rs.status = 'open' AND rs.opened_at <= ${end}::timestamp)
      )
      ${locationFilter("l", locationId)}
    GROUP BY rs.id, r.name, l.name, u.full_name, ncs."nonCashSales", rf.refunds
    ORDER BY rs.id DESC
    LIMIT 200
  `);

  // Period aggregates — the original Z-report contract, preserved. Cash and
  // digital payment totals are scoped through their sale's location.
  const cashSales = await db.execute(sql`
    SELECT
      COALESCE(SUM(sp.amount), 0)::numeric AS "cashAmount",
      COUNT(sp.id)::int AS "cashTxCount"
    FROM sale_payments sp
    INNER JOIN sales s ON s.id = sp.sale_id AND s.business_id = sp.business_id
    WHERE sp.payment_method = 'cash'
      AND sp.business_id = ${businessId}
      AND s.created_at >= ${start}::timestamp
      AND s.created_at <= ${end}::timestamp
      ${locationFilter("s", locationId)}
  `);

  const digitalPayments = await db.execute(sql`
    SELECT
      sp.payment_method AS method,
      COALESCE(SUM(sp.amount), 0)::numeric AS amount,
      COUNT(sp.id)::int AS "txCount"
    FROM sale_payments sp
    INNER JOIN sales s ON s.id = sp.sale_id AND s.business_id = sp.business_id
    WHERE sp.payment_method != 'cash'
      AND sp.business_id = ${businessId}
      AND s.created_at >= ${start}::timestamp
      AND s.created_at <= ${end}::timestamp
      ${locationFilter("s", locationId)}
    GROUP BY sp.payment_method
  `);

  const cashExpenses = await db.execute(sql`
    SELECT
      COALESCE(SUM(p.amount), 0)::numeric AS "cashExpenseTotal",
      COUNT(p.id)::int AS "expenseCount"
    FROM expense_payments p
    INNER JOIN expenses e ON e.id = p.expense_id
      AND e.business_id = p.business_id
      AND e.deleted_at IS NULL
    WHERE p.payment_method = 'Cash'
      AND p.business_id = ${businessId}
      AND p.payment_date >= ${startDateOnly}::date
      AND p.payment_date <= ${endDateOnly}::date
      ${locationFilter("p", locationId)}
  `);

  const salesSummary = await db.execute(sql`
    SELECT
      COUNT(id)::int AS "totalInvoices",
      COALESCE(SUM(final_total), 0)::numeric AS "grossRevenue",
      COALESCE(SUM(discount), 0)::numeric AS "totalDiscount",
      COALESCE(SUM(vat), 0)::numeric AS "totalVat",
      COALESCE(SUM(due_amount), 0)::numeric AS "creditSalesDue"
    FROM sales
    WHERE status IN ('completed', 'refunded')
      AND business_id = ${businessId}
      AND created_at >= ${start}::timestamp
      AND created_at <= ${end}::timestamp
      ${locationFilter("sales", locationId)}
  `);

  const refunds = await db.execute(sql`
    SELECT
      COUNT(id)::int AS "refundCount",
      COALESCE(SUM(refund_total), 0)::numeric AS "refundTotal"
    FROM sale_refunds
    WHERE business_id = ${businessId}
      AND created_at >= ${start}::timestamp
      AND created_at <= ${end}::timestamp
      ${locationFilter("sale_refunds", locationId)}
  `);

  const sessions = sessionsResult.rows.map(
    (row: Record<string, unknown>) => ({
      sessionId: Number(row.sessionId),
      registerName: String(row.registerName),
      locationName: String(row.locationName),
      cashierName: String(row.cashierName),
      status: String(row.status),
      openingCash: Number(row.openingCash),
      cashSales: Number(row.cashSales),
      nonCashSales: Number(row.nonCashSales ?? 0),
      cashIn: Number(row.cashIn),
      cashOut: Number(row.cashOut),
      cashRefunds: Number(row.cashRefunds ?? 0),
      safeWithdrawals: Number(row.safeWithdrawals ?? 0),
      safeDeposits: Number(row.safeDeposits ?? 0),
      adjustmentsIn: Number(row.adjustmentsIn ?? 0),
      adjustmentsOut: Number(row.adjustmentsOut ?? 0),
      expectedCash: Number(row.expectedCash ?? 0),
      countedCash: row.countedCash === null ? null : Number(row.countedCash),
      difference: row.difference === null ? null : Number(row.difference),
      refunds: Number(row.refunds ?? 0),
      openedAt: row.opened_at,
      closedAt: row.closed_at,
    }),
  );

  const totals = sessions.reduce(
    (acc, row) => ({
      sessionCount: acc.sessionCount + 1,
      expectedCash:
        acc.expectedCash + (row.status === "closed" ? row.expectedCash : 0),
      countedCash: acc.countedCash + (row.countedCash ?? 0),
      difference: acc.difference + (row.difference ?? 0),
      cashSales: acc.cashSales + (row.status === "closed" ? row.cashSales : 0),
      cashRefunds:
        acc.cashRefunds + (row.status === "closed" ? row.cashRefunds : 0),
    }),
    { sessionCount: 0, expectedCash: 0, countedCash: 0, difference: 0, cashSales: 0, cashRefunds: 0 },
  );

  return {
    sessions,
    totals,
    cashSales: cashSales.rows[0] || {},
    digitalPayments: digitalPayments.rows,
    cashExpenses: cashExpenses.rows[0] || {},
    salesSummary: salesSummary.rows[0] || {},
    refunds: refunds.rows[0] || {},
    periodBounds: { start, end, startDateOnly, endDateOnly },
  };
}

export async function getLocationComparisonReport(
  businessId: number,
  params: DateRangeQuery,
) {
  const { start, end } = getDateBounds(params);

  const result = await db.execute(sql`
    WITH sales_by_location AS (
      SELECT
        s.location_id,
        COUNT(s.id)::int AS "invoiceCount",
        COALESCE(SUM(s.final_total), 0)::numeric AS gross,
        COALESCE(SUM(s.discount), 0)::numeric AS discount
      FROM sales s
      WHERE s.status IN ('completed', 'refunded')
        AND s.business_id = ${businessId}
        AND s.created_at >= ${start}::timestamp
        AND s.created_at <= ${end}::timestamp
      GROUP BY s.location_id
    ),
    refunds_by_location AS (
      SELECT
        sr.location_id,
        COALESCE(SUM(sr.refund_total), 0)::numeric AS refunds
      FROM sale_refunds sr
      WHERE sr.business_id = ${businessId}
        AND sr.created_at >= ${start}::timestamp
        AND sr.created_at <= ${end}::timestamp
      GROUP BY sr.location_id
    ),
    expenses_by_location AS (
      SELECT
        e.location_id,
        COALESCE(SUM(e.amount), 0)::numeric AS expenses
      FROM expenses e
      WHERE e.business_id = ${businessId}
        AND e.deleted_at IS NULL
        AND e.expense_date >= ${start}::date
        AND e.expense_date <= ${end}::date
      GROUP BY e.location_id
    )
    SELECT
      l.id AS "locationId",
      l.name AS "locationName",
      l.location_type AS "locationType",
      COALESCE(sl."invoiceCount", 0)::int AS "invoiceCount",
      COALESCE(sl.gross, 0)::numeric AS gross,
      COALESCE(sl.discount, 0)::numeric AS discount,
      COALESCE(sr.refunds, 0)::numeric AS refunds,
      COALESCE(sl.gross, 0) - COALESCE(sr.refunds, 0) AS net,
      COALESCE(e.expenses, 0)::numeric AS expenses
    FROM locations l
    LEFT JOIN sales_by_location sl ON sl.location_id = l.id
    LEFT JOIN refunds_by_location sr ON sr.location_id = l.id
    LEFT JOIN expenses_by_location e ON e.location_id = l.id
    WHERE l.business_id = ${businessId}
    ORDER BY l.id
  `);

  const rows = result.rows.map((row: Record<string, unknown>) => ({
    locationId: Number(row.locationId),
    locationName: String(row.locationName),
    locationType: String(row.locationType),
    invoiceCount: Number(row.invoiceCount),
    gross: Number(row.gross),
    discount: Number(row.discount),
    refunds: Number(row.refunds),
    net: Number(row.net),
    expenses: Number(row.expenses),
  }));

  const totals = rows.reduce(
    (acc, row) => ({
      invoiceCount: acc.invoiceCount + Number(row.invoiceCount),
      gross: acc.gross + Number(row.gross),
      discounts: acc.discounts + Number(row.discount),
      refunds: acc.refunds + Number(row.refunds),
      net: acc.net + Number(row.net),
      expenses: acc.expenses + Number(row.expenses),
    }),
    { invoiceCount: 0, gross: 0, discounts: 0, refunds: 0, net: 0, expenses: 0 },
  );

  return { rows, totals, periodBounds: { start, end } };
}


// ---------------------------------------------------------------------------
// Inventory aging + dead stock (Module 2D, Phase 3).
// ---------------------------------------------------------------------------

export interface InventoryAgingRow {
  batchId: number;
  variantId: number;
  productName: string;
  variantOptions: string | null;
  variantName: string | null;
  sku: string | null;
  batchNumber: string;
  locationId: number;
  quantityRemaining: number;
  unitCost: number;
  stockValue: number;
  ageDays: number;
  bucket: "0-30" | "31-60" | "61-90" | "90+";
}

/**
 * Batch-level inventory aging: remaining quantities bucketed by how long
 * ago each batch was received, valued at the batch's own cost (the same
 * batch-wise cost tracking COGS uses).
 */
export async function getInventoryAgingReport(
  businessId: number,
  locationId?: number,
): Promise<{ rows: InventoryAgingRow[]; buckets: Record<string, { quantity: number; value: number }> }> {
  const result = await db.execute(sql`
    SELECT b.id AS "batchId", b.variant_id AS "variantId", p.name AS "productName",
           vol.option_label AS "variantOptions",
           ${variantNameSql(sql`p.name`, sql`vol.option_label`)} AS "variantName",
           v.sku AS "sku", b.batch_number AS "batchNumber",
           b.location_id AS "locationId",
           b.quantity_remaining AS "quantityRemaining",
           b.purchase_price AS "unitCost",
           (b.quantity_remaining * b.landed_cost_per_unit)::numeric AS "stockValue",
           EXTRACT(DAY FROM now() - COALESCE(
             (SELECT pu.purchase_date FROM purchase_items pi
              JOIN purchases pu ON pu.id = pi.purchase_id
              WHERE pi.id = b.purchase_item_id),
             b.created_at, now()))::int AS "ageDays"
    FROM inventory_batches b
    JOIN product_variants v ON v.id = b.variant_id
    JOIN products p ON p.id = v.product_id
    ${variantOptionsJoinSql("v", "vol")}
    WHERE b.business_id = ${businessId}
      AND b.quantity_remaining > 0
      ${locationId !== undefined ? sql`AND b.location_id = ${locationId}` : sql``}
    ORDER BY b.created_at ASC
  `);
  const rows = (result.rows as Record<string, unknown>[]).map((row) => {
    const ageDays = Number(row.ageDays ?? 0);
    const bucket: InventoryAgingRow["bucket"] =
      ageDays <= 30 ? "0-30" : ageDays <= 60 ? "31-60" : ageDays <= 90 ? "61-90" : "90+";
    return {
      batchId: Number(row.batchId),
      variantId: Number(row.variantId),
      productName: String(row.productName ?? ""),
      variantOptions: (row.variantOptions as string | null) ?? null,
      variantName: (row.variantName as string | null) ?? null,
      sku: (row.sku as string | null) ?? null,
      batchNumber: String(row.batchNumber ?? ""),
      locationId: Number(row.locationId),
      quantityRemaining: Number(row.quantityRemaining ?? 0),
      unitCost: Number(row.unitCost ?? 0),
      stockValue: Number(row.stockValue ?? 0),
      ageDays,
      bucket,
    };
  });
  const buckets: Record<string, { quantity: number; value: number }> = {};
  for (const row of rows) {
    const bucket = buckets[row.bucket] ?? { quantity: 0, value: 0 };
    bucket.quantity += row.quantityRemaining;
    bucket.value = Number((bucket.value + row.stockValue).toFixed(2));
    buckets[row.bucket] = bucket;
  }
  return { rows, buckets };
}

export interface DeadStockRow {
  variantId: number;
  productId: number;
  productName: string;
  variantOptions: string | null;
  variantName: string | null;
  sku: string | null;
  currentStock: number;
  stockValue: number;
  lastSoldAt: string | null;
  daysSinceLastSale: number | null;
  daysOnShelf: number;
}

/**
 * Dead stock: stocked variants with no sales in the given window (or never
 * sold), valued at batch cost — capital sitting on the shelf. One row per
 * variant; stock is summed across in-scope locations so a multi-location
 * variant is not reported twice.
 */
export async function getDeadStockReport(
  businessId: number,
  days: number,
  locationId?: number,
): Promise<DeadStockRow[]> {
  const result = await db.execute(sql`
    SELECT st.variant_id AS "variantId", p.id AS "productId", p.name AS "productName",
           vol.option_label AS "variantOptions",
           ${variantNameSql(sql`p.name`, sql`vol.option_label`)} AS "variantName",
           v.sku AS "sku",
           st.quantity AS "currentStock",
           COALESCE((SELECT SUM(b.quantity_remaining * b.landed_cost_per_unit)
             FROM inventory_batches b
             WHERE b.variant_id = st.variant_id AND b.business_id = ${businessId}
               AND b.quantity_remaining > 0
               ${locationId !== undefined ? sql`AND b.location_id = ${locationId}` : sql``}
           ), 0)::numeric AS "stockValue",
           last_sale.last_sold_at AS "lastSoldAt",
           NULL::int AS "daysOnShelf"
    FROM (
      SELECT variant_id, SUM(quantity) AS quantity
      FROM inventory_stock
      WHERE business_id = ${businessId}
        AND quantity > 0
        ${locationId !== undefined ? sql`AND location_id = ${locationId}` : sql``}
      GROUP BY variant_id
    ) st
    JOIN product_variants v ON v.id = st.variant_id
    JOIN products p ON p.id = v.product_id
    ${variantOptionsJoinSql("v", "vol")}
    LEFT JOIN (
      SELECT si.variant_id, MAX(s.purchase_date) AS last_sold_at
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id AND s.business_id = si.business_id
      WHERE s.business_id = ${businessId}
        AND s.status IN ('completed', 'refunded')
      GROUP BY si.variant_id
    ) last_sale ON last_sale.variant_id = st.variant_id
    WHERE last_sale.last_sold_at IS NULL
       OR last_sale.last_sold_at < now() - (${days} || ' days')::interval
    ORDER BY "stockValue" DESC
  `);
  return (result.rows as Record<string, unknown>[]).map((row) => {
    const lastSoldAt = row.lastSoldAt ? new Date(row.lastSoldAt as string).toISOString() : null;
    return {
      variantId: Number(row.variantId),
      productId: Number(row.productId),
      productName: String(row.productName ?? ""),
      variantOptions: (row.variantOptions as string | null) ?? null,
      variantName: (row.variantName as string | null) ?? null,
      sku: (row.sku as string | null) ?? null,
      currentStock: Number(row.currentStock ?? 0),
      stockValue: Number(row.stockValue ?? 0),
      lastSoldAt,
      daysSinceLastSale: lastSoldAt
        ? Math.floor((Date.now() - new Date(lastSoldAt).getTime()) / 86_400_000)
        : null,
      daysOnShelf: Number(row.daysOnShelf ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Advanced analytics (Module 15, Phase 8). Statistical baselines only —
// projections are labeled as trend estimates, never guarantees.
// ---------------------------------------------------------------------------

export interface ChannelPerformanceRow {
  channel: string;
  orders: number;
  revenue: number;
  avgOrderValue: number;
}

export async function getChannelPerformanceReport(
  businessId: number,
  params: DateRangeQuery,
  locationId?: number,
): Promise<ChannelPerformanceRow[]> {
  const { start, end } = getDateBounds(params);
  const result = await db.execute(sql`
    SELECT s.channel::text AS channel,
           COUNT(*)::int AS orders,
           SUM(s.final_total)::numeric AS revenue
    FROM sales s
    WHERE s.business_id = ${businessId}
      AND s.status IN ('completed', 'refunded')
      AND s.purchase_date >= ${start}
      AND s.purchase_date <= ${end}
      ${locationId !== undefined ? sql`AND s.location_id = ${locationId}` : sql``}
    GROUP BY s.channel
    ORDER BY revenue DESC
  `);
  return (result.rows as Record<string, unknown>[]).map((row) => {
    const orders = Number(row.orders ?? 0);
    const revenue = Number(row.revenue ?? 0);
    return {
      channel: String(row.channel ?? "pos"),
      orders,
      revenue,
      avgOrderValue: orders > 0 ? roundMoney(revenue / orders) : 0,
    };
  });
}

export interface ClvRow {
  customerId: number;
  customerName: string;
  phone: string | null;
  orders: number;
  totalSpent: number;
  avgOrderValue: number;
  firstPurchase: string | null;
  lastPurchase: string | null;
}

export async function getCustomerLifetimeValueReport(
  businessId: number,
  locationId?: number,
): Promise<ClvRow[]> {
  const result = await db.execute(sql`
    SELECT c.id AS "customerId", c.name AS "customerName", c.phone AS "phone",
           COUNT(s.id)::int AS orders,
           COALESCE(SUM(s.final_total), 0)::numeric AS "totalSpent",
           MIN(s.purchase_date)::text AS "firstPurchase",
           MAX(s.purchase_date)::text AS "lastPurchase"
    FROM customers c
    JOIN sales s ON s.customer_id = c.id AND s.business_id = c.business_id
    WHERE c.business_id = ${businessId}
      AND s.status IN ('completed', 'refunded')
      ${locationId !== undefined ? sql`AND s.location_id = ${locationId}` : sql``}
    GROUP BY c.id, c.name, c.phone
    ORDER BY "totalSpent" DESC
    LIMIT 200
  `);
  return (result.rows as Record<string, unknown>[]).map((row) => {
    const orders = Number(row.orders ?? 0);
    const totalSpent = Number(row.totalSpent ?? 0);
    return {
      customerId: Number(row.customerId),
      customerName: String(row.customerName ?? ""),
      phone: (row.phone as string | null) ?? null,
      orders,
      totalSpent,
      avgOrderValue: orders > 0 ? roundMoney(totalSpent / orders) : 0,
      firstPurchase: (row.firstPurchase as string | null) ?? null,
      lastPurchase: (row.lastPurchase as string | null) ?? null,
    };
  });
}

export interface RetentionRow {
  month: string;
  newCustomers: number;
  returningCustomers: number;
  totalActive: number;
}

export async function getCustomerRetentionReport(
  businessId: number,
  months = 6,
): Promise<RetentionRow[]> {
  const result = await db.execute(sql`
    WITH monthly AS (
      SELECT date_trunc('month', s.purchase_date) AS month,
             s.customer_id
      FROM sales s
      WHERE s.business_id = ${businessId}
        AND s.status IN ('completed', 'refunded')
        AND s.customer_id IS NOT NULL
        AND s.purchase_date >= date_trunc('month', now()) - ((${months} || ' months')::interval)
      GROUP BY 1, 2
    )
    SELECT to_char(month, 'YYYY-MM') AS month,
           COUNT(*)::int AS "totalActive",
           COUNT(*) FILTER (
             WHERE NOT EXISTS (
               SELECT 1 FROM monthly prior
               WHERE prior.customer_id = monthly.customer_id
                 AND prior.month < monthly.month
             )
           )::int AS "newCustomers",
           COUNT(*) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM monthly prior
               WHERE prior.customer_id = monthly.customer_id
                 AND prior.month < monthly.month
             )
           )::int AS "returningCustomers"
    FROM monthly
    GROUP BY month
    ORDER BY month
  `);
  return (result.rows as Record<string, unknown>[]).map((row) => ({
    month: String(row.month ?? ""),
    newCustomers: Number(row.newCustomers ?? 0),
    returningCustomers: Number(row.returningCustomers ?? 0),
    totalActive: Number(row.totalActive ?? 0),
  }));
}

export interface StaffPerformanceRow {
  cashierUserId: number;
  cashierName: string;
  orders: number;
  revenue: number;
  avgBasket: number;
}

export async function getStaffPerformanceReport(
  businessId: number,
  params: DateRangeQuery,
  locationId?: number,
): Promise<StaffPerformanceRow[]> {
  const { start, end } = getDateBounds(params);
  const result = await db.execute(sql`
    SELECT s.cashier_user_id AS "cashierUserId", u.full_name AS "cashierName",
           COUNT(*)::int AS orders,
           SUM(s.final_total)::numeric AS revenue
    FROM sales s
    JOIN users u ON u.id = s.cashier_user_id
    WHERE s.business_id = ${businessId}
      AND s.status IN ('completed', 'refunded')
      AND s.cashier_user_id IS NOT NULL
      AND s.purchase_date >= ${start}
      AND s.purchase_date <= ${end}
      ${locationId !== undefined ? sql`AND s.location_id = ${locationId}` : sql``}
    GROUP BY s.cashier_user_id, u.full_name
    ORDER BY revenue DESC
  `);
  return (result.rows as Record<string, unknown>[]).map((row) => {
    const orders = Number(row.orders ?? 0);
    const revenue = Number(row.revenue ?? 0);
    return {
      cashierUserId: Number(row.cashierUserId),
      cashierName: String(row.cashierName ?? ""),
      orders,
      revenue,
      avgBasket: orders > 0 ? roundMoney(revenue / orders) : 0,
    };
  });
}

export interface ForecastPoint {
  date: string;
  actualRevenue: number | null;
  projectedRevenue: number;
}

export interface SalesForecast {
  history: ForecastPoint[];
  projection: { next7DaysTotal: number; dailyAverage: number; trendPerDay: number };
  method: string;
}

/**
 * Sales trend projection: least-squares linear regression over the last 90
 * days of daily revenue, extended 7 days forward. A statistical baseline —
 * explicitly labeled as an estimate; seasonal effects are out of scope.
 */
export async function getSalesForecastReport(
  businessId: number,
  locationId?: number,
): Promise<SalesForecast> {
  const result = await db.execute(sql`
    SELECT d::date::text AS day,
           COALESCE(SUM(s.final_total), 0)::numeric AS revenue
    FROM generate_series(
      date_trunc('day', now()) - INTERVAL '89 days',
      date_trunc('day', now()),
      INTERVAL '1 day'
    ) d
    LEFT JOIN sales s
      ON date_trunc('day', s.purchase_date) = d
      AND s.business_id = ${businessId}
      AND s.status IN ('completed', 'refunded')
      ${locationId !== undefined ? sql`AND s.location_id = ${locationId}` : sql``}
    GROUP BY d
    ORDER BY d
  `);
  const history = (result.rows as Record<string, unknown>[]).map((row) => ({
    date: String(row.day),
    actualRevenue: Number(row.revenue ?? 0),
    projectedRevenue: 0,
  }));

  // Least squares on x = day index.
  const n = history.length;
  if (n < 7) {
    return {
      history,
      projection: { next7DaysTotal: 0, dailyAverage: 0, trendPerDay: 0 },
      method: "insufficient history",
    };
  }
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  history.forEach((point, index) => {
    sumX += index;
    sumY += point.actualRevenue ?? 0;
    sumXY += index * (point.actualRevenue ?? 0);
    sumXX += index * index;
  });
  const denominator = n * sumXX - sumX * sumX;
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  for (let index = 0; index < n; index += 1) {
    history[index]!.projectedRevenue = roundMoney(
      Math.max(0, intercept + slope * index),
    );
  }
  const projection: ForecastPoint[] = [];
  for (let day = 1; day <= 7; day += 1) {
    projection.push({
      date: new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10),
      actualRevenue: null,
      projectedRevenue: roundMoney(Math.max(0, intercept + slope * (n - 1 + day))),
    });
  }
  const next7DaysTotal = roundMoney(
    projection.reduce((sum, point) => sum + point.projectedRevenue, 0),
  );
  return {
    history: [...history, ...projection],
    projection: {
      next7DaysTotal,
      dailyAverage: roundMoney(next7DaysTotal / 7),
      trendPerDay: roundMoney(slope),
    },
    method:
      "least-squares linear trend over the last 90 days of daily revenue — a statistical estimate, not a guarantee",
  };
}

// ---------------------------------------------------------------------------
// Pricing attribution reports (Phase 7): group profitability reads the
// sales.customer_group_id SNAPSHOT (no live membership joins); promotion
// performance reads sale_items.price_adjustments. Both stay on historical
// sale snapshots — materializing new prices never rewrites history.
// ---------------------------------------------------------------------------

export interface GroupProfitabilityRow {
  groupId: number | null;
  groupName: string;
  salesCount: number;
  grossSales: number;
  itemDiscounts: number;
  groupDiscounts: number;
  promotionDiscounts: number;
  netRevenue: number;
  totalCost: number;
  netProfit: number;
  marginPercent: number;
}

export async function getGroupProfitabilityReport(
  businessId: number,
  params: DateRangeQuery,
  locationId?: number,
): Promise<{ rows: GroupProfitabilityRow[] }> {
  const { start, end } = getDateBounds(params);

  const result = await db.execute(sql`
    WITH base AS (
      SELECT
        s.customer_group_id,
        s.id AS sale_id,
        SUM(si.selling_price * si.quantity) AS gross,
        SUM(si.discount) AS item_disc,
        SUM(si.cost_at_sale * si.quantity) AS cogs
      FROM sales s
      INNER JOIN sale_items si ON si.sale_id = s.id AND si.business_id = s.business_id
      WHERE s.business_id = ${businessId}
        AND s.created_at >= ${start}::timestamp
        AND s.created_at <= ${end}::timestamp${locationFilter("s", locationId)}
      GROUP BY s.customer_group_id, s.id
    ),
    adj AS (
      SELECT
        s.customer_group_id,
        COALESCE(SUM((a.adj->>'amount')::numeric) FILTER (WHERE a.adj->>'kind' = 'group'), 0) AS group_disc,
        COALESCE(SUM((a.adj->>'amount')::numeric) FILTER (WHERE a.adj->>'kind' = 'promotion'), 0) AS promo_disc
      FROM sales s
      INNER JOIN sale_items si ON si.sale_id = s.id AND si.business_id = s.business_id
      CROSS JOIN LATERAL jsonb_array_elements(si.price_adjustments) a(adj)
      WHERE s.business_id = ${businessId}
        AND s.created_at >= ${start}::timestamp
        AND s.created_at <= ${end}::timestamp${locationFilter("s", locationId)}
      GROUP BY s.customer_group_id
    )
    SELECT
      t.customer_group_id AS "groupId",
      COALESCE(g.name,
        CASE WHEN t.customer_group_id IS NULL THEN 'No group'
             ELSE 'Removed group #' || t.customer_group_id END) AS "groupName",
      t."salesCount",
      t.gross AS "grossSales",
      t.item_disc AS "itemDiscounts",
      COALESCE(adj.group_disc, 0) AS "groupDiscounts",
      COALESCE(adj.promo_disc, 0) AS "promotionDiscounts",
      (t.gross - t.item_disc - COALESCE(adj.group_disc, 0) - COALESCE(adj.promo_disc, 0)) AS "netRevenue",
      t.cogs AS "totalCost",
      (t.gross - t.item_disc - COALESCE(adj.group_disc, 0) - COALESCE(adj.promo_disc, 0) - t.cogs) AS "netProfit"
    FROM (
      SELECT customer_group_id,
        COUNT(DISTINCT sale_id)::int AS "salesCount",
        COALESCE(SUM(gross), 0)::numeric AS gross,
        COALESCE(SUM(item_disc), 0)::numeric AS item_disc,
        COALESCE(SUM(cogs), 0)::numeric AS cogs
      FROM base
      GROUP BY customer_group_id
    ) t
    LEFT JOIN adj ON adj.customer_group_id IS NOT DISTINCT FROM t.customer_group_id
    LEFT JOIN customer_groups g ON g.id = t.customer_group_id
    ORDER BY "netProfit" DESC
  `);

  const rows = (result.rows as Record<string, unknown>[]).map((r) => {
    const grossSales = Number(r.grossSales ?? 0);
    const itemDiscounts = Number(r.itemDiscounts ?? 0);
    const groupDiscounts = Number(r.groupDiscounts ?? 0);
    const promotionDiscounts = Number(r.promotionDiscounts ?? 0);
    const totalCost = Number(r.totalCost ?? 0);
    const netRevenue = grossSales - itemDiscounts - groupDiscounts - promotionDiscounts;
    const netProfit = netRevenue - totalCost;
    return {
      groupId: r.groupId == null ? null : Number(r.groupId),
      groupName: String(r.groupName ?? "No group"),
      salesCount: Number(r.salesCount ?? 0),
      grossSales,
      itemDiscounts,
      groupDiscounts,
      promotionDiscounts,
      netRevenue,
      totalCost,
      netProfit,
      marginPercent:
        netRevenue > 0 ? Math.round((netProfit / netRevenue) * 10000) / 100 : 0,
    };
  });
  return { rows };
}

export interface PromotionPerformanceRow {
  promotionId: number;
  promotionName: string;
  salesCount: number;
  totalDiscount: number;
}

export async function getPromotionPerformanceReport(
  businessId: number,
  params: DateRangeQuery,
  locationId?: number,
): Promise<{ rows: PromotionPerformanceRow[] }> {
  const { start, end } = getDateBounds(params);

  const result = await db.execute(sql`
    WITH usage AS (
      SELECT
        (a.adj->>'refId')::int AS promotion_id,
        COUNT(DISTINCT s.id)::int AS "salesCount",
        COALESCE(SUM((a.adj->>'amount')::numeric), 0)::numeric AS total_disc
      FROM sales s
      INNER JOIN sale_items si ON si.sale_id = s.id AND si.business_id = s.business_id
      CROSS JOIN LATERAL jsonb_array_elements(si.price_adjustments) a(adj)
      WHERE s.business_id = ${businessId}
        AND s.created_at >= ${start}::timestamp
        AND s.created_at <= ${end}::timestamp${locationFilter("s", locationId)}
        AND a.adj->>'kind' = 'promotion'
        AND a.adj->>'refId' IS NOT NULL
      GROUP BY 1
    )
    SELECT
      u.promotion_id AS "promotionId",
      COALESCE(pp.name, 'Removed promotion #' || u.promotion_id) AS "promotionName",
      u."salesCount",
      u.total_disc AS "totalDiscount"
    FROM usage u
    LEFT JOIN pricing_promotions pp
      ON pp.id = u.promotion_id AND pp.business_id = ${businessId}
    ORDER BY u.total_disc DESC
  `);

  return {
    rows: (result.rows as Record<string, unknown>[]).map((r) => ({
      promotionId: Number(r.promotionId),
      promotionName: String(r.promotionName ?? ""),
      salesCount: Number(r.salesCount ?? 0),
      totalDiscount: Number(r.totalDiscount ?? 0),
    })),
  };
}
