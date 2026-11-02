"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import {
  addDomain,
  fetchDomains,
  makeDomainPrimary,
  removeDomain,
  verifyDomain,
  type StorefrontDomainRow,
} from "@/lib/api/online-store";

const STATUS_BADGES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  verified: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  removed: "bg-slate-200 text-slate-600",
};

export function DomainsManager() {
  const params = useParams<{ id: string }>();
  const storeId = Number(params?.id);
  const { businessId } = useActiveBusiness();
  const [domains, setDomains] = useState<StorefrontDomainRow[] | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "warning"; text: string; role?: "alert" } | null>(null);
  const [domain, setDomain] = useState("");
  const [busyId, setBusyId] = useState<number | "add" | null>(null);

  const load = useCallback(async () => {
    if (!businessId || !Number.isInteger(storeId) || storeId <= 0) return;
    const result = await fetchDomains(businessId, storeId);
    if (result.ok && result.data) setDomains(result.data);
    else setMessage({ tone: "warning", text: result.message, role: "alert" });
  }, [businessId, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (domains === null) {
    return <p className="text-sm text-slate-500" role="status">Loading domains…</p>;
  }

  const customDomains = domains.filter((d) => d.kind === "custom");

  return (
    <div className="space-y-6">
      {message ? (
        <Alert tone={message.tone} title={message.text} role={message.role ?? "status"} />
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold text-slate-900">Connect a custom domain</h2>
        <p className="mt-1 text-sm text-slate-600">
          Use a domain you already own (like www.abcfashion.com). We verify
          ownership via DNS before anything goes live — SSL is issued
          automatically after verification.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="www.yourbrand.com"
            aria-label="Custom domain"
            className="w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <Button
            onClick={() => {
              if (!businessId || !domain.trim()) return;
              setBusyId("add");
              void (async () => {
                const result = await addDomain(businessId, storeId, domain.trim());
                setBusyId(null);
                setMessage({
                  tone: result.ok ? "info" : "warning",
                  text: result.message,
                  role: result.ok ? undefined : "alert",
                });
                if (result.ok) {
                  setDomain("");
                  await load();
                }
              })();
            }}
            disabled={busyId === "add" || !domain.trim()}
          >
            {busyId === "add" ? "Adding…" : "Add domain"}
          </Button>
        </div>
      </section>

      {customDomains.length === 0 ? (
        <p className="text-sm text-slate-500">
          No custom domains yet — your store is reachable at its free ezPos
          subdomain (shown above).
        </p>
      ) : (
        <ul className="space-y-3">
          {customDomains.map((row) => (
            <li key={row.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-slate-900">{row.domain}</p>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    STATUS_BADGES[row.status] ?? STATUS_BADGES.pending
                  }`}
                >
                  {row.status === "verified"
                    ? row.sslStatus === "issued"
                      ? "Connected"
                      : "Verified · issuing SSL"
                    : row.status}
                </span>
                {row.isPrimary ? (
                  <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                    Primary
                  </span>
                ) : null}
              </div>

              {row.status === "pending" ? (
                <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                  <p className="font-medium">DNS setup — step 1: prove ownership</p>
                  <p className="mt-1">
                    Add this TXT record at your domain provider (name/host{" "}
                    <code className="rounded bg-white px-1">_ezpos-verify.{row.domain}</code>):
                  </p>
                  <p className="mt-1 break-all font-mono text-xs">
                    {row.verificationToken ?? "(token unavailable)"}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    DNS changes can take up to 24–48 hours. After adding the
                    record, click Verify. Step 2 (pointing the domain) is shown
                    once ownership is confirmed.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        if (!businessId) return;
                        setBusyId(row.id);
                        void (async () => {
                          const result = await verifyDomain(businessId, storeId, row.id);
                          setBusyId(null);
                          setMessage({
                            tone: result.ok ? "info" : "warning",
                            text: result.message,
                            role: result.ok ? undefined : "alert",
                          });
                          await load();
                        })();
                      }}
                      disabled={busyId === row.id}
                    >
                      {busyId === row.id ? "Checking…" : "Verify now"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (businessId) void (async () => {
                          setBusyId(row.id);
                          await removeDomain(businessId, storeId, row.id);
                          setBusyId(null);
                          await load();
                        })();
                      }}
                      disabled={busyId === row.id}
                    >
                      Remove
                    </Button>
                  </div>
                  {row.lastError ? (
                    <p className="mt-2 text-xs text-amber-700">{row.lastError}</p>
                  ) : null}
                </div>
              ) : (
                <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                  <p className="font-medium">DNS setup — step 2: point the domain</p>
                  <p className="mt-1">
                    At your domain provider, create a CNAME record:
                  </p>
                  <p className="mt-1 font-mono text-xs">
                    {row.domain} → CNAME → your-store-subdomain.ezpos.store
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    SSL is issued automatically on the first visit after the
                    record propagates. HTTPS is always enforced.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {!row.isPrimary ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (businessId) void (async () => {
                            setBusyId(row.id);
                            const result = await makeDomainPrimary(businessId, storeId, row.id);
                            setBusyId(null);
                            setMessage({ tone: result.ok ? "info" : "warning", text: result.message });
                            await load();
                          })();
                        }}
                        disabled={busyId === row.id}
                      >
                        Make primary
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (businessId) void (async () => {
                          setBusyId(row.id);
                          await removeDomain(businessId, storeId, row.id);
                          setBusyId(null);
                          await load();
                        })();
                      }}
                      disabled={busyId === row.id}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
