"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import {
  archiveStorefront,
  changeSubdomain,
  checkSubdomainAvailability,
  fetchPaymentMethods,
  fetchStorefront,
  fetchStorefrontVersions,
  fetchZones,
  createZone,
  updateZone,
  deleteZone,
  restoreStorefrontVersion,
  updatePaymentMethods,
  updateStorefront,
  STOREFRONT_BASE_DOMAIN,
  type DeliveryZone,
  type PaymentMethodRow,
  type StorefrontDetail,
  type StorefrontVersion,
} from "@/lib/api/online-store";
import { looksLikeSubdomain } from "@/lib/online-store-helpers";

export function StoreSettings() {
  const params = useParams<{ id: string }>();
  const storeId = Number(params?.id);
  const { businessId } = useActiveBusiness();
  const [store, setStore] = useState<StorefrontDetail | null>(null);
  const [versions, setVersions] = useState<StorefrontVersion[]>([]);
  const [message, setMessage] = useState<{ tone: "info" | "warning"; text: string; role?: "alert" } | null>(null);
  const [busy, setBusy] = useState(false);

  // Subdomain
  const [subdomain, setSubdomain] = useState("");
  const [availability, setAvailability] = useState<string | null>(null);

  // SEO + contact
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [shopperAccountsEnabled, setShopperAccountsEnabled] = useState(false);

  const ready = businessId && Number.isInteger(storeId) && storeId > 0;

  const load = useCallback(async () => {
    if (!ready) return;
    const result = await fetchStorefront(businessId!, storeId);
    if (result.ok && result.data) {
      setStore(result.data);
      setSubdomain(result.data.subdomain);
      setSeoTitle(result.data.seo?.title ?? "");
      setSeoDescription(result.data.seo?.description ?? "");
      setShopperAccountsEnabled(result.data.shopperAccountsEnabled === true);
    } else {
      setMessage({ tone: "warning", text: result.message, role: "alert" });
    }
    const versionsResult = await fetchStorefrontVersions(businessId!, storeId);
    if (versionsResult.ok && versionsResult.data) setVersions(versionsResult.data);
  }, [businessId, storeId, ready]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!store) {
    return message ? (
      <Alert tone={message.tone} title={message.text} role={message.role ?? "status"} />
    ) : (
      <p className="text-sm text-slate-500" role="status">Loading settings…</p>
    );
  }

  async function checkAvailability() {
    if (!businessId || !looksLikeSubdomain(subdomain)) {
      setAvailability("Use 3-63 lowercase letters, numbers or hyphens.");
      return;
    }
    const result = await checkSubdomainAvailability(businessId, subdomain);
    if (result.ok && result.data) {
      setAvailability(
        result.data.available
          ? "Available!"
          : (result.data.error ?? "Already taken."),
      );
    } else {
      setAvailability(result.message);
    }
  }

  async function saveSubdomain() {
    if (!businessId) return;
    setBusy(true);
    const result = await changeSubdomain(businessId, storeId, subdomain);
    setBusy(false);
    setMessage({
      tone: result.ok ? "info" : "warning",
      text: result.ok
        ? `Subdomain updated: ${result.data?.subdomain}.${STOREFRONT_BASE_DOMAIN}`
        : result.message,
      role: result.ok ? undefined : "alert",
    });
    await load();
  }

  async function saveSeoAndFlags() {
    if (!businessId) return;
    setBusy(true);
    const result = await updateStorefront(businessId, storeId, {
      seo: {
        title: seoTitle || undefined,
        description: seoDescription || undefined,
      },
      shopperAccountsEnabled,
    });
    setBusy(false);
    setMessage({
      tone: result.ok ? "info" : "warning",
      text: result.ok ? "Store settings saved." : result.message,
      role: result.ok ? undefined : "alert",
    });
    await load();
  }

  async function archive() {
    if (!businessId) return;
    if (!window.confirm("Archive this store? It goes offline but your data is kept.")) return;
    setBusy(true);
    const result = await archiveStorefront(businessId, storeId);
    setBusy(false);
    if (result.ok) {
      window.location.href = "/account/online-store";
      return;
    }
    setMessage({ tone: "warning", text: result.message, role: "alert" });
  }

  return (
    <div className="space-y-8">
      {message ? (
        <Alert tone={message.tone} title={message.text} role={message.role ?? "status"} />
      ) : null}

      <SubdomainSection
        current={store.subdomain}
        subdomain={subdomain}
        setSubdomain={setSubdomain}
        availability={availability}
        checkAvailability={() => void checkAvailability()}
        save={() => void saveSubdomain()}
        busy={busy}
        unchanged={subdomain === store.subdomain}
      />

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold text-slate-900">Store SEO</h2>
        <p className="mt-1 text-sm text-slate-600">
          Defaults for your storefront pages (individual products and pages can
          override these).
        </p>
        <div className="mt-3 grid gap-3">
          <div>
            <label htmlFor="seo-title" className="block text-sm font-medium text-slate-700">
              Store title
            </label>
            <input
              id="seo-title"
              value={seoTitle}
              onChange={(event) => setSeoTitle(event.target.value)}
              maxLength={200}
              placeholder={`${store.name} — online store`}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="seo-desc" className="block text-sm font-medium text-slate-700">
              Store description
            </label>
            <textarea
              id="seo-desc"
              value={seoDescription}
              onChange={(event) => setSeoDescription(event.target.value)}
              maxLength={300}
              rows={2}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={shopperAccountsEnabled}
              onChange={(event) => setShopperAccountsEnabled(event.target.checked)}
            />
            Allow customers to create accounts and see their order history
          </label>
          <div>
            <Button onClick={() => void saveSeoAndFlags()} disabled={busy}>
              Save store settings
            </Button>
          </div>
        </div>
      </section>

      <PaymentMethodsSection storeId={storeId} />

      <DeliveryZonesSection storeId={storeId} />

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold text-slate-900">Published versions</h2>
        <p className="mt-1 text-sm text-slate-600">
          Every publish creates a snapshot. Restoring republishes an old
          snapshot as a new version — history is never lost.
        </p>
        {versions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No published versions yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {versions.map((version) => (
              <li
                key={version.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm"
              >
                <span>
                  <span className="font-semibold text-slate-900">v{version.versionNumber}</span>
                  {version.versionNumber === store.publishedVersionNumber ? (
                    <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                      live
                    </span>
                  ) : null}
                  <span className="ml-2 text-slate-500">
                    {new Date(version.publishedAt).toLocaleString()}
                  </span>
                </span>
                {version.versionNumber === store.publishedVersionNumber ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (!businessId) return;
                      setBusy(true);
                      void (async () => {
                        const result = await restoreStorefrontVersion(
                          businessId,
                          storeId,
                          version.id,
                        );
                        setBusy(false);
                        setMessage({
                          tone: result.ok ? "info" : "warning",
                          text: result.message,
                          role: result.ok ? undefined : "alert",
                        });
                        await load();
                      })();
                    }}
                  >
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-red-200 bg-red-50/50 p-5">
        <h2 className="font-semibold text-red-900">Danger zone</h2>
        <p className="mt-1 text-sm text-red-800">
          Archiving takes the store offline immediately. Your products, orders
          and settings are kept and can be restored by support.
        </p>
        <Button variant="outline" className="mt-3" onClick={() => void archive()} disabled={busy}>
          Archive this store
        </Button>
      </section>
    </div>
  );
}

function SubdomainSection({
  current,
  subdomain,
  setSubdomain,
  availability,
  checkAvailability,
  save,
  busy,
  unchanged,
}: {
  current: string;
  subdomain: string;
  setSubdomain: (value: string) => void;
  availability: string | null;
  checkAvailability: () => void;
  save: () => void;
  busy: boolean;
  unchanged: boolean;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold text-slate-900">Store address</h2>
      <p className="mt-1 text-sm text-slate-600">
        Your free ezPos subdomain. Custom domains are managed under the
        Domains tab.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={subdomain}
          onChange={(event) => setSubdomain(event.target.value.toLowerCase().trim())}
          aria-label="Subdomain"
          className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <span className="text-sm text-slate-400">.{STOREFRONT_BASE_DOMAIN}</span>
        <Button size="sm" variant="outline" onClick={checkAvailability} disabled={busy || unchanged}>
          Check
        </Button>
        <Button size="sm" onClick={save} disabled={busy || unchanged || !looksLikeSubdomain(subdomain)}>
          Save address
        </Button>
      </div>
      {availability ? (
        <p className="mt-2 text-sm text-slate-600">{availability}</p>
      ) : null}
      {!unchanged ? (
        <p className="mt-1 text-xs text-slate-500">Current: {current}.{STOREFRONT_BASE_DOMAIN}</p>
      ) : null}
    </section>
  );
}

function PaymentMethodsSection({ storeId }: { storeId: number }) {
  const { businessId } = useActiveBusiness();
  const [methods, setMethods] = useState<PaymentMethodRow[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!businessId) return;
    void (async () => {
      const result = await fetchPaymentMethods(businessId, storeId);
      if (result.ok && result.data) setMethods(result.data);
      else setMessage(result.message);
    })();
  }, [businessId, storeId]);

  async function save(updates: Array<{ method: "cod" | "sslcommerz"; enabled: boolean }>) {
    if (!businessId) return;
    setBusy(true);
    const result = await updatePaymentMethods(businessId, storeId, updates);
    setBusy(false);
    setMessage(result.ok ? null : result.message);
    if (result.ok) {
      const refreshed = await fetchPaymentMethods(businessId, storeId);
      if (refreshed.ok && refreshed.data) setMethods(refreshed.data);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold text-slate-900">Payment methods at checkout</h2>
      <p className="mt-1 text-sm text-slate-600">
        Choose how shoppers pay. Online payments are verified server-side —
        orders are never marked paid without a trusted confirmation.
      </p>
      {methods === null ? (
        <p className="mt-3 text-sm text-slate-500" role="status">Loading…</p>
      ) : (
        <div className="mt-3 space-y-2">
          {(["cod", "sslcommerz"] as const).map((method) => {
            const row = methods.find((m) => m.method === method);
            const enabled = row?.enabled ?? false;
            return (
              <label
                key={method}
                className="flex items-center gap-2 rounded-lg border border-slate-200 p-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy}
                  onChange={(event) => {
                    const next = (["cod", "sslcommerz"] as const).map((m) => ({
                      method: m,
                      enabled:
                        m === method
                          ? event.target.checked
                          : (methods.find((x) => x.method === m)?.enabled ?? false),
                    }));
                    void save(next);
                  }}
                />
                <span>
                  {method === "cod" ? "Cash on delivery" : "Online payment (SSLCommerz)"}
                  {method === "sslcommerz" && enabled ? (
                    <span className="ml-2 text-xs text-slate-500">
                      (capture activates with the payments rollout)
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
          {message ? <p className="text-sm text-amber-700">{message}</p> : null}
        </div>
      )}
    </section>
  );
}

function DeliveryZonesSection({ storeId }: { storeId: number }) {
  const { businessId } = useActiveBusiness();
  const [zones, setZones] = useState<DeliveryZone[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ name: "", areas: "", rate: "" });

  const load = useCallback(async () => {
    if (!businessId) return;
    const result = await fetchZones(businessId, storeId);
    if (result.ok && result.data) setZones(result.data);
    else setMessage(result.message);
  }, [businessId, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addZone() {
    if (!businessId) return;
    const rate = Number(draft.rate);
    const areas = draft.areas
      .split(",")
      .map((area) => area.trim())
      .filter(Boolean);
    if (!draft.name.trim() || areas.length === 0 || !Number.isFinite(rate) || rate < 0) {
      setMessage("Enter a zone name, comma-separated areas, and a rate.");
      return;
    }
    setBusy(true);
    const result = await createZone(businessId, storeId, {
      name: draft.name.trim(),
      areas,
      rate,
    });
    setBusy(false);
    if (result.ok) {
      setDraft({ name: "", areas: "", rate: "" });
      setMessage(null);
      await load();
    } else {
      setMessage(result.message);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold text-slate-900">Delivery zones</h2>
      <p className="mt-1 text-sm text-slate-600">
        Charges are applied at checkout based on the shopper&apos;s area —
        always calculated on the server.
      </p>

      {zones === null ? (
        <p className="mt-3 text-sm text-slate-500" role="status">Loading…</p>
      ) : (
        <>
          {zones.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {zones.map((zone) => (
                <li
                  key={zone.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm"
                >
                  <span>
                    <span className="font-medium text-slate-900">{zone.name}</span>
                    <span className="ml-2 text-slate-500">
                      {zone.areas.join(", ")}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-slate-700">
                      ৳{Number(zone.rate).toLocaleString()}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        if (businessId) void (async () => {
                          setBusy(true);
                          const result = await deleteZone(businessId, storeId, zone.id);
                          setBusy(false);
                          if (!result.ok) setMessage(result.message);
                          await load();
                        })();
                      }}
                    >
                      Delete
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-slate-500">
              No zones yet — add at least one so shoppers can choose delivery.
            </p>
          )}

          <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_2fr_120px_auto]">
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Zone name (Dhaka)"
              aria-label="Zone name"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              value={draft.areas}
              onChange={(event) => setDraft({ ...draft, areas: event.target.value })}
              placeholder="Areas, comma-separated (Dhanmondi, Gulshan)"
              aria-label="Areas"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              value={draft.rate}
              onChange={(event) => setDraft({ ...draft, rate: event.target.value })}
              placeholder="Rate ৳"
              aria-label="Delivery rate"
              inputMode="decimal"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <Button onClick={() => void addZone()} disabled={busy}>
              Add zone
            </Button>
          </div>
          {message ? <p className="mt-2 text-sm text-amber-700">{message}</p> : null}
        </>
      )}
    </section>
  );
}
