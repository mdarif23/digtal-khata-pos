"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import {
  fetchStorefront,
  publishStorefront,
  unpublishStorefront,
  STOREFRONT_BASE_DOMAIN,
  type StorefrontDetail,
} from "@/lib/api/online-store";

const STEPS = [
  { key: "customize", label: "Customize your design" },
  { key: "products", label: "Publish products" },
  { key: "domains", label: "Connect a custom domain (optional)" },
  { key: "settings", label: "Set delivery & payment options" },
  { key: "publish", label: "Publish your store" },
] as const;

export function StoreDashboard() {
  const params = useParams<{ id: string }>();
  const storeId = Number(params?.id);
  const { businessId } = useActiveBusiness();
  const [store, setStore] = useState<StorefrontDetail | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "warning"; text: string; role?: "alert" } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!businessId || !Number.isInteger(storeId) || storeId <= 0) return;
    const result = await fetchStorefront(businessId, storeId);
    if (result.ok && result.data) {
      setStore(result.data);
    } else {
      setMessage({ tone: "warning", text: result.message, role: "alert" });
    }
  }, [businessId, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handlePublish() {
    if (!businessId) return;
    setBusy(true);
    const result = await publishStorefront(businessId, storeId);
    setBusy(false);
    setMessage({ tone: result.ok ? "info" : "warning", text: result.message, role: result.ok ? undefined : "alert" });
    await load();
  }

  async function handleUnpublish() {
    if (!businessId) return;
    setBusy(true);
    const result = await unpublishStorefront(businessId, storeId);
    setBusy(false);
    setMessage({ tone: result.ok ? "info" : "warning", text: result.message, role: result.ok ? undefined : "alert" });
    await load();
  }

  if (!store) {
    return message ? (
      <Alert tone={message.tone} title={message.text} role={message.role ?? "status"} />
    ) : (
      <p className="text-sm text-slate-500" role="status">Loading…</p>
    );
  }

  const isPublished = store.status === "published";
  const suspended = store.status === "suspended";
  const publishedCount = store.publishedProductCount ?? 0;
  const doneKeys = new Set<string>([
    ...(store.status !== "draft" ? ["publish"] : []),
    ...(publishedCount > 0 ? ["products"] : []),
    ...(store.domains.some((d) => d.kind === "custom" && d.status === "verified")
      ? ["domains"]
      : []),
  ]);

  return (
    <div className="space-y-6">
      {message ? (
        <Alert tone={message.tone} title={message.text} role={message.role ?? "status"} />
      ) : null}

      {suspended ? (
        <Alert
          tone="warning"
          title="This store is suspended. Contact ezPos support to restore it — your data is safe."
          role="alert"
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Status" value={store.status === "published" ? "Live" : "Not live"} />
        <StatCard
          label="Store URL"
          value={`${store.subdomain}.${STOREFRONT_BASE_DOMAIN}`}
        />
        <StatCard label="Template" value={store.themeId} />
        <StatCard
          label="Products online"
          value={String(publishedCount)}
        />
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold text-slate-900">Publishing</h2>
        <p className="mt-1 text-sm text-slate-600">
          {isPublished
            ? `Your store is live (version ${store.publishedVersionNumber}). Changes you save in Customize stay in draft until you publish again.`
            : store.publishedVersionNumber
              ? `Your store is offline. The last published version was v${store.publishedVersionNumber}.`
              : "Your store is not published yet. Customize it, add products, then publish."}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {isPublished ? (
            <Button variant="outline" onClick={() => void handleUnpublish()} disabled={busy}>
              Unpublish
            </Button>
          ) : (
            <Button onClick={() => void handlePublish()} disabled={busy || suspended}>
              {busy ? "Publishing…" : "Publish store"}
            </Button>
          )}
          <p className="text-xs text-slate-500 sm:self-center">
            Publishing never happens automatically.
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold text-slate-900">Setup checklist</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {STEPS.map((step) => (
            <li key={step.key} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`flex size-5 items-center justify-center rounded-full text-[11px] font-semibold ${
                  doneKeys.has(step.key)
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {doneKeys.has(step.key) ? "✓" : "•"}
              </span>
              <span className={doneKeys.has(step.key) ? "text-slate-500" : "text-slate-800"}>
                {step.label}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
