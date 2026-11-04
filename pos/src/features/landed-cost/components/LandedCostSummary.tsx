import type { AccountingImpact } from "../landedCost.api";

const formatCurrency = (value: number) =>
  `৳${value.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Totals + the expected accounting impact (Part H: preview before posting). */
export function LandedCostSummary({
  totals,
  impact,
}: {
  totals: {
    totalExpenseAmount: number;
    totalCapitalizableAmount: number;
    totalNonCapitalizableAmount: number;
    allocatedTotal: number;
    pendingTotal: number;
  };
  impact: AccountingImpact | null;
}) {
  const card =
    "rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm shadow-slate-950/[0.02]";
  const label = "text-xs font-medium uppercase tracking-wide text-slate-400";
  const value = "mt-1 text-lg font-semibold text-slate-900";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className={card}>
          <p className={label}>Total expenses</p>
          <p className={value}>{formatCurrency(totals.totalExpenseAmount)}</p>
        </div>
        <div className={card}>
          <p className={label}>Capitalizable</p>
          <p className={`${value} text-emerald-700`}>
            {formatCurrency(totals.totalCapitalizableAmount)}
          </p>
        </div>
        <div className={card}>
          <p className={label}>Period expenses</p>
          <p className={value}>
            {formatCurrency(totals.totalNonCapitalizableAmount)}
          </p>
        </div>
        <div className={card}>
          <p className={label}>Allocated</p>
          <p className={`${value} text-sky-700`}>
            {formatCurrency(totals.allocatedTotal)}
          </p>
        </div>
        <div className={card}>
          <p className={label}>Pending (unreceived)</p>
          <p className={`${value} text-amber-700`}>
            {formatCurrency(totals.pendingTotal)}
          </p>
        </div>
      </div>

      {impact ? (
        <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-4">
          <p className="text-sm font-semibold text-slate-700">
            Expected accounting impact
          </p>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
            <span>
              Inventory capitalization:{" "}
              <strong className="text-slate-900">
                {formatCurrency(impact.capitalizableToInventory)}
              </strong>
            </span>
            <span>
              Period expenses:{" "}
              <strong className="text-slate-900">
                {formatCurrency(impact.periodExpenses)}
              </strong>
            </span>
            {impact.bySettlement.map((entry) => (
              <span key={entry.settlementType}>
                {entry.settlementType.replace("_", " ")}:{" "}
                <strong className="text-slate-900">
                  {formatCurrency(entry.amount)}
                </strong>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
