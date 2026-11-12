"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  fetchAdminStorefronts,
  fetchAdminStorefront,
  suspendAdminStorefront,
  reactivateAdminStorefront,
  type AdminStorefront,
} from "@/lib/api/saas-admin";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  preview: "bg-amber-100 text-amber-800",
  published: "bg-emerald-100 text-emerald-800",
  suspended: "bg-red-100 text-red-800",
  archived: "bg-slate-200 text-slate-600",
};

/**
 * Platform-wide storefront administration: search, inspect (domains,
 * storage, shoppers), suspend/reactivate. Every mutation is audit-logged
 * backend-side; admins cannot edit tenant content.
 */
export function AdminStorefronts() {
  const [rows, setRows] = useState<AdminStorefront[] | null>(null);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<{ tone: "info" | "warning"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async (term: string) => {
    const result = await fetchAdminStorefronts(term || undefined);
    if (result.ok && result.data) setRows(result.data);
    else setMessage({ tone: "warning", text: result.message });
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  async function act(storefrontId: number, action: "suspend" | "reactivate") {
    setBusyId(storefrontId);
    const result =
      action === "suspend"
        ? await suspendAdminStorefront(storefrontId, "Suspended from SaaS admin")
        : await reactivateAdminStorefront(storefrontId);
    setBusyId(null);
    setMessage({ tone: result.ok ? "info" : "warning", text: result.message });
    await load(search);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Storefronts</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every hosted storefront on the platform. Suspend/reactivate actions
          are recorded in the audit log.
        </p>
      </div>

      {message ? (
        <Alert tone={message.tone} title={message.text} role="status" />
      ) : null}

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void load(search);
        }}
      >
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by store, subdomain or business…"
          aria-label="Search storefronts"
          className="w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {rows === null ? (
        <p className="text-sm text-slate-500" role="status">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No storefronts found.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <AdminStorefrontRow
              key={row.id}
              row={row}
              busy={busyId === row.id}
              onAct={act}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AdminStorefrontRow({
  row,
  busy,
  onAct,
}: {
  row: AdminStorefront;
  busy: boolean;
  onAct: (id: number, action: "suspend" | "reactivate") => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Awaited<
    ReturnType<typeof fetchAdminStorefront>
  >["data"] | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const result = await fetchAdminStorefront(row.id);
    if (result.ok && result.data) setDetail(result.data);
    setOpen(true);
  }

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/saas-admin/businesses"
              className="font-semibold text-slate-900 hover:underline"
            >
              {row.name}
            </Link>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                STATUS_STYLES[row.status] ?? STATUS_STYLES.draft
              }`}
            >
              {row.status}
            </span>
            {row.businessStatus === "suspended" ? (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                business suspended
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-sm text-slate-500">
            {row.subdomain} · {row.businessName} · {row.domainCount} domain
            {row.domainCount === 1 ? "" : "s"}
            {row.publishedAt
              ? ` · published ${new Date(row.publishedAt).toLocaleDateString()}`
              : ""}
          </p>
        </div>
        <div className="flex gap-2">
          {row.status === "suspended" ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void onAct(row.id, "reactivate")}
            >
              Reactivate
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void onAct(row.id, "suspend")}
            >
              Suspend
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void toggle()}>
            {open ? "Hide" : "Details"}
          </Button>
        </div>
      </div>

      {open && detail ? (
        <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 text-sm sm:grid-cols-2">
          <div>
            <p className="font-medium text-slate-700">Domains</p>
            {detail.domains.length === 0 ? (
              <p className="text-slate-500">None.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {detail.domains.map((domain) => (
                  <li key={domain.id}>
                    <span className="font-mono text-xs">{domain.domain}</span>{" "}
                    <span className="text-xs text-slate-500">
                      {domain.status}
                      {domain.sslStatus === "issued" ? " · SSL" : ""}
                      {domain.lastError ? ` · ${domain.lastError}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-1 text-slate-600">
            <p>Theme: {detail.themeId}</p>
            <p>
              Media: {detail.media.files} files (
              {(detail.media.bytes / 1024 / 1024).toFixed(1)} MB)
            </p>
            <p>Shopper accounts: {detail.shoppers}</p>
            <p>
              Tracking: {detail.analyticsEnabled ? "on" : "off"} · Accounts:{" "}
              {detail.shopperAccountsEnabled ? "on" : "off"}
            </p>
          </div>
        </div>
      ) : null}
    </li>
  );
}
