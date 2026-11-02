"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import {
  fetchBusinesses,
  setBusinessStatus,
  type AdminBusiness,
} from "@/lib/api/saas-admin";

export function AdminBusinesses() {
  const [search, setSearch] = useState("");
  const [businesses, setBusinesses] = useState<AdminBusiness[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const reload = useCallback(async (term?: string) => {
    const result = await fetchBusinesses(term ? { search: term } : undefined);
    setBusinesses(result.data ?? []);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggleStatus(business: AdminBusiness) {
    setBusyId(business.id);
    setMessage(null);
    const target = business.status === "suspended" ? "active" : "suspended";
    let reason: string | undefined;
    if (target === "suspended") {
      reason = window.prompt("Reason for suspending this business:") ?? undefined;
      if (reason === undefined) {
        setBusyId(null);
        return;
      }
    }
    const result = await setBusinessStatus(business.id, target, reason);
    setBusyId(null);
    setMessage({ text: result.message, ok: result.ok });
    if (result.ok) await reload(search);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">
          Businesses
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Suspending a business blocks all member access until reactivated —
          every action is audit-logged.
        </p>
      </div>

      {message ? (
        <Alert tone={message.ok ? "info" : "warning"} title={message.ok ? "Done" : "Action failed"}>
          {message.text}
        </Alert>
      ) : null}

      <div className="flex gap-3">
        <TextField
          id="admin-business-search"
          label="Search"
          hint="By business name or owner email."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-sm"
        />
        <div className="flex items-end">
          <Button variant="outline" onClick={() => void reload(search)}>
            Search
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {businesses === null ? (
          <p className="px-6 py-8 text-sm text-slate-500">Loading…</p>
        ) : businesses.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-500">No businesses found.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2 font-medium">Business</th>
                <th className="px-5 py-2 font-medium">Owner</th>
                <th className="px-5 py-2 font-medium">Plan</th>
                <th className="px-5 py-2 font-medium">Users / Locations</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {businesses.map((business) => (
                <tr key={business.id}>
                  <td className="px-5 py-3">
                    <p className="font-medium text-slate-900">{business.name}</p>
                    <p className="text-xs text-slate-400">{business.slug}</p>
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {business.ownerName}
                    <span className="block text-xs text-slate-400">
                      {business.ownerEmail}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {business.planName ?? "—"}
                    <span className="block text-xs text-slate-400">
                      {business.subscriptionStatus ?? "no subscription"}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {business.userCount} / {business.locationCount}
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={
                        business.status === "suspended"
                          ? "font-medium text-red-600"
                          : "font-medium text-green-700"
                      }
                    >
                      {business.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button
                      size="sm"
                      variant={business.status === "suspended" ? "outline" : "outline"}
                      disabled={busyId === business.id}
                      onClick={() => toggleStatus(business)}
                    >
                      {business.status === "suspended" ? "Reactivate" : "Suspend"}
                    </Button>
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
