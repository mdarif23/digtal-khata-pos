"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/components/providers/auth-provider";
import { fetchSubscription } from "@/lib/api/account";
import {
  changePlan,
  cancelSubscription,
  fetchOpenSubscription,
  fetchPublicPlans,
  reactivateSubscription,
  renewSubscription,
  type OpenSubscription,
  type PublicPlan,
} from "@/lib/api/portal";

interface SubscriptionDetail {
  subscription: {
    status: string;
    accessMode: "full" | "read_only";
    trial: boolean;
    currentPeriodEnd: string | null;
  };
  plan: {
    id: number;
    name: string;
    slug: string;
    limits: Record<string, number> | null;
    features: Record<string, boolean> | null;
  } | null;
  usage: { users: number; locations: number; products: number };
  events?: {
    id: number;
    eventType: string;
    fromStatus: string | null;
    toStatus: string | null;
    actorType: string;
    createdAt: string;
  }[] | undefined;
}

function eventLabel(eventType: string): string {
  return eventType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function SubscriptionManager() {
  const { businesses } = useAuth();
  const businessId = businesses[0]?.businessId ?? null;
  const [payload, setPayload] = useState<SubscriptionDetail | null>(null);
  const [openSub, setOpenSub] = useState<OpenSubscription | null>(null);
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [yearly, setYearly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const [confirmCancel, setConfirmCancel] = useState(false);

  const reload = useCallback(async () => {
    if (!businessId) return;
    const [subRes, plansRes, openRes] = await Promise.all([
      fetchSubscription(businessId),
      fetchPublicPlans(),
      fetchOpenSubscription(businessId),
    ]);
    if (subRes.ok && subRes.data) setPayload(subRes.data);
    setPlans(plansRes.data ?? []);
    setOpenSub(openRes.ok ? (openRes.data ?? null) : null);
  }, [businessId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const currentPlanId = payload?.plan?.id ?? null;
  const scheduledPlanId = openSub?.pendingPlanId ?? null;

  async function act(action: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(true);
    setMessage(null);
    const result = await action();
    setBusy(false);
    setMessage({ text: result.message, ok: result.ok });
    if (result.ok) await reload();
  }

  if (!businessId) {
    return (
      <p className="text-sm text-slate-500">
        Create a business first to manage a subscription.
      </p>
    );
  }
  if (!payload) {
    return (
      <p className="py-12 text-center text-sm text-slate-500" role="status">
        Loading your subscription…
      </p>
    );
  }

  const { subscription, plan, events = [] } = payload;
  const isCanceled =
    subscription.status === "canceled" || subscription.status === "expired";
  const onTrial = subscription.trial && subscription.status === "trialing";

  const visiblePlans = plans.filter(
    (p) => (yearly ? p.interval === "yearly" : p.interval === "monthly"),
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Subscription
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Upgrades apply immediately with a prorated invoice. Downgrades take
          effect at the end of the current period.
        </p>
      </div>

      {message ? (
        <Alert tone={message.ok ? "info" : "warning"} title={message.ok ? "Done" : "Action failed"}>
          {message.text}
        </Alert>
      ) : null}

      {/* Current plan card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
              Current plan
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-900">
              {plan?.name ?? "No plan"}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {subscription.status}
              {subscription.currentPeriodEnd
                ? ` · period ends ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
                : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const r = await renewSubscription(businessId);
                  return { ok: r.ok, message: r.message };
                })
              }
            >
              Renew now
            </Button>
            {openSub?.cancelAtPeriodEnd ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const r = await reactivateSubscription(businessId);
                    return { ok: r.ok, message: r.message };
                  })
                }
              >
                Reactivate
              </Button>
            ) : null}
            {isCanceled ? null : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmCancel(true)}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>

        {confirmCancel ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-medium">Cancel this subscription?</p>
            <p className="mt-1">
              Cancel at period end keeps full access until the period ends.
              Immediate cancellation switches to read-only right away. Your
              data is never deleted.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setConfirmCancel(false);
                  void act(async () => {
                    const r = await cancelSubscription(businessId, false);
                    return { ok: r.ok, message: r.message };
                  });
                }}
              >
                Cancel at period end
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setConfirmCancel(false);
                  void act(async () => {
                    const r = await cancelSubscription(businessId, true);
                    return { ok: r.ok, message: r.message };
                  });
                }}
              >
                Cancel immediately
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>
                Keep subscription
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Plan grid */}
      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            {onTrial ? "Choose your plan" : "Change plan"}
          </h2>
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              className={
                yearly
                  ? "text-slate-500 hover:text-slate-700"
                  : "font-semibold text-indigo-700"
              }
              onClick={() => setYearly(false)}
            >
              Monthly
            </button>
            <span className="text-slate-300">|</span>
            <button
              type="button"
              className={
                yearly
                  ? "font-semibold text-indigo-700"
                  : "text-slate-500 hover:text-slate-700"
              }
              onClick={() => setYearly(true)}
            >
              Yearly
            </button>
          </div>
        </div>
        {visiblePlans.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            Plans are being finalized — check back soon.
          </p>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visiblePlans.map((p) => {
              const isCurrent = p.id === currentPlanId;
              const isScheduled = p.id === scheduledPlanId;
              return (
                <div
                  key={p.id}
                  className={
                    isCurrent
                      ? "rounded-2xl border-2 border-indigo-600 bg-white p-5 shadow-sm"
                      : "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                  }
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-slate-900">{p.name}</h3>
                    {p.isPopular ? (
                      <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                        Popular
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
                    {p.currency} {p.price.toLocaleString()}
                  </p>
                  <p className="text-xs text-slate-500">
                    per {p.interval === "yearly" ? "year" : "month"}
                  </p>
                  {p.description ? (
                    <p className="mt-2 text-xs leading-5 text-slate-600">
                      {p.description}
                    </p>
                  ) : null}
                  <ul className="mt-3 space-y-1 text-xs text-slate-600">
                    {p.limits?.maxUsers !== undefined ? (
                      <li>Up to {p.limits.maxUsers} users</li>
                    ) : (
                      <li>Unlimited users</li>
                    )}
                    {p.limits?.maxLocations !== undefined ? (
                      <li>{p.limits.maxLocations} location{p.limits.maxLocations === 1 ? "" : "s"}</li>
                    ) : (
                      <li>Unlimited locations</li>
                    )}
                    {p.features?.advancedReports ? <li>Advanced reports</li> : null}
                    {p.features?.multiLocation ? <li>Multi-location</li> : null}
                  </ul>
                  <div className="mt-4">
                    {isCurrent ? (
                      <Button size="sm" variant="outline" className="w-full" disabled>
                        Current plan
                      </Button>
                    ) : isScheduled ? (
                      <Button size="sm" variant="outline" className="w-full" disabled>
                        Scheduled for period end
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            const r = await changePlan(businessId, p.id);
                            return { ok: r.ok, message: r.message };
                          })
                        }
                      >
                        {subscription.status === "trialing"
                          ? "Switch to this plan"
                          : Number(p.price) > (openSub?.planPrice ?? 0)
                            ? "Upgrade"
                            : "Switch"}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* History */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">History</h2>
        {events.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No subscription activity yet.</p>
        ) : (
          <ol className="mt-4 space-y-3">
            {events.slice(0, 12).map((event) => (
              <li key={event.id} className="flex items-baseline justify-between gap-4 text-sm">
                <span className="font-medium text-slate-700">
                  {eventLabel(event.eventType)}
                </span>
                <span className="text-xs text-slate-400">
                  {new Date(event.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
