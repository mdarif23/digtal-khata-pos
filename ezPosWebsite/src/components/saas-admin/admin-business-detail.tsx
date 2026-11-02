"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AdminBusiness } from "@/lib/api/saas-admin";

interface BusinessDetail {
  id: number;
  name: string;
  slug: string;
  status: string;
  mode: string;
  ownerName: string | null;
  ownerEmail: string | null;
  createdAt: string | null;
  subscription: {
    id: number;
    status: string;
    planName: string;
    planPrice: number;
    planInterval: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
  } | null;
  users: { userId: number; name: string; email: string; role: string; status: string }[];
  locations: { id: number; name: string; isDefault: boolean }[];
  invoices: {
    id: number;
    invoiceNumber: string;
    status: string;
    total: number;
    currency: string;
    issuedAt: string;
  }[];
}

export function AdminBusinessDetailPage() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<BusinessDetail | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!params?.id) return;
    void (async () => {
      const token = (
        await import("@/lib/api/auth")
      ).getAccessToken();
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000"}/api/saas/businesses/${params.id}/detail`,
        { headers: { Authorization: `Bearer ${token ?? ""}` } },
      );
      if (res.ok) {
        const body = (await res.json()) as { data: BusinessDetail };
        setDetail(body.data);
      } else {
        setNotFound(true);
      }
    })();
  }, [params?.id]);

  if (notFound) {
    return (
      <p className="text-sm text-slate-500">
        Business not found.{" "}
        <Link href="/saas-admin/businesses" className="text-indigo-700 hover:underline">
          Back to businesses
        </Link>
      </p>
    );
  }
  if (!detail) {
    return (
      <p className="py-12 text-center text-sm text-slate-500" role="status">
        Loading business…
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/saas-admin/businesses"
        className="text-sm font-medium text-indigo-700 hover:underline"
      >
        ← Back to businesses
      </Link>

      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">
          {detail.name}
        </h2>
        <p className="text-xs text-slate-500">
          {detail.slug} · mode {detail.mode} ·{" "}
          <span
            className={
              detail.status === "suspended"
                ? "font-medium text-red-600"
                : "font-medium text-green-700"
            }
          >
            {detail.status}
          </span>
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900">Overview</h3>
          <div className="mt-2">
            {detailRow("Owner", detail.ownerName ?? "—")}
            {detailRow("Owner email", detail.ownerEmail ?? "—")}
            {detailRow(
              "Registered",
              detail.createdAt
                ? new Date(detail.createdAt).toLocaleDateString()
                : "—",
            )}
            {detail.subscription
              ? detailRow(
                  "Subscription",
                  `${detail.subscription.planName} (${detail.subscription.status})`,
                )
              : detailRow("Subscription", "none")}
            {detail.subscription
              ? detailRow(
                  "Period ends",
                  new Date(detail.subscription.currentPeriodEnd).toLocaleDateString(),
                )
              : null}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900">Locations</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {detail.locations.length === 0 ? (
              <li className="text-slate-500">None.</li>
            ) : (
              detail.locations.map((location) => (
                <li key={location.id} className="flex justify-between">
                  <span className="text-slate-700">{location.name}</span>
                  {location.isDefault ? (
                    <span className="text-xs text-indigo-600">default</span>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">Users</h3>
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {detail.users.map((user) => (
            <li key={user.userId} className="flex justify-between py-2">
              <span className="text-slate-700">
                {user.name}
                <span className="block text-xs text-slate-400">{user.email}</span>
              </span>
              <span className="text-xs text-slate-500">
                {user.role} · {user.status}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">Invoices</h3>
        {detail.invoices.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No invoices.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {detail.invoices.map((invoice) => (
              <li key={invoice.id} className="flex justify-between py-2">
                <span className="font-medium text-slate-900">
                  {invoice.invoiceNumber}
                </span>
                <span className="text-slate-600">
                  {invoice.currency} {Number(invoice.total).toLocaleString()}
                </span>
                <span
                  className={
                    invoice.status === "paid"
                      ? "text-green-700"
                      : "text-amber-700"
                  }
                >
                  {invoice.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Alert tone="info" title="Note">
        User list shows all members with their primary roles. Suspensions and
        subscription changes from this view are audit-logged.
      </Alert>
    </div>
  );
}

function detailRow(label: string, value: string) {
  return (
    <div className="flex justify-between py-1 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-900">{value}</span>
    </div>
  );
}
