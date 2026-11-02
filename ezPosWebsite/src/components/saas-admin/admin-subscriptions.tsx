"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { fetchAllPlans, fetchSubscriptions, adminChangePlan, adminExtend, adminSubscriptionAction, type AdminSubscription } from "@/lib/api/saas-admin";

const STATUS_FILTERS = ["", "active", "trialing", "past_due", "suspended", "canceled"] as const;

export function AdminSubscriptions() {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [subs, setSubs] = useState<AdminSubscription[] | null>(null);
  const [plans, setPlans] = useState<{ id: number; name: string }[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const reload = useCallback(async (status: string) => {
    const result = await fetchSubscriptions(status ? { status } : undefined);
    setSubs(result.data ?? []);
  }, []);

  useEffect(() => {
    void reload(statusFilter);
  }, [reload, statusFilter]);

  useEffect(() => {
    void (async () => {
      const result = await fetchAllPlans();
      if (result.ok && result.data) {
        setPlans(result.data.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name })));
      }
    })();
  }, []);

  async function run(id: number, action: () => Promise<{ ok: boolean; message: string }>) {
    setBusyId(id);
    setMessage(null);
    const result = await action();
    setBusyId(null);
    setMessage({ text: result.message, ok: result.ok });
    if (result.ok) await reload(statusFilter);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">
          Subscriptions
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Manual changes are attributed to your admin account in the audit
          trail and subscription events.
        </p>
      </div>

      {message ? (
        <Alert tone={message.ok ? "info" : "warning"} title={message.ok ? "Done" : "Action failed"}>
          {message.text}
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((status) => (
          <button
            key={status || "all"}
            type="button"
            className={
              statusFilter === status
                ? "rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white"
                : "rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-400"
            }
            onClick={() => setStatusFilter(status)}
          >
            {status || "all"}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {subs === null ? (
          <p className="px-6 py-8 text-sm text-slate-500">Loading…</p>
        ) : subs.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-500">No subscriptions found.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2 font-medium">Business</th>
                <th className="px-5 py-2 font-medium">Plan</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Period ends</th>
                <th className="px-5 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {subs.map((sub) => (
                <tr key={sub.id}>
                  <td className="px-5 py-3 font-medium text-slate-900">
                    {sub.businessName}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {sub.planName}
                    <span className="block text-xs text-slate-400">
                      {sub.planInterval} · {sub.planPrice}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span className="font-medium text-slate-700">{sub.status}</span>
                    {sub.cancelAtPeriodEnd ? (
                      <span className="block text-xs text-amber-600">cancels at period end</span>
                    ) : null}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {new Date(sub.currentPeriodEnd).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <select
                        aria-label={`Change plan for ${sub.businessName}`}
                        className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                        defaultValue=""
                        disabled={busyId === sub.id}
                        onChange={(event) => {
                          const planId = Number(event.target.value);
                          if (planId > 0) {
                            void run(sub.id, () => adminChangePlan(sub.id, planId));
                            event.target.value = "";
                          }
                        }}
                      >
                        <option value="">Change plan…</option>
                        {plans.map((plan) => (
                          <option key={plan.id} value={plan.id}>
                            {plan.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === sub.id}
                        onClick={() => void run(sub.id, () => adminExtend(sub.id, 7))}
                      >
                        +7d
                      </Button>
                      {sub.status === "suspended" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === sub.id}
                          onClick={() => void run(sub.id, () => adminSubscriptionAction(sub.id, "reactivate"))}
                        >
                          Reactivate
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === sub.id || !["active", "trialing", "past_due"].includes(sub.status)}
                          onClick={() => void run(sub.id, () => adminSubscriptionAction(sub.id, "suspend"))}
                        >
                          Suspend
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === sub.id || sub.status === "canceled"}
                        onClick={() => void run(sub.id, () => adminSubscriptionAction(sub.id, "cancel"))}
                      >
                        Cancel
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
