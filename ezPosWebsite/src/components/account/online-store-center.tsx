"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import { STATUS_LABELS } from "@/lib/online-store-helpers";
import {
  createStorefront,
  fetchStorefronts,
  fetchThemes,
  STOREFRONT_BASE_DOMAIN,
  type StorefrontSummary,
  type ThemeCatalogItem,
} from "@/lib/api/online-store";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  preview: "bg-amber-100 text-amber-800",
  published: "bg-emerald-100 text-emerald-800",
  suspended: "bg-red-100 text-red-800",
  archived: "bg-slate-200 text-slate-600",
};

export function OnlineStoreCenter() {
  const { businessId } = useActiveBusiness();
  const router = useRouter();
  const [stores, setStores] = useState<StorefrontSummary[] | null>(null);
  const [themes, setThemes] = useState<ThemeCatalogItem[]>([]);
  const [message, setMessage] = useState<{ tone: "info" | "warning"; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [themeId, setThemeId] = useState("");
  const [subdomain, setSubdomain] = useState("");

  const load = useCallback(async () => {
    if (!businessId) return;
    const [storesResult, themesResult] = await Promise.all([
      fetchStorefronts(businessId),
      fetchThemes(),
    ]);
    if (storesResult.ok && storesResult.data) {
      setStores(storesResult.data);
    } else {
      setMessage({ tone: "warning", text: storesResult.message });
      setStores([]);
    }
    if (themesResult.ok && themesResult.data) {
      const themeData = themesResult.data;
      setThemes(themeData);
      setThemeId((current) => current || themeData[0]?.id || "");
    } else {
      setMessage({ tone: "warning", text: themesResult.message });
    }
  }, [businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    if (!businessId || !name.trim() || !themeId) return;
    setBusy(true);
    setMessage(null);
    const result = await createStorefront(businessId, {
      name: name.trim(),
      themeId,
      ...(subdomain.trim() ? { subdomain: subdomain.trim() } : {}),
    });
    setBusy(false);
    if (result.ok && result.data) {
      router.push(`/account/online-store/${result.data.id}`);
      return;
    }
    setMessage({ tone: "warning", text: result.message });
  }

  if (!businessId) {
    return <p className="text-sm text-slate-500">Select a business to manage its online store.</p>;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Online store</h1>
        <p className="mt-1 text-sm text-slate-600">
          Create and publish a hosted storefront for your business. Orders land
          in your ezPos Orders — inventory stays in sync automatically.
        </p>
      </div>

      {message ? (
        <Alert tone={message.tone} title={message.text} role="status" />
      ) : null}

      {stores === null ? (
        <p className="text-sm text-slate-500" role="status">
          Loading your stores…
        </p>
      ) : stores.length > 0 ? (
        <ul className="space-y-3">
          {stores.map((store) => (
            <li
              key={store.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate font-semibold text-slate-900">{store.name}</p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      STATUS_STYLES[store.status] ?? STATUS_STYLES.draft
                    }`}
                  >
                    {STATUS_LABELS[store.status] ?? store.status}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm text-slate-500">
                  {store.subdomain}.{STOREFRONT_BASE_DOMAIN} ·{" "}
                  {store.publishedProductCount} product
                  {store.publishedProductCount === 1 ? "" : "s"} online
                  {store.publishedAt
                    ? ` · last published ${new Date(store.publishedAt).toLocaleDateString()}`
                    : ""}
                </p>
              </div>
              <Link
                href={`/account/online-store/${store.id}`}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Manage
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">
            {stores && stores.length > 0 ? "Create another store" : "Create your store"}
          </h2>
          {stores && stores.length > 0 ? null : (
            <span className="text-xs text-slate-500">
              Free <span className="font-medium">{STOREFRONT_BASE_DOMAIN}</span> subdomain included
            </span>
          )}
        </div>

        {creating ? (
          <div className="mt-4 space-y-4">
            <div>
              <label htmlFor="store-name" className="block text-sm font-medium text-slate-700">
                Store name
              </label>
              <input
                id="store-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                placeholder="ABC Fashion"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="store-subdomain" className="block text-sm font-medium text-slate-700">
                Subdomain <span className="font-normal text-slate-400">(optional — chosen from your business name if empty)</span>
              </label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  id="store-subdomain"
                  value={subdomain}
                  onChange={(event) => setSubdomain(event.target.value.toLowerCase())}
                  maxLength={63}
                  placeholder="abc-fashion"
                  className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <span className="text-sm text-slate-400">.{STOREFRONT_BASE_DOMAIN}</span>
              </div>
            </div>
            <div>
              <p className="text-sm font-medium text-slate-700">Template</p>
              {themes.length === 0 ? (
                <p className="mt-1 text-sm text-slate-500">Loading templates…</p>
              ) : (
                <ul className="mt-2 grid gap-3 sm:grid-cols-2">
                  {themes.map((theme) => (
                    <li key={theme.id}>
                      <button
                        type="button"
                        aria-pressed={themeId === theme.id}
                        onClick={() => setThemeId(theme.id)}
                        className={`w-full rounded-xl border p-4 text-left transition-colors ${
                          themeId === theme.id
                            ? "border-indigo-500 bg-indigo-50"
                            : "border-slate-200 hover:border-slate-300"
                        }`}
                      >
                        <span className="flex items-center gap-2 font-semibold text-slate-900">
                          {theme.name}
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                            {theme.category}
                          </span>
                          {theme.premium ? (
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">
                              Premium
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-1 block text-sm text-slate-600">
                          {theme.description}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => void handleCreate()} disabled={busy || !name.trim() || !themeId}>
                {busy ? "Creating…" : "Create store"}
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button className="mt-4" onClick={() => setCreating(true)}>
            Create store
          </Button>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Plans limit how many stores and custom domains you can run — the
          create button will tell you if your plan is at its limit.
        </p>
      </section>
    </div>
  );
}
