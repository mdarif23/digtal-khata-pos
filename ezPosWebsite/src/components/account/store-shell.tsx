"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import {
  fetchStorefront,
  STOREFRONT_BASE_DOMAIN,
  type StorefrontDetail,
} from "@/lib/api/online-store";
import { STATUS_LABELS } from "@/lib/online-store-helpers";

const TABS = [
  { segment: "", label: "Overview" },
  { segment: "customize", label: "Customize" },
  { segment: "pages", label: "Pages" },
  { segment: "products", label: "Products" },
  { segment: "domains", label: "Domains" },
  { segment: "settings", label: "Settings" },
] as const;

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  preview: "bg-amber-100 text-amber-800",
  published: "bg-emerald-100 text-emerald-800",
  suspended: "bg-red-100 text-red-800",
  archived: "bg-slate-200 text-slate-600",
};

/**
 * Shared per-store chrome: header (name, status, URL) + section tabs.
 * Children fetch their own data.
 */
export function StoreShell({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const { businessId } = useActiveBusiness();
  const storeId = Number(params?.id);
  const [store, setStore] = useState<StorefrontDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId || !Number.isInteger(storeId) || storeId <= 0) return;
    let cancelled = false;
    void (async () => {
      const result = await fetchStorefront(businessId, storeId);
      if (cancelled) return;
      if (result.ok && result.data) {
        setStore(result.data);
        setMessage(null);
      } else {
        setMessage(result.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, storeId, pathname]);

  const base = `/account/online-store/${storeId}`;
  const activeSegment = pathname.startsWith(`${base}/`)
    ? (pathname.slice(base.length + 1).split("/")[0] ?? "")
    : "";

  if (!Number.isInteger(storeId) || storeId <= 0) {
    return <Alert tone="warning" title="Invalid store link." />;
  }
  if (message) {
    return <Alert tone="warning" title={message} role="alert" />;
  }
  if (!store) {
    return (
      <p className="text-sm text-slate-500" role="status">
        Loading store…
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/account/online-store"
          className="text-sm text-indigo-700 hover:underline"
        >
          ← All stores
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-slate-900">{store.name}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              STATUS_STYLES[store.status] ?? STATUS_STYLES.draft
            }`}
          >
            {STATUS_LABELS[store.status] ?? store.status}
          </span>
          {store.publishedVersionNumber ? (
            <span className="text-xs text-slate-400">
              v{store.publishedVersionNumber}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-slate-500">
          {store.subdomain}.{STOREFRONT_BASE_DOMAIN}
          {store.status !== "published" ? " · not live yet" : ""}
        </p>
      </div>

      <nav aria-label="Store sections" className="border-b border-slate-200">
        <ul className="flex gap-1 overflow-x-auto pb-px">
          {TABS.map((tab) => {
            const href = tab.segment ? `${base}/${tab.segment}` : base;
            const active = activeSegment === tab.segment;
            return (
              <li key={tab.label}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex whitespace-nowrap rounded-t-lg px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "border border-b-white border-slate-200 bg-white text-indigo-700"
                      : "text-slate-600 hover:text-slate-900",
                  )}
                >
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div>{children}</div>
    </div>
  );
}
