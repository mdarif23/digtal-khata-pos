import { sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { variantOptionsJoinSql } from "../../utils/variantDisplay.js";
import { expenses } from "../../db/schema/expenses.js";
import { expenseCategories } from "../../db/schema/expenseCategories.js";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";

/**
 * Online Store Profitability (module three). All figures derive from
 * PERSISTED order-time snapshots — never current product prices:
 *
 *   Net Product Sales  = Σ(final_total − vat − delivery_fee)   [completed]
 *                      − Σ sale_refunds.refund_total
 *   COGS               = Σ(cost_at_sale × qty) − restocked cost
 *   Gross Profit       = Net Product Sales − COGS
 *   Net Contribution   = Gross Profit
 *                      + shipping income (delivery_fee)
 *                      − courier expense (sale_shipments.shipping_cost)
 *                      − packaging expense (sale_packages.packing_cost)
 *                      − gateway fees (sale_payments.gateway_fee)
 *                      − marketplace commission (sales.marketplace_commission)
 *
 * Population: sales with channel <> 'pos'. Pending and cancelled orders are
 * NEVER counted as sales; shipping income stays separate from product
 * sales; VAT (collected tax) is excluded from revenue. Per-order cost
 * components are pre-aggregated with LATERAL joins (never multiplied across
 * package/payment rows). This is a CONTRIBUTION report — operating expenses
 * (rent, salaries…) only enter the separate channel-scoped operating view.
 */

export interface ProfitabilityFilters {
  /** ISO dates (YYYY-MM-DD), inclusive, on the sale date. */
  from?: string | undefined;
  to?: string | undefined;
  locationId?: number | undefined;
  channel?: "woocommerce" | "custom_storefront" | undefined;
  courierName?: string | undefined;
  paymentMethod?: string | undefined;
}

export interface ProfitabilitySummary {
  totalOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  refundCount: number;
  grossProductSales: number;
  discounts: number;
  productRefunds: number;
  netProductSales: number;
  cogs: number;
  restockedCost: number;
  grossProfit: number;
  shippingIncome: number;
  courierExpense: number;
  packagingExpense: number;
  gatewayFees: number;
  marketplaceCommission: number;
  netContributionProfit: number;
  grossMarginPercent: number | null;
  contributionMarginPercent: number | null;
}

export interface TrendPoint {
  date: string;
  netProductSales: number;
  cogs: number;
  grossProfit: number;
  shippingIncome: number;
  netContribution: number;
  orders: number;
}

export interface ProductProfitRow {
  variantId: number;
  productName: string;
  variantOptions: string | null;
  variantName: string | null;
  sku: string;
  categoryName: string | null;
  quantitySold: number;
  grossRevenue: number;
  refundedRevenue: number;
  netRevenue: number;
  cogs: number;
  restockedCost: number;
  grossProfit: number;
  marginPercent: number | null;
  returnQuantity: number;
}

export interface ChannelProfitRow {
  channel: string;
  orders: number;
  netProductSales: number;
  cogs: number;
  grossProfit: number;
  shippingIncome: number;
  courierExpense: number;
  packagingExpense: number;
  gatewayFees: number;
  marketplaceCommission: number;
  netContribution: number;
}

export interface ChannelExpenseRow {
  categoryId: number | null;
  categoryName: string | null;
  channel: string | null;
  amount: number;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** WHERE fragment scoping the online sales population (parameter-bound). */
function populationSql(businessId: number, filters: ProfitabilityFilters): SQL {
  const parts = [sql`s.business_id = ${businessId}`, sql`s.channel <> 'pos'`];
  if (filters.from) parts.push(sql`s.purchase_date >= ${`${filters.from}T00:00:00`}::timestamptz`);
  if (filters.to) parts.push(sql`s.purchase_date <= ${`${filters.to}T23:59:59.999`}::timestamptz`);
  if (filters.locationId) parts.push(sql`s.location_id = ${filters.locationId}`);
  if (filters.channel) parts.push(sql`s.channel = ${filters.channel}`);
  if (filters.courierName) {
    parts.push(
      sql`exists (select 1 from sale_shipments sh where sh.sale_id = s.id and sh.courier_name = ${filters.courierName})`,
    );
  }
  if (filters.paymentMethod) {
    parts.push(
      sql`exists (select 1 from sale_payments sp where sp.sale_id = s.id and sp.payment_method = ${filters.paymentMethod})`,
    );
  }
  return sql.join(parts, sql` and `);
}

type SQL = ReturnType<typeof sql>;

// ---------------------------------------------------------------------------
// Summary — the §9 worked example must reproduce exactly (integration test)
// ---------------------------------------------------------------------------

export async function getProfitabilitySummary(
  businessId: number,
  filters: ProfitabilityFilters,
): Promise<ProfitabilitySummary> {
  const pop = populationSql(businessId, filters);
  const result = await db.execute(sql`
    with pop as (
      select s.id, s.status, s.final_total, s.vat, s.delivery_fee,
             s.discount, s.marketplace_commission
      from sales s
      where ${pop}
    ),
    refunds as (
      select count(*)::int as refund_count,
             coalesce(sum(r.refund_total), 0)::float8 as product_refunds
      from sale_refunds r
      where r.business_id = ${businessId}
        and exists (
          select 1 from sales s2
          where s2.id = r.sale_id and s2.business_id = ${businessId}
            and s2.channel <> 'pos'
        )
        ${filters.from ? sql`and r.created_at >= ${`${filters.from}T00:00:00`}::timestamptz` : sql``}
        ${filters.to ? sql`and r.created_at <= ${`${filters.to}T23:59:59.999`}::timestamptz` : sql``}
    ),
    restock as (
      select coalesce(sum(b.purchase_price * ri.quantity), 0)::float8 as restocked_cost
      from sale_refunds r
      join sale_refund_items ri on ri.refund_id = r.id
      join inventory_batches b
        on b.batch_number = 'RETURN-' || r.id::text || '-' || ri.sale_item_id::text
       and b.business_id = ${businessId}
      where r.business_id = ${businessId}
        and r.status = 'restock'
        and exists (
          select 1 from sales s2
          where s2.id = r.sale_id and s2.business_id = ${businessId}
            and s2.channel <> 'pos'
        )
        ${filters.from ? sql`and r.created_at >= ${`${filters.from}T00:00:00`}::timestamptz` : sql``}
        ${filters.to ? sql`and r.created_at <= ${`${filters.to}T23:59:59.999`}::timestamptz` : sql``}
    )
    select
      (select count(*)::int from pop) as total_orders,
      (select count(*)::int from pop where status = 'completed') as completed_orders,
      (select count(*)::int from pop where status = 'cancelled') as cancelled_orders,
      (select coalesce(sum(final_total - vat - delivery_fee), 0)::float8 from pop where status in ('completed', 'refunded')) as net_product_sales,
      (select coalesce(sum(final_total - vat), 0)::float8 from pop where status in ('completed', 'refunded')) as gross_product_sales,
      (select coalesce(sum(discount), 0)::float8 from pop where status in ('completed', 'refunded')) as discounts,
      (select coalesce(sum(delivery_fee), 0)::float8 from pop where status in ('completed', 'refunded')) as shipping_income,
      (select coalesce(sum(marketplace_commission), 0)::float8 from pop where status in ('completed', 'refunded')) as marketplace_commission,
      (select coalesce(sum(si.cost_at_sale * si.quantity), 0)::float8
         from sale_items si join pop on pop.id = si.sale_id
        where pop.status in ('completed', 'refunded')) as cogs_gross,
      (select coalesce(sum(sh.shipping_cost), 0)::float8
         from sale_shipments sh join pop on pop.id = sh.sale_id) as courier_expense,
      (select coalesce(sum(p.packing_cost), 0)::float8
         from sale_packages p join pop on pop.id = p.sale_id) as packaging_expense,
      (select coalesce(sum(sp.gateway_fee), 0)::float8
         from sale_payments sp join pop on pop.id = sp.sale_id) as gateway_fees,
      (select refund_count from refunds) as refund_count,
      (select product_refunds from refunds) as product_refunds,
      (select restocked_cost from restock) as restocked_cost
  `);

  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const netProductSales = round2(num(row.net_product_sales) - num(row.product_refunds));
  const cogs = round2(Math.max(0, num(row.cogs_gross) - num(row.restocked_cost)));
  const grossProfit = round2(netProductSales - cogs);
  const netContribution = round2(
    grossProfit +
      num(row.shipping_income) -
      num(row.courier_expense) -
      num(row.packaging_expense) -
      num(row.gateway_fees) -
      num(row.marketplace_commission),
  );

  return {
    totalOrders: num(row.total_orders),
    completedOrders: num(row.completed_orders),
    cancelledOrders: num(row.cancelled_orders),
    refundCount: num(row.refund_count),
    grossProductSales: round2(num(row.gross_product_sales)),
    discounts: round2(num(row.discounts)),
    productRefunds: round2(num(row.product_refunds)),
    netProductSales,
    cogs,
    restockedCost: round2(num(row.restocked_cost)),
    grossProfit,
    shippingIncome: round2(num(row.shipping_income)),
    courierExpense: round2(num(row.courier_expense)),
    packagingExpense: round2(num(row.packaging_expense)),
    gatewayFees: round2(num(row.gateway_fees)),
    marketplaceCommission: round2(num(row.marketplace_commission)),
    netContributionProfit: netContribution,
    grossMarginPercent:
      netProductSales > 0 ? round2((grossProfit / netProductSales) * 100) : null,
    contributionMarginPercent:
      netProductSales > 0
        ? round2((netContribution / netProductSales) * 100)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Trends — per-sale LATERAL pre-aggregation, grouped by sale day
// ---------------------------------------------------------------------------

export async function getProfitabilityTrends(
  businessId: number,
  filters: ProfitabilityFilters,
): Promise<TrendPoint[]> {
  const pop = populationSql(businessId, filters);
  const result = await db.execute(sql`
    with daily as (
      select to_char(s.purchase_date, 'YYYY-MM-DD') as day,
        coalesce(sum(case when s.status in ('completed', 'refunded')
          then s.final_total - s.vat - s.delivery_fee else 0 end), 0)::float8 as revenue_gross,
        coalesce(sum(case when s.status in ('completed', 'refunded') then x.cogs else 0 end), 0)::float8 as cogs,
        coalesce(sum(case when s.status in ('completed', 'refunded') then s.delivery_fee else 0 end), 0)::float8 as shipping_income,
        coalesce(sum(x.courier), 0)::float8 as courier_expense,
        coalesce(sum(x.packaging), 0)::float8 as packaging_expense,
        coalesce(sum(x.fees), 0)::float8 as gateway_fees,
        coalesce(sum(case when s.status in ('completed', 'refunded') then s.marketplace_commission else 0 end), 0)::float8 as commission,
        count(*) filter (where s.status = 'completed')::int as orders
      from sales s
      join lateral (
        select
          (select coalesce(sum(si.cost_at_sale * si.quantity), 0) from sale_items si where si.sale_id = s.id) as cogs,
          (select coalesce(sum(sh.shipping_cost), 0) from sale_shipments sh where sh.sale_id = s.id) as courier,
          (select coalesce(sum(p.packing_cost), 0) from sale_packages p where p.sale_id = s.id) as packaging,
          (select coalesce(sum(sp.gateway_fee), 0) from sale_payments sp where sp.sale_id = s.id) as fees
      ) x on true
      where ${pop}
      group by 1
    ),
    refund_days as (
      select to_char(r.created_at, 'YYYY-MM-DD') as day,
        coalesce(sum(r.refund_total), 0)::float8 as refunded
      from sale_refunds r
      where r.business_id = ${businessId}
        and exists (
          select 1 from sales s2
          where s2.id = r.sale_id and s2.business_id = ${businessId}
            and s2.channel <> 'pos'
        )
        ${filters.from ? sql`and r.created_at >= ${`${filters.from}T00:00:00`}::timestamptz` : sql``}
        ${filters.to ? sql`and r.created_at <= ${`${filters.to}T23:59:59.999`}::timestamptz` : sql``}
      group by 1
    )
    select d.*, coalesce(rd.refunded, 0)::float8 as product_refunds
    from daily d left join refund_days rd on rd.day = d.day
    order by d.day
  `);

  return result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    // Refunds (by refund date) deduct from the SAME policy as the summary:
    // revenue includes refunded sales, the refund nets them out once.
    const netProductSales = round2(
      num(row.revenue_gross) - num(row.product_refunds),
    );
    const cogs = round2(num(row.cogs));
    const grossProfit = round2(netProductSales - cogs);
    return {
      date: String(row.day),
      netProductSales,
      cogs,
      grossProfit,
      shippingIncome: round2(num(row.shipping_income)),
      netContribution: round2(
        grossProfit +
          num(row.shipping_income) -
          num(row.courier_expense) -
          num(row.packaging_expense) -
          num(row.gateway_fees) -
          num(row.commission),
      ),
      orders: num(row.orders),
    };
  });
}

// ---------------------------------------------------------------------------
// Product profitability (§8.6) — order-time prices and consumed batch costs
// ---------------------------------------------------------------------------

export async function getProfitabilityProducts(
  businessId: number,
  filters: ProfitabilityFilters,
  options: {
    page?: number | undefined;
    pageSize?: number | undefined;
    sort?: string | undefined;
  } = {},
): Promise<{
  rows: ProductProfitRow[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 25));
  const offset = (page - 1) * pageSize;
  const pop = populationSql(businessId, filters);
  const orderClause =
    options.sort === "margin"
      ? sql`order by case when net_revenue > 0 then gross_profit / net_revenue else -1 end desc`
      : options.sort === "losses"
        ? sql`order by gross_profit asc`
        : sql`order by gross_profit desc`;

  const result = await db.execute(sql`
    with sales_agg as (
      select si.variant_id,
        sum(si.quantity)::int as qty_sold,
        coalesce(sum(si.line_total), 0)::float8 as gross_revenue,
        coalesce(sum(si.cost_at_sale * si.quantity), 0)::float8 as cogs
      from sale_items si
      join sales s on s.id = si.sale_id
      where ${pop} and s.status in ('completed', 'refunded')
      group by si.variant_id
    ),
    refund_agg as (
      select si.variant_id,
        coalesce(sum(ri.quantity), 0)::int as return_qty,
        coalesce(sum(ri.refund_total), 0)::float8 as refunded
      from sale_refund_items ri
      join sale_refunds r on r.id = ri.refund_id
      join sales s on s.id = r.sale_id
      join sale_items si on si.id = ri.sale_item_id
      where r.business_id = ${businessId}
        and s.business_id = ${businessId}
        and s.channel <> 'pos'
        ${filters.from ? sql`and r.created_at >= ${`${filters.from}T00:00:00`}::timestamptz` : sql``}
        ${filters.to ? sql`and r.created_at <= ${`${filters.to}T23:59:59.999`}::timestamptz` : sql``}
      group by si.variant_id
    ),
    restock_agg as (
      select si.variant_id,
        coalesce(sum(b.purchase_price * ri.quantity), 0)::float8 as restocked
      from sale_refund_items ri
      join sale_refunds r on r.id = ri.refund_id
      join sales s on s.id = r.sale_id
      join sale_items si on si.id = ri.sale_item_id
      join inventory_batches b
        on b.batch_number = 'RETURN-' || r.id::text || '-' || ri.sale_item_id::text
       and b.business_id = ${businessId}
      where r.business_id = ${businessId}
        and r.status = 'restock'
        and s.business_id = ${businessId}
        and s.channel <> 'pos'
        ${filters.from ? sql`and r.created_at >= ${`${filters.from}T00:00:00`}::timestamptz` : sql``}
        ${filters.to ? sql`and r.created_at <= ${`${filters.to}T23:59:59.999`}::timestamptz` : sql``}
      group by si.variant_id
    )
    select count(*) over () as total_rows,
      sa.variant_id,
      p.name as product_name,
      vol.option_label as variant_options,
      concat(p.name, case when vol.option_label is not null and btrim(vol.option_label) <> '' then concat(' (', vol.option_label, ')') else '' end) as variant_name,
      pv.sku,
      c.name as category_name,
      sa.qty_sold - coalesce(ra.return_qty, 0) as quantity_sold,
      sa.gross_revenue,
      coalesce(ra.return_qty, 0) as return_qty,
      coalesce(ra.refunded, 0) as refunded_revenue,
      sa.cogs,
      coalesce(st.restocked, 0) as restocked_cost,
      (sa.gross_revenue - coalesce(ra.refunded, 0)) - (sa.cogs - coalesce(st.restocked, 0)) as gross_profit
    from sales_agg sa
    join product_variants pv on pv.id = sa.variant_id and pv.business_id = ${businessId}
    join products p on p.id = pv.product_id and p.business_id = ${businessId}
    left join categories c on c.id = p.category_id
    ${variantOptionsJoinSql("pv", "vol")}
    left join refund_agg ra on ra.variant_id = sa.variant_id
    left join restock_agg st on st.variant_id = sa.variant_id
    ${orderClause}
    limit ${pageSize} offset ${offset}
  `);

  const first = (result.rows[0] ?? {}) as Record<string, unknown>;
  const total = result.rows.length > 0 ? num(first.total_rows) : 0;
  const rows = result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const netRevenue = round2(num(row.gross_revenue) - num(row.refunded_revenue));
    const grossProfit = round2(netRevenue - num(row.cogs) + num(row.restocked_cost));
    return {
      variantId: num(row.variant_id),
      productName: String(row.product_name ?? "—"),
      variantOptions: (row.variant_options as string | null) ?? null,
      variantName: (row.variant_name as string | null) ?? null,
      sku: String(row.sku ?? "—"),
      categoryName: row.category_name ? String(row.category_name) : null,
      quantitySold: num(row.quantity_sold),
      grossRevenue: round2(num(row.gross_revenue)),
      refundedRevenue: round2(num(row.refunded_revenue)),
      netRevenue,
      cogs: round2(num(row.cogs)),
      restockedCost: round2(num(row.restocked_cost)),
      grossProfit,
      marginPercent:
        netRevenue > 0 ? round2((grossProfit / netRevenue) * 100) : null,
      returnQuantity: num(row.return_qty),
    };
  });

  return { rows, total, page, pageSize };
}

// ---------------------------------------------------------------------------
// Channel profitability (§8.7)
// ---------------------------------------------------------------------------

export async function getProfitabilityChannels(
  businessId: number,
  filters: Omit<ProfitabilityFilters, "channel">,
): Promise<ChannelProfitRow[]> {
  const pop = populationSql(businessId, filters);
  const result = await db.execute(sql`
    with per_channel as (
      select s.channel::text as channel,
        count(*) filter (where s.status = 'completed')::int as orders,
        coalesce(sum(case when s.status in ('completed', 'refunded')
          then s.final_total - s.vat - s.delivery_fee else 0 end), 0)::float8 as revenue_gross,
        coalesce(sum(case when s.status in ('completed', 'refunded') then x.cogs else 0 end), 0)::float8 as cogs,
        coalesce(sum(case when s.status in ('completed', 'refunded') then s.delivery_fee else 0 end), 0)::float8 as shipping_income,
        coalesce(sum(x.courier), 0)::float8 as courier_expense,
        coalesce(sum(x.packaging), 0)::float8 as packaging_expense,
        coalesce(sum(x.fees), 0)::float8 as gateway_fees,
        coalesce(sum(case when s.status in ('completed', 'refunded') then s.marketplace_commission else 0 end), 0)::float8 as commission
      from sales s
      join lateral (
        select
          (select coalesce(sum(si.cost_at_sale * si.quantity), 0) from sale_items si where si.sale_id = s.id) as cogs,
          (select coalesce(sum(sh.shipping_cost), 0) from sale_shipments sh where sh.sale_id = s.id) as courier,
          (select coalesce(sum(p.packing_cost), 0) from sale_packages p where p.sale_id = s.id) as packaging,
          (select coalesce(sum(sp.gateway_fee), 0) from sale_payments sp where sp.sale_id = s.id) as fees
      ) x on true
      where ${pop}
      group by 1
    ),
    refund_channels as (
      select s2.channel::text as channel,
        coalesce(sum(r.refund_total), 0)::float8 as refunded
      from sale_refunds r
      join sales s2 on s2.id = r.sale_id
      where r.business_id = ${businessId}
        and s2.business_id = ${businessId}
        and s2.channel <> 'pos'
        ${filters.from ? sql`and r.created_at >= ${`${filters.from}T00:00:00`}::timestamptz` : sql``}
        ${filters.to ? sql`and r.created_at <= ${`${filters.to}T23:59:59.999`}::timestamptz` : sql``}
      group by 1
    )
    select pc.*, coalesce(rc.refunded, 0)::float8 as product_refunds
    from per_channel pc left join refund_channels rc on rc.channel = pc.channel
    order by pc.orders desc
  `);

  return result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const netProductSales = round2(
      num(row.revenue_gross) - num(row.product_refunds),
    );
    const cogs = round2(num(row.cogs));
    const grossProfit = round2(netProductSales - cogs);
    return {
      channel: String(row.channel),
      orders: num(row.orders),
      netProductSales,
      cogs,
      grossProfit,
      shippingIncome: round2(num(row.shipping_income)),
      courierExpense: round2(num(row.courier_expense)),
      packagingExpense: round2(num(row.packaging_expense)),
      gatewayFees: round2(num(row.gateway_fees)),
      marketplaceCommission: round2(num(row.commission)),
      netContribution: round2(
        grossProfit +
          num(row.shipping_income) -
          num(row.courier_expense) -
          num(row.packaging_expense) -
          num(row.gateway_fees) -
          num(row.commission),
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Channel-scoped operating expenses (§8.3) — clearly-labelled ESTIMATE
// ---------------------------------------------------------------------------

export async function getProfitabilityExpenses(
  businessId: number,
  filters: ProfitabilityFilters,
): Promise<{ rows: ChannelExpenseRow[]; total: number }> {
  const conditions = [
    eq(expenses.businessId, businessId),
    // Soft-voided expenses never count toward channel profitability.
    isNull(expenses.deletedAt),
  ];
  if (filters.from) conditions.push(gte(expenses.expenseDate, filters.from));
  if (filters.to) conditions.push(lte(expenses.expenseDate, filters.to));
  // Scope: explicit channel, else all (NULL = shared across channels).
  if (filters.channel) {
    conditions.push(
      sql`(${expenses.channel} = ${filters.channel} or ${expenses.channel} is null)`,
    );
  }
  const rows = await db
    .select({
      categoryId: expenses.categoryId,
      categoryName: expenseCategories.categoryName,
      channel: expenses.channel,
      amount: sql<number>`coalesce(sum(${expenses.amount}), 0)::float8`,
    })
    .from(expenses)
    .leftJoin(
      expenseCategories,
      and(
        eq(expenses.categoryId, expenseCategories.id),
        eq(expenseCategories.businessId, businessId),
      ),
    )
    .where(and(...conditions))
    .groupBy(expenses.categoryId, expenseCategories.categoryName, expenses.channel)
    .orderBy(desc(sql`coalesce(sum(${expenses.amount}), 0)`));

  const mapped = rows.map((r) => ({ ...r, amount: round2(num(r.amount)) }));
  return {
    rows: mapped,
    total: round2(mapped.reduce((sum, r) => sum + r.amount, 0)),
  };
}
