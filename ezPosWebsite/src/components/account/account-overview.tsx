"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/providers/auth-provider";
import { fetchSubscription } from "@/lib/api/account";
import {
  fetchInvoices,
  fetchPayments,
  type InvoiceSummary,
  type PaymentSummary,
} from "@/lib/api/portal";

function statusLabel(status: string, trial: boolean): string {
  if (trial && status === "trialing") return "Free trial";
  if (trial && status === "expired") return "Trial ended";
  if (status === "active") return "Active";
  if (status === "past_due") return "Payment due";
  if (status === "suspended") return "Suspended";
  if (status === "canceled" || status === "expired")
    return "Ended — read-only";
  return "No plan yet — read-only";
}

function daysLeft(endIso: string | null): number | null {
  if (!endIso) return null;
  const ms = new Date(endIso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function UsageRow({
  label,
  used,
  max,
}: {
  label: string;
  used: number;
  max: number | null | undefined;
}) {
  const unlimited = max === null || max === undefined;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / max) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium text-slate-700">{label}</span>
        <span className="text-slate-500">
          {used} / {unlimited ? "unlimited" : max}
        </span>
      </div>
      {!unlimited ? (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={
              pct >= 100
                ? "h-full rounded-full bg-red-500"
                : "h-full rounded-full bg-indigo-600"
            }
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function AccountOverview() {
  const { businesses } = useAuth();
  const businessId = businesses[0]?.businessId ?? null;
  const membership = businesses[0];
  const [sub, setSub] = useState<Awaited<
    ReturnType<typeof fetchSubscription>
  > | null>(null);
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [payments, setPayments] = useState<PaymentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!businessId) {
      setLoading(false);
      return;
    }
    void (async () => {
      const [subRes, invoiceRes, paymentRes] = await Promise.all([
        fetchSubscription(businessId),
        fetchInvoices(businessId),
        fetchPayments(businessId),
      ]);
      setSub(subRes.ok ? subRes : null);
      setInvoices(invoiceRes.data ?? []);
      setPayments(paymentRes.data ?? []);
      setLoading(false);
    })();
  }, [businessId]);

  if (!businessId) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
        No business yet — create one from the{" "}
        <Link href="/dashboard" className="font-medium text-indigo-700 hover:underline">
          dashboard
        </Link>{" "}
        first.
      </div>
    );
  }

  if (loading || !sub) {
    return (
      <p className="py-12 text-center text-sm text-slate-500" role="status">
        Loading your account…
      </p>
    );
  }

  const { subscription, plan, usage } = sub.data ?? {};
  const remaining = daysLeft(subscription?.currentPeriodEnd ?? null);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            {membership?.businessName}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Subscription and usage at a glance.
          </p>
        </div>
        <Link
          href="/account/subscription"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
        >
          Manage subscription
        </Link>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Current plan</h2>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
            {plan?.name ?? "No plan"}
          </p>
          <p className="mt-1 text-sm">
            <span
              className={
                subscription?.accessMode === "full"
                  ? "font-medium text-green-700"
                  : "font-medium text-amber-700"
              }
            >
              {statusLabel(
                subscription?.status ?? "none",
                subscription?.trial ?? false,
              )}
            </span>
            {subscription?.trial && remaining !== null && subscription.status === "trialing"
              ? ` · ${remaining} day${remaining === 1 ? "" : "s"} left`
              : ""}
          </p>
          {subscription?.currentPeriodEnd ? (
            <p className="mt-1 text-xs text-slate-500">
              {subscription.status === "trialing"
                ? "Trial ends"
                : "Next billing date"}
              : {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
            </p>
          ) : null}
          {subscription?.accessMode === "read_only" ? (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Read-only mode — choose a plan to keep making changes.
            </p>
          ) : null}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Usage</h2>
          <div className="mt-4 space-y-4">
            <UsageRow label="Team members" used={usage?.users ?? 0} max={plan?.limits?.maxUsers} />
            <UsageRow label="Locations" used={usage?.locations ?? 0} max={plan?.limits?.maxLocations} />
            <UsageRow label="Active products" used={usage?.products ?? 0} max={plan?.limits?.maxProducts} />
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              Recent invoices
            </h2>
            <Link
              href="/account/billing"
              className="text-xs font-medium text-indigo-700 hover:underline"
            >
              View all
            </Link>
          </div>
          {invoices.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              No invoices yet — online billing opens with payment integration.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {invoices.slice(0, 4).map((invoice) => (
                <li key={invoice.id} className="flex items-center justify-between py-2.5 text-sm">
                  <Link
                    href={`/account/invoices/${invoice.id}`}
                    className="font-medium text-indigo-700 hover:underline"
                  >
                    {invoice.invoiceNumber}
                  </Link>
                  <span className="text-slate-500">
                    {money(invoice.total, invoice.currency)}
                  </span>
                  <span
                    className={
                      invoice.status === "paid"
                        ? "font-medium text-green-700"
                        : "font-medium text-amber-700"
                    }
                  >
                    {invoice.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              Recent payments
            </h2>
            <Link
              href="/account/billing"
              className="text-xs font-medium text-indigo-700 hover:underline"
            >
              View all
            </Link>
          </div>
          {payments.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              No payments yet — nothing has been charged.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {payments.slice(0, 4).map((payment) => (
                <li key={payment.id} className="flex items-center justify-between py-2.5 text-sm">
                  <span className="font-medium text-slate-700">
                    {payment.invoiceNumber ?? "—"}
                  </span>
                  <span className="text-slate-500">
                    {money(payment.amount, payment.currency)}
                  </span>
                  <span className="font-medium text-slate-600">
                    {payment.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
