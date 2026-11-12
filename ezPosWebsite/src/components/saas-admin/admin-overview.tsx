"use client";

import { useEffect, useState } from "react";
import { fetchOverview, type SaasOverview } from "@/lib/api/saas-admin";

function money(n: number): string {
  return `BDT ${Math.round(n).toLocaleString()}`;
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function AdminOverview() {
  const [data, setData] = useState<SaasOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const result = await fetchOverview();
      if (result.ok && result.data) {
        setData(result.data);
      } else if (result.data === undefined) {
        setLoadError(result.message);
      }
    })();
  }, []);

  if (!data) {
    return loadError ? (
      <div className="py-12 text-center" role="alert">
        <p className="text-sm font-medium text-slate-700">
          Could not load SaaS metrics.
        </p>
        <p className="mt-1 text-sm text-slate-500">{loadError}</p>
      </div>
    ) : (
      <p className="py-12 text-center text-sm text-slate-500" role="status">
        Loading SaaS metrics…
      </p>
    );
  }

  const maxMonthlyRevenue = Math.max(1, ...data.revenueByMonth.map((r) => r.total));

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">
          SaaS overview
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          MRR counts active paid subscriptions only (yearly plans normalized
          to a twelfth); unpaid invoices are never revenue.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="MRR" value={money(data.mrr)} hint={`ARR ${money(data.arr)}`} />
        <Metric label="Collected revenue" value={money(data.revenue.collected)} hint={`Pending ${money(data.revenue.pending)}`} />
        <Metric label="Businesses" value={String(data.businesses)} hint={`${data.newBusinesses30d} new in 30 days`} />
        <Metric label="Customers" value={String(data.customers)} hint={`${data.revenue.failedPayments} failed payments`} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Active" value={String(data.subscriptions.active)} />
        <Metric label="Trialing" value={String(data.subscriptions.trialing)} />
        <Metric label="Past due" value={String(data.subscriptions.pastDue)} />
        <Metric label="Suspended" value={String(data.subscriptions.suspended)} />
        <Metric label="Canceled" value={String(data.subscriptions.canceled)} />
        <Metric label="Expired" value={String(data.subscriptions.expired)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900">
            Revenue by month (paid invoices)
          </h3>
          {data.revenueByMonth.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No revenue recorded yet.</p>
          ) : (
            <div className="mt-4 space-y-2">
              {[...data.revenueByMonth].reverse().map((row) => (
                <div key={row.month} className="flex items-center gap-3 text-sm">
                  <span className="w-16 text-xs text-slate-500">{row.month}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-indigo-600"
                      style={{
                        width: `${Math.round((row.total / maxMonthlyRevenue) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="w-24 text-right text-xs font-medium text-slate-700">
                    {money(row.total)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900">
            Revenue by plan
          </h3>
          {data.revenueByPlan.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No revenue recorded yet.</p>
          ) : (
            <ul className="mt-4 space-y-2 text-sm">
              {data.revenueByPlan.map((row) => (
                <li key={row.plan} className="flex justify-between">
                  <span className="text-slate-700">{row.plan}</span>
                  <span className="font-medium text-slate-900">
                    {money(row.total)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-6 border-t border-slate-100 pt-4 text-sm">
            <p className="flex justify-between">
              <span className="text-slate-500">Trial conversion</span>
              <span className="font-medium text-slate-900">
                {data.trialConversionPct === null ? "—" : `${data.trialConversionPct}%`}
              </span>
            </p>
            <p className="mt-1 flex justify-between">
              <span className="text-slate-500">Churn (30 days)</span>
              <span className="font-medium text-slate-900">
                {data.churn30dPct === null ? "—" : `${data.churn30dPct}%`}
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
