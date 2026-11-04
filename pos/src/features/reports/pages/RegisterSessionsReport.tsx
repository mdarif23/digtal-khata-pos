import { useCallback, useEffect, useState } from "react";
import { reportsApi, type RegisterSessionReportData } from "../api/reports.api";
import type { ReportFilters } from "../types/report.types";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";

/** Register shift summaries: expected vs counted cash and the variance. */
export function RegisterSessionsReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
  });
  const [data, setData] = useState<RegisterSessionReportData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await reportsApi.getRegisterSessions(filters);
      setData(res.data.data);
    } catch {
      toast.add({ title: "Unable to load register summaries", type: "error" });
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
        <h2 className="text-lg font-semibold">Register Sessions</h2>
        <p className="text-sm text-slate-500">
          Cashier shifts with expected vs counted cash and over/short variance.
        </p>
      </div>

      <ReportDateFilter filters={filters} onFiltersChange={setFilters} />

      {loading ? (
        <p className="py-10 text-center text-slate-400">Loading sessions…</p>
      ) : !data || data.rows.length === 0 ? (
        <p className="py-10 text-center text-slate-400">
          No register sessions in this period.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="text-xs text-slate-500">Sessions closed</div>
              <div className="text-xl font-semibold">{data.totals.sessionCount}</div>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="text-xs text-slate-500">Cash sales (closed)</div>
              <div className="text-xl font-semibold">{money(data.totals.cashSales)}</div>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="text-xs text-slate-500">Cash refunds (closed)</div>
              <div className="text-xl font-semibold text-rose-600">
                {money(data.totals.cashRefunds)}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="text-xs text-slate-500">Counted</div>
              <div className="text-xl font-semibold">{money(data.totals.countedCash)}</div>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="text-xs text-slate-500">Variance</div>
              <div
                className={`text-xl font-semibold ${
                  data.totals.difference === 0
                    ? "text-emerald-600"
                    : data.totals.difference > 0
                      ? "text-blue-600"
                      : "text-rose-600"
                }`}
              >
                {data.totals.difference > 0 ? "+" : ""}
                {money(data.totals.difference)}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Register</th>
                  <th className="px-4 py-2.5">Location</th>
                  <th className="px-4 py-2.5">Cashier</th>
                  <th className="px-4 py-2.5 text-right">Opening</th>
                  <th className="px-4 py-2.5 text-right">Cash sales</th>
                  <th className="px-4 py-2.5 text-right">Refunds</th>
                  <th className="px-4 py-2.5 text-right">In / Out</th>
                  <th className="px-4 py-2.5 text-right">Expected</th>
                  <th className="px-4 py-2.5 text-right">Counted</th>
                  <th className="px-4 py-2.5 text-right">Variance</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.sessionId} className="border-t border-slate-100">
                    <td className="px-4 py-2.5 font-medium">{row.registerName}</td>
                    <td className="px-4 py-2.5">{row.locationName}</td>
                    <td className="px-4 py-2.5">{row.userName}</td>
                    <td className="px-4 py-2.5 text-right">{money(row.openingCash)}</td>
                    <td className="px-4 py-2.5 text-right">{money(row.cashSales)}</td>
                    <td className="px-4 py-2.5 text-right text-rose-600">
                      {money(row.cashRefunds)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {money(row.cashIn)} / {money(row.cashOut)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {row.status === "closed" ? money(row.expectedCash) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {row.countedCash === null ? "—" : money(row.countedCash)}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right font-medium ${
                        row.difference === null
                          ? "text-slate-400"
                          : row.difference === 0
                            ? "text-emerald-600"
                            : row.difference > 0
                              ? "text-blue-600"
                              : "text-rose-600"
                      }`}
                    >
                      {row.difference === null
                        ? "—"
                        : `${row.difference > 0 ? "+" : ""}${money(row.difference)}`}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={row.status === "open" ? "default" : "secondary"}>
                        {row.status === "open" ? "Open" : "Closed"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
