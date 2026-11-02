"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import { formatPrice } from "@/lib/format";
import {
  fetchStorefront,
  fetchStorefrontAnalytics,
  updateStorefront,
  type StorefrontAnalytics,
} from "@/lib/api/online-store";

/**
 * Storefront analytics: TRACKED metrics from the beacon + measured orders/
 * revenue from the unified sales table. Nothing here is estimated — when a
 * number is unavailable it shows as 0/— with an explanation.
 */
export function StoreAnalytics() {
  const params = useParams<{ id: string }>();
  const storeId = Number(params?.id);
  const { businessId } = useActiveBusiness();
  const [analytics, setAnalytics] = useState<StorefrontAnalytics | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    if (!businessId || !Number.isInteger(storeId) || storeId <= 0) return;
    const [analyticsResult, detailResult] = await Promise.all([
      fetchStorefrontAnalytics(businessId, storeId, days),
      fetchStorefront(businessId, storeId),
    ]);
    if (analyticsResult.ok && analyticsResult.data) {
      setAnalytics(analyticsResult.data);
    } else {
      setMessage(analyticsResult.message);
    }
    if (detailResult.ok && detailResult.data) {
      setEnabled(detailResult.data.analyticsEnabled === true);
    }
  }, [businessId, storeId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleTracking() {
    if (!businessId || enabled === null) return;
    const result = await updateStorefront(businessId, storeId, {
      analyticsEnabled: !enabled,
    });
    if (result.ok) {
      setEnabled(!enabled);
      await load();
    } else {
      setMessage(result.message);
    }
  }

  return (
    <div className="space-y-6">
      {message ? <Alert tone="warning" title={message} role="alert" /> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-900">Store analytics</h2>
        <div className="flex items-center gap-2 text-sm">
          {enabled === false ? (
            <Button size="sm" onClick={() => void toggleTracking()}>
              Enable tracking
            </Button>
          ) : enabled === true ? (
            <Button size="sm" variant="outline" onClick={() => void toggleTracking()}>
              Pause tracking
            </Button>
          ) : null}
          <select
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            aria-label="Period"
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </div>

      {enabled === false ? (
        <Alert
          tone="info"
          title="Tracking is paused. Enable it to collect visits and product views — orders and revenue are always counted."
        />
      ) : null}

      {analytics === null ? (
        <p className="text-sm text-slate-500" role="status">Loading analytics…</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Store visits" value={String(analytics.tracked.visits)} tracked />
            <Metric label="Product views" value={String(analytics.tracked.productViews)} tracked />
            <Metric label="Online orders" value={String(analytics.orders)} tracked />
            <Metric
              label="Conversion rate"
              value={analytics.conversionRate === null ? "—" : `${analytics.conversionRate}%`}
              tracked={analytics.conversionRate !== null}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Revenue (online channel)
              </p>
              <p className="mt-1 text-xl font-bold text-slate-900">
                {formatPrice(analytics.revenue, "BDT")}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Cart activity
              </p>
              <p className="mt-1 text-sm text-slate-700">
                Add-to-cart events: {analytics.tracked.addToCarts} · Checkouts started:{" "}
                {analytics.tracked.checkoutStarts}
              </p>
            </div>
          </div>

          {analytics.bestSellers.length > 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="font-semibold text-slate-900">Best sellers</h3>
              <ul className="mt-3 space-y-1 text-sm">
                {analytics.bestSellers.map((product, index) => (
                  <li key={product.productId} className="flex justify-between gap-2">
                    <span>
                      {index + 1}. {product.name}
                    </span>
                    <span className="text-slate-500">{product.quantity} sold</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <ul className="space-y-1 text-xs text-slate-500">
            {analytics.notes.map((note) => (
              <li key={note}>· {note}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tracked,
}: {
  label: string;
  value: string;
  tracked: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label} {!tracked ? "(not tracked)" : ""}
      </p>
      <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
    </div>
  );
}
