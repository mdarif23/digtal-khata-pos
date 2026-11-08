import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { capitalTransactions } from "../../db/schema/ownerFinance.js";
import { chartOfAccounts } from "../../db/schema/chartOfAccounts.js";
import { journalEntries, journalEntryLines } from "../../db/schema/journalEntries.js";
import { businesses } from "../../db/schema/businesses.js";
import { customers } from "../../db/schema/customers.js";
import { sales } from "../../db/schema/sales.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { businessLocalDate, poishaToMoneyString, toMoneyString } from "../../utils/money.js";
import { getAccountBalances } from "../../services/ledger.js";
import { calculateProfit } from "./finance.profit.service.js";

/**
 * Financial Overview, Cash Flow & Growth Analytics (Finance & Growth
 * Stage 6 / Phases 4-5). Every figure is derived from POSTED ledger
 * entries or the operational tables it reconciles with — documented
 * formula per metric (master prompt §4.A: "each metric must use a
 * documented calculation").
 */

function poisha(balance: string | undefined): number {
  return Math.round(Number(balance ?? 0) * 100);
}

async function businessToday(businessId: number): Promise<string> {
  const [biz] = await db
    .select({ timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return businessLocalDate(new Date(), biz?.timezone ?? "Asia/Dhaka");
}

// ---------------------------------------------------------------------------
// Period presets (business-local dates)
// ---------------------------------------------------------------------------

export interface DateRange {
  from: string;
  to: string;
}

/** Previous range of identical length, ending the day before `from`. */
export function previousRange(range: DateRange): DateRange {
  const fromMs = Date.parse(`${range.from}T00:00:00Z`);
  const toMs = Date.parse(`${range.to}T00:00:00Z`);
  const lengthDays = Math.round((toMs - fromMs) / 86_400_000) + 1;
  const prevTo = new Date(fromMs - 86_400_000);
  const prevFrom = new Date(fromMs - lengthDays * 86_400_000);
  return {
    from: prevFrom.toISOString().slice(0, 10),
    to: prevTo.toISOString().slice(0, 10),
  };
}

/** Supported presets for the growth comparisons (master prompt §5.F). */
export const GROWTH_PERIOD_PRESETS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
] as const;
export type GrowthPeriodPreset = (typeof GROWTH_PERIOD_PRESETS)[number];

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfWeek(date: Date): Date {
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - day);
  return monday;
}

export function presetRange(preset: GrowthPeriodPreset, today: string): DateRange {
  const now = new Date(`${today}T00:00:00Z`);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const shiftDays = (base: Date, days: number) =>
    new Date(base.getTime() + days * 86_400_000);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const yest = iso(shiftDays(now, -1));
      return { from: yest, to: yest };
    }
    case "this_week": {
      const monday = startOfWeek(now);
      return { from: iso(monday), to: iso(shiftDays(monday, 6)) };
    }
    case "last_week": {
      const monday = shiftDays(startOfWeek(now), -7);
      return { from: iso(monday), to: iso(shiftDays(monday, 6)) };
    }
    case "this_month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "last_month": {
      const first = new Date(Date.UTC(y, m - 1, 1));
      const last = new Date(Date.UTC(y, m, 0));
      return { from: iso(first), to: iso(last) };
    }
    case "this_quarter": {
      const qStart = new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1));
      const qEnd = new Date(Date.UTC(y, Math.floor(m / 3) * 3 + 3, 0));
      return { from: iso(qStart), to: iso(qEnd) };
    }
    case "last_quarter": {
      const qm = Math.floor(m / 3) * 3 - 3;
      const qStart = new Date(Date.UTC(y, qm, 1));
      const qEnd = new Date(Date.UTC(y, qm + 3, 0));
      return { from: iso(qStart), to: iso(qEnd) };
    }
    case "this_year":
      return { from: `${y}-01-01`, to: today };
    case "last_year":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  }
}

// ---------------------------------------------------------------------------
// Financial overview (Phase 4.A)
// ---------------------------------------------------------------------------

export interface FinancialOverview {
  range: DateRange;
  profit: {
    netRevenue: string;
    cogs: string;
    grossProfit: string;
    operatingExpenses: string;
    operatingProfit: string;
    interest: string;
    netProfit: string;
  };
  balances: {
    cash: string;
    bank: string;
    mfs: string;
    accountsReceivable: string;
    inventory: string;
    accountsPayable: string;
    vatPayable: string;
    salaryPayable: string;
    loansPayable: string;
    ownerContributions: string;
    ownerDrawings: string;
    retainedEarnings: string;
  };
  owner: {
    contributed: string;
    returned: string;
    distributed: string;
    position: string;
  };
  /** Operational truth the GL inventory reconciles against. */
  inventoryBatchValuation: string;
}

/**
 * METRIC FORMULAS:
 *  - P&L block: see calculateProfit (finance.profit.service) — GL-derived.
 *  - Balances: GL account balances (all posted entries, all time);
 *    credit-normal accounts are negated to natural-positive values:
 *    cash = bal(1010), bank = bal(1020), mfs = bal(1030),
 *    AR = bal(1040), inventory = bal(1050), AP = −bal(2010),
 *    VAT payable = −bal(2020), salary payable = −bal(2030),
 *    loans = −bal(2080), owner contributions = −bal(3010),
 *    drawings = bal(3020), retained earnings = −bal(3030).
 *  - Owner block: capital transaction aggregates (invested − returned −
 *    distributed); reconciles with the 3010/3020 balances.
 *  - inventoryBatchValuation = Σ qty_remaining × landed_cost_per_unit over
 *    inventory_batches (operational truth; the GL 1050 should match).
 */
export async function getFinancialOverview(
  businessId: number,
  from: string,
  to: string,
): Promise<FinancialOverview> {
  const [profit, allTimeBalances, capitalTotals, batchValuation] = await Promise.all([
    calculateProfit(businessId, from, to),
    getAccountBalances(db, businessId, {}),
    db
      .select({
        contributed: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'investment'), 0)`,
        returned: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'withdrawal'), 0)`,
        distributed: sql<string>`coalesce(sum(${capitalTransactions.amount}) filter (where ${capitalTransactions.type} = 'distribution'), 0)`,
      })
      .from(capitalTransactions)
      .where(eq(capitalTransactions.businessId, businessId)),
    db
      .select({
        total: sql<string>`coalesce(sum(${inventoryBatches.quantityRemaining} * ${inventoryBatches.landedCostPerUnit}), 0)`,
      })
      .from(inventoryBatches)
      .where(eq(inventoryBatches.businessId, businessId)),
  ]);

  const byCode = new Map(allTimeBalances.map((b) => [b.code, b]));
  const money = (poishaValue: number) => poishaToMoneyString(poishaValue);

  const contributedPoisha = poisha(capitalTotals[0]?.contributed);
  const returnedPoisha = poisha(capitalTotals[0]?.returned);
  const distributedPoisha = poisha(capitalTotals[0]?.distributed);

  return {
    range: { from, to },
    profit: {
      netRevenue: profit.netRevenue,
      cogs: profit.cogs,
      grossProfit: profit.grossProfit,
      operatingExpenses: profit.operatingExpenses,
      operatingProfit: profit.operatingProfit,
      interest: profit.interest,
      netProfit: profit.netProfit,
    },
    balances: {
      cash: money(poisha(byCode.get("1010")?.balance)),
      bank: money(poisha(byCode.get("1020")?.balance)),
      mfs: money(poisha(byCode.get("1030")?.balance)),
      accountsReceivable: money(poisha(byCode.get("1040")?.balance)),
      inventory: money(poisha(byCode.get("1050")?.balance)),
      accountsPayable: money(-poisha(byCode.get("2010")?.balance)),
      vatPayable: money(-poisha(byCode.get("2020")?.balance)),
      salaryPayable: money(-poisha(byCode.get("2030")?.balance)),
      loansPayable: money(-poisha(byCode.get("2080")?.balance)),
      ownerContributions: money(-poisha(byCode.get("3010")?.balance)),
      ownerDrawings: money(poisha(byCode.get("3020")?.balance)),
      retainedEarnings: money(-poisha(byCode.get("3030")?.balance)),
    },
    owner: {
      contributed: money(contributedPoisha),
      returned: money(returnedPoisha),
      distributed: money(distributedPoisha),
      position: money(contributedPoisha - returnedPoisha - distributedPoisha),
    },
    inventoryBatchValuation: money(poisha(batchValuation[0]?.total)),
  };
}

// ---------------------------------------------------------------------------
// Cash flow (Phase 4.B) — direct method from the GL cash accounts
// ---------------------------------------------------------------------------

export interface CashFlowReport {
  range: DateRange;
  totals: { inflow: string; outflow: string; net: string };
  byCategory: Record<"operating" | "investing" | "financing", { inflow: string; outflow: string; net: string }>;
  bySource: {
    sourceType: string;
    category: string;
    inflow: string;
    outflow: string;
    net: string;
  }[];
  series: { date: string; inflow: string; outflow: string; net: string }[];
  reconciliation: {
    /** All-time cash balance before `from` (poisha-exact reconciliation). */
    openingBalance: string;
    closingBalance: string;
    /** closing − opening; must equal totals.net (tested invariant). */
    netMovement: string;
  };
}

/**
 * DIRECT-METHOD CASH FLOW: every journal line on a cash-equivalent account
 * (chart_of_accounts.is_cash: 1010 drawers / 1020 bank / 1030 MFS) in the
 * range is an inflow (debit) or outflow (credit). Classification comes from
 * the entry's cashFlowCategory (set by the posting hooks) and sourceType
 * gives the "by source" breakdown (sales collections, owner investments,
 * supplier payments, payroll, owner withdrawals…). Credit sales are NOT
 * here — only collected money moves cash accounts.
 */
export async function getCashFlow(
  businessId: number,
  from: string,
  to: string,
): Promise<CashFlowReport> {
  const cashAccounts = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(
      and(eq(chartOfAccounts.businessId, businessId), eq(chartOfAccounts.isCash, true)),
    );
  const cashIds = cashAccounts.map((a) => a.id);

  const empty = { inflow: "0.00", outflow: "0.00", net: "0.00" };
  if (cashIds.length === 0) {
    return {
      range: { from, to },
      totals: empty,
      byCategory: { operating: empty, investing: empty, financing: empty },
      bySource: [],
      series: [],
      reconciliation: {
        openingBalance: "0.00",
        closingBalance: "0.00",
        netMovement: "0.00",
      },
    };
  }

  const rows = await db
    .select({
      category: journalEntries.cashFlowCategory,
      sourceType: sql<string>`coalesce(${journalEntries.sourceType}, 'manual')`,
      day: sql<string>`to_char(${journalEntries.entryDate}, 'YYYY-MM-DD')`,
      inflow: sql<string>`coalesce(sum(${journalEntryLines.debit}), 0)`,
      outflow: sql<string>`coalesce(sum(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(
      journalEntries,
      and(
        eq(journalEntries.id, journalEntryLines.entryId),
        inArray(journalEntries.status, ["posted", "reversed"]),
      ),
    )
    .where(
      and(
        eq(journalEntryLines.businessId, businessId),
        inArray(journalEntryLines.accountId, cashIds),
        gte(journalEntries.entryDate, from),
        lte(journalEntries.entryDate, to),
      ),
    )
    .groupBy(
      journalEntries.cashFlowCategory,
      sql`coalesce(${journalEntries.sourceType}, 'manual')`,
      sql`to_char(${journalEntries.entryDate}, 'YYYY-MM-DD')`,
    );

  let inflowPoisha = 0;
  let outflowPoisha = 0;
  const categoryTotals = new Map<string, { inflow: number; outflow: number }>();
  const sourceTotals = new Map<string, { category: string; inflow: number; outflow: number }>();
  const dayTotals = new Map<string, { inflow: number; outflow: number }>();
  for (const row of rows) {
    const inP = poisha(row.inflow);
    const outP = poisha(row.outflow);
    inflowPoisha += inP;
    outflowPoisha += outP;
    const cat = categoryTotals.get(row.category) ?? { inflow: 0, outflow: 0 };
    cat.inflow += inP;
    cat.outflow += outP;
    categoryTotals.set(row.category, cat);
    const sourceKey = row.sourceType;
    const source = sourceTotals.get(sourceKey) ?? {
      category: row.category,
      inflow: 0,
      outflow: 0,
    };
    source.inflow += inP;
    source.outflow += outP;
    sourceTotals.set(sourceKey, source);
    const day = dayTotals.get(row.day) ?? { inflow: 0, outflow: 0 };
    day.inflow += inP;
    day.outflow += outP;
    dayTotals.set(row.day, day);
  }

  const line = (inP: number, outP: number) => ({
    inflow: poishaToMoneyString(inP),
    outflow: poishaToMoneyString(outP),
    net: poishaToMoneyString(inP - outP),
  });

  // Reconciliation: all-time cash balances before `from` and through `to`.
  const openingRows = await getAccountBalances(db, businessId, { toDate: prevDay(from) });
  const closingRows = await getAccountBalances(db, businessId, { toDate: to });
  const cashCodes = new Set(["1010", "1020", "1030"]);
  const sumCash = (balances: { code: string; balance: string }[]) =>
    balances.filter((b) => cashCodes.has(b.code)).reduce((s, b) => s + poisha(b.balance), 0);
  const openingPoisha = sumCash(openingRows);
  const closingPoisha = sumCash(closingRows);

  return {
    range: { from, to },
    totals: line(inflowPoisha, outflowPoisha),
    byCategory: {
      operating: line(
        categoryTotals.get("operating")?.inflow ?? 0,
        categoryTotals.get("operating")?.outflow ?? 0,
      ),
      investing: line(
        categoryTotals.get("investing")?.inflow ?? 0,
        categoryTotals.get("investing")?.outflow ?? 0,
      ),
      financing: line(
        categoryTotals.get("financing")?.inflow ?? 0,
        categoryTotals.get("financing")?.outflow ?? 0,
      ),
    },
    bySource: [...sourceTotals.entries()]
      .map(([sourceType, s]) => ({
        sourceType,
        category: s.category,
        ...line(s.inflow, s.outflow),
      }))
      .sort((a, b) => a.sourceType.localeCompare(b.sourceType)),
    series: [...dayTotals.entries()]
      .map(([date, d]) => ({ date, ...line(d.inflow, d.outflow) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    reconciliation: {
      openingBalance: poishaToMoneyString(openingPoisha),
      closingBalance: poishaToMoneyString(closingPoisha),
      netMovement: poishaToMoneyString(closingPoisha - openingPoisha),
    },
  };
}

function prevDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// Growth analytics (Phase 5)
// ---------------------------------------------------------------------------

interface PeriodMetrics {
  from: string;
  to: string;
  partial: boolean;
  netRevenue: string;
  cogs: string;
  grossProfit: string;
  grossMarginPercent: number | null;
  operatingExpenses: string;
  netProfit: string;
  netMarginPercent: number | null;
  expensesTotal: string;
  expenseToRevenueRatioPercent: number | null;
  employeeCost: string;
  employeeCostRatioPercent: number | null;
  salesCount: number;
  averageOrderValue: string;
  newCustomers: number;
  /** COGS ÷ current batch inventory value (point-in-time approximation). */
  inventoryTurnover: number | null;
  /** 365 ÷ turnover (days of stock on hand). */
  stockHoldingDays: number | null;
  /** Annualized net profit ÷ invested capital (owner position + loans). */
  returnOnInvestedCapitalPercent: number | null;
}

async function computePeriodMetrics(
  businessId: number,
  range: DateRange,
  today: string,
): Promise<PeriodMetrics> {
  const profit = await calculateProfit(businessId, range.from, range.to);
  const netRevenuePoisha = poisha(profit.netRevenue);
  const grossProfitPoisha = poisha(profit.grossProfit);
  const netProfitPoisha = poisha(profit.netProfit);
  const expensesPoisha = poisha(profit.operatingExpenses) + poisha(profit.interest);
  const employeeCostPoisha = poisha(
    (
      await getAccountBalances(db, businessId, {
        fromDate: range.from,
        toDate: range.to,
      })
    )
      .filter((b) => b.code === "5020")
      .map((b) => b.balance)
      .reduce((s, balance) => s + poisha(balance), 0)
      .toString(),
  );

  const [salesCountRow] = await db
    .select({ value: sql<string>`count(*)` })
    .from(sales)
    .where(
      and(
        eq(sales.businessId, businessId),
        sql`${sales.saleDate} >= ${`${range.from}T00:00:00`}`,
        sql`${sales.saleDate} <= ${`${range.to}T23:59:59.999`}`,
        inArray(sales.status, ["completed", "refunded"]),
      ),
    );
  const [newCustomersRow] = await db
    .select({ value: sql<string>`count(*)` })
    .from(customers)
    .where(
      and(
        eq(customers.businessId, businessId),
        sql`${customers.createdAt} >= ${`${range.from}T00:00:00`}`,
        sql`${customers.createdAt} <= ${`${range.to}T23:59:59.999`}`,
      ),
    );
  const [inventoryValueRow] = await db
    .select({
      total: sql<string>`coalesce(sum(${inventoryBatches.quantityRemaining} * ${inventoryBatches.landedCostPerUnit}), 0)`,
    })
    .from(inventoryBatches)
    .where(eq(inventoryBatches.businessId, businessId));
  const equityBalances = await getAccountBalances(db, businessId, {});
  const equityByCode = new Map(equityBalances.map((b) => [b.code, b]));
  const ownerPosition =
    -poisha(equityByCode.get("3010")?.balance) - poisha(equityByCode.get("3020")?.balance);
  const loansPayablePoisha = -poisha(equityByCode.get("2080")?.balance);

  const salesCount = Number(salesCountRow?.value ?? 0);
  const inventoryValue = poisha(inventoryValueRow?.total);
  const investedCapitalPoisha = ownerPosition + loansPayablePoisha;
  const daysInRange =
    Math.round(
      (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  const annualizationFactor = 365 / daysInRange;

  const pct = (numerator: number, denominator: number): number | null =>
    denominator === 0 ? null : round2((numerator / denominator) * 100);

  return {
    from: range.from,
    to: range.to,
    partial: range.to >= today,
    netRevenue: profit.netRevenue,
    cogs: profit.cogs,
    grossProfit: profit.grossProfit,
    grossMarginPercent: pct(grossProfitPoisha, netRevenuePoisha),
    operatingExpenses: profit.operatingExpenses,
    netProfit: profit.netProfit,
    netMarginPercent: pct(netProfitPoisha, netRevenuePoisha),
    expensesTotal: poishaToMoneyString(expensesPoisha),
    expenseToRevenueRatioPercent: pct(expensesPoisha, netRevenuePoisha),
    employeeCost: poishaToMoneyString(employeeCostPoisha),
    employeeCostRatioPercent: pct(employeeCostPoisha, netRevenuePoisha),
    salesCount,
    averageOrderValue:
      salesCount === 0
        ? "0.00"
        : poishaToMoneyString(Math.round(netRevenuePoisha / salesCount)),
    newCustomers: Number(newCustomersRow?.value ?? 0),
    inventoryTurnover:
      inventoryValue <= 0 ? null : round2(netRevenuePoisha > 0 ? poisha(profit.cogs) / inventoryValue : 0),
    stockHoldingDays:
      inventoryValue <= 0 || poisha(profit.cogs) <= 0
        ? null
        : round2(365 / (poisha(profit.cogs) / inventoryValue)),
    returnOnInvestedCapitalPercent:
      investedCapitalPoisha <= 0
        ? null
        : pct(Math.round(netProfitPoisha * annualizationFactor), investedCapitalPoisha),
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function changePercent(current: number, previous: number): number | null {
  if (previous === 0) return null; // zero denominator → insufficient data
  return round2(((current - previous) / previous) * 100);
}

export interface GrowthReport {
  period: GrowthPeriodPreset | "custom";
  current: PeriodMetrics;
  previous: PeriodMetrics;
  changes: {
    netRevenuePercent: number | null;
    grossProfitPercent: number | null;
    netProfitPercent: number | null;
    expensesPercent: number | null;
    salesCountPercent: number | null;
    averageOrderValuePercent: number | null;
    newCustomersPercent: number | null;
  };
  insights: { type: "positive" | "warning"; message: string; evidence: string }[];
}

/**
 * Growth analytics: current vs previous period of identical length
 * (preset or custom), documented KPIs, and RULE-BASED insights derived
 * only from the verified figures above — no speculative claims.
 */
export async function getGrowthAnalytics(
  businessId: number,
  options: { period?: GrowthPeriodPreset; from?: string; to?: string },
): Promise<GrowthReport> {
  const today = await businessToday(businessId);
  let range: DateRange;
  let period: GrowthReport["period"];
  if (options.from && options.to) {
    range = { from: options.from, to: options.to };
    period = "custom";
  } else {
    const preset = options.period ?? "this_month";
    if (!(GROWTH_PERIOD_PRESETS as readonly string[]).includes(preset)) {
      throw new Error(`Unknown period preset "${preset}"`);
    }
    range = presetRange(preset, today);
    period = preset;
  }

  const current = await computePeriodMetrics(businessId, range, today);
  const previous = await computePeriodMetrics(
    businessId,
    previousRange(range),
    today,
  );

  const num = (value: string) => Number(value);
  const changes = {
    netRevenuePercent: changePercent(num(current.netRevenue), num(previous.netRevenue)),
    grossProfitPercent: changePercent(num(current.grossProfit), num(previous.grossProfit)),
    netProfitPercent: changePercent(num(current.netProfit), num(previous.netProfit)),
    expensesPercent: changePercent(num(current.expensesTotal), num(previous.expensesTotal)),
    salesCountPercent: changePercent(current.salesCount, previous.salesCount),
    averageOrderValuePercent: changePercent(
      num(current.averageOrderValue),
      num(previous.averageOrderValue),
    ),
    newCustomersPercent: changePercent(current.newCustomers, previous.newCustomers),
  };

  // Rule-based insights (verified figures only).
  const insights: GrowthReport["insights"] = [];
  const revUp = changes.netRevenuePercent;
  const profitDown = changes.netProfitPercent;
  if (revUp != null && profitDown != null && revUp >= 5 && profitDown <= -5) {
    insights.push({
      type: "warning",
      message: "Sales increased but net profit decreased — margins or costs need attention.",
      evidence: `Revenue ${revUp > 0 ? "+" : ""}${revUp}% vs net profit ${profitDown}% (${previous.netProfit} → ${current.netProfit}).`,
    });
  }
  if (
    current.netMarginPercent != null &&
    current.netRevenue !== "0.00" &&
    current.netMarginPercent < 5
  ) {
    insights.push({
      type: "warning",
      message: "Net margin is thin.",
      evidence: `Net profit ${current.netProfit} on revenue ${current.netRevenue} (${current.netMarginPercent}%).`,
    });
  }
  if (current.employeeCostRatioPercent != null && current.employeeCostRatioPercent > 25) {
    insights.push({
      type: "warning",
      message: "Salary costs are high relative to revenue.",
      evidence: `Salaries ${current.employeeCost} = ${current.employeeCostRatioPercent}% of revenue.`,
    });
  }
  if (
    current.inventoryTurnover != null &&
    previous.inventoryTurnover != null &&
    previous.inventoryTurnover > 0 &&
    current.inventoryTurnover < previous.inventoryTurnover * 0.8
  ) {
    insights.push({
      type: "warning",
      message: "Inventory is turning over more slowly than the previous period.",
      evidence: `Turnover ${previous.inventoryTurnover}× → ${current.inventoryTurnover}×.`,
    });
  }
  if (
    current.grossMarginPercent != null &&
    previous.grossMarginPercent != null &&
    current.grossMarginPercent - previous.grossMarginPercent >= 2
  ) {
    insights.push({
      type: "positive",
      message: "Gross profit margin improved.",
      evidence: `${previous.grossMarginPercent}% → ${current.grossMarginPercent}%.`,
    });
  }
  if (changes.netRevenuePercent != null && changes.netRevenuePercent >= 10) {
    insights.push({
      type: "positive",
      message: "Revenue is growing strongly.",
      evidence: `+${changes.netRevenuePercent}% vs the previous period.`,
    });
  }

  return { period, current, previous, changes, insights };
}
