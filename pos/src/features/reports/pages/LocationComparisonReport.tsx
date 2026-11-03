import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import {
  reportsApi,
  type LocationComparisonData,
} from "../api/reports.api";
import type { ReportFilters } from "../types/report.types";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { PlanUpgradeCard } from "../components/PlanUpgradeCard";
import type { EntitlementErrorInfo } from "../hooks/useReportData";

/** Extracts the 403 FEATURE_NOT_IN_PLAN payload so the page can show the
 *  upgrade prompt instead of a generic failure toast. */
function extractGate(err: unknown): EntitlementErrorInfo | null {
  const status = (err as { response?: { status?: number } })?.response?.status;
  const body = (err as { response?: { data?: { code?: string; message?: string; upgradePlans?: string[] } } })
    ?.response?.data;
  if (status === 403 && body?.code === "FEATURE_NOT_IN_PLAN") {
    return {
      code: body.code,
      message: body.message ?? "",
      upgradePlans: Array.isArray(body.upgradePlans) ? body.upgradePlans : [],
    };
  }
  return null;
}

/**
 * Owner view: sales, refunds, net and expenses per location for a period.
 * Every location appears, including ones with no activity in the range.
 */
export function LocationComparisonReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
  });
  const [data, setData] = useState<LocationComparisonData | null>(null);
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<EntitlementErrorInfo | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setGate(null);
    try {
      const res = await reportsApi.getLocationComparison(filters);
      setData(res.data.data);
    } catch (err) {
      const gateError = extractGate(err);
      if (gateError) {
        setGate(gateError);
      } else {
        setData(null);
      }
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (value: number) =>
    value.toLocaleString("en-BD", { maximumFractionDigits: 0 });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Location Comparison</h2>
        <p className="text-sm text-slate-500">
          Sales, refunds, net revenue and expenses side by side.
        </p>
      </div>

      <ReportDateFilter
        filters={filters}
        onFiltersChange={setFilters}
        showLocationFilter={false}
      />

      {gate && <PlanUpgradeCard gate={gate} />}

      {loading ? (
        <p className="py-10 text-center text-slate-400">Loading comparison…</p>
      ) : !data || data.rows.length === 0 ? (
        <p className="py-10 text-center text-slate-400">
          No locations to compare yet.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Location</th>
                  <th className="px-4 py-2.5 text-right">Invoices</th>
                  <th className="px-4 py-2.5 text-right">Gross</th>
                  <th className="px-4 py-2.5 text-right">Refunds</th>
                  <th className="px-4 py-2.5 text-right">Net</th>
                  <th className="px-4 py-2.5 text-right">Expenses</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.locationId} className="border-t border-slate-100">
                    <td className="px-4 py-2.5 font-medium">
                      {row.locationName}
                      <span className="ml-2 text-xs font-normal text-slate-400">
                        {row.locationType.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">{row.invoiceCount}</td>
                    <td className="px-4 py-2.5 text-right">{money(Number(row.gross))}</td>
                    <td className="px-4 py-2.5 text-right text-rose-600">
                      {money(Number(row.refunds))}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold">
                      {money(row.net)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {money(Number(row.expenses))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                <tr>
                  <td className="px-4 py-2.5">Total</td>
                  <td className="px-4 py-2.5 text-right">{data.totals.invoiceCount}</td>
                  <td className="px-4 py-2.5 text-right">{money(data.totals.gross)}</td>
                  <td className="px-4 py-2.5 text-right text-rose-600">
                    {money(data.totals.refunds)}
                  </td>
                  <td className="px-4 py-2.5 text-right">{money(data.totals.net)}</td>
                  <td className="px-4 py-2.5 text-right">
                    {money(data.totals.expenses)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs text-slate-400">
            Period: {data.periodBounds.start.slice(0, 10)} to{" "}
            {data.periodBounds.end.slice(0, 10)}
          </p>
        </>
      )}
    </div>
  );
}
