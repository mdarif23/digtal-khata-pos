"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, CircleDashed, Store } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { useAuth } from "@/components/providers/auth-provider";
import {
  fetchBusinessOperations,
  updateBusinessMode,
  type BusinessMode,
  type BusinessOperationsSnapshot,
} from "@/lib/api/account";

const MODE_OPTIONS: {
  value: BusinessMode;
  label: string;
  description: string;
}[] = [
  {
    value: "physical_only",
    label: "Physical shop only",
    description:
      "Counter sales at your store. Online integrations stay hidden — no online store needed.",
  },
  {
    value: "online_only",
    label: "Online only",
    description:
      "Sell through WooCommerce or a storefront. No register required — one stock location serves fulfillment.",
  },
  {
    value: "omnichannel",
    label: "Physical + online",
    description:
      "Run the register and online channels side by side on shared inventory.",
  },
];

type Operations = BusinessOperationsSnapshot;

function ReadinessRow({
  done,
  label,
  hint,
}: {
  done: boolean;
  label: string;
  hint: string;
}) {
  return (
    <li className="flex items-start gap-2.5">
      {done ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600" />
      ) : (
        <CircleDashed className="mt-0.5 size-4 shrink-0 text-slate-400" />
      )}
      <div className="min-w-0">
        <p className="text-sm text-slate-900">{label}</p>
        <p className="text-xs text-slate-500">{hint}</p>
      </div>
    </li>
  );
}

/**
 * Settings → Business Operations (customer portal): the operating-model
 * switch plus a snapshot of what each channel needs. Switching is
 * configuration only — it never creates or deletes data; activating online
 * operations with zero locations auto-provisions a single "Online Store"
 * stock location (backend-side, idempotent).
 */
export function BusinessOperationsCenter() {
  const { businesses } = useAuth();
  const businessId = businesses[0]?.businessId ?? null;

  const [operations, setOperations] = useState<Operations | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(
    null,
  );

  const reload = useCallback(async () => {
    if (!businessId) return;
    const result = await fetchBusinessOperations(businessId);
    setOperations(result.ok && result.data ? result.data.operations : null);
    setLoading(false);
  }, [businessId]);

  useEffect(() => {
    if (!businessId) {
      setLoading(false);
      return;
    }
    void reload();
  }, [businessId, reload]);

  async function selectMode(mode: BusinessMode) {
    if (!businessId || !operations || mode === operations.mode) return;
    setBusy(true);
    setMessage(null);
    const result = await updateBusinessMode(businessId, mode);
    setBusy(false);
    setMessage({ text: result.message, ok: result.ok });
    if (result.ok) await reload();
  }

  if (!businessId) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
        No business yet — create one from the{" "}
        <Link
          href="/dashboard"
          className="font-medium text-indigo-700 hover:underline"
        >
          dashboard
        </Link>{" "}
        first.
      </div>
    );
  }

  if (loading) {
    return (
      <p className="py-12 text-center text-sm text-slate-500" role="status">
        Loading your business operations…
      </p>
    );
  }

  if (!operations) {
    return (
      <Alert tone="warning" title="Could not load business operations">
        Make sure the ezPos backend is running, then try again.
      </Alert>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Business Operations
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Choose how this business sells. The mode is a configuration, not a
          permanent type — switch anytime without losing data.
        </p>
      </div>

      {message ? (
        <Alert
          tone={message.ok ? "info" : "warning"}
          title={message.ok ? "Done" : "Action failed"}
        >
          {message.text}
        </Alert>
      ) : null}

      {operations.subscription.accessMode !== "full" ? (
        <Alert title="Read-only mode">
          You can still switch the operating model; other changes need an
          active subscription.
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        {MODE_OPTIONS.map((option) => {
          const active = operations.mode === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={busy || active}
              onClick={() => void selectMode(option.value)}
              className={
                active
                  ? "rounded-2xl border-2 border-indigo-600 bg-indigo-50/60 p-5 text-left"
                  : "rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-indigo-400 disabled:cursor-not-allowed disabled:opacity-60"
              }
            >
              <div className="flex items-center gap-2">
                <Store className="size-4 text-indigo-600" aria-hidden="true" />
                <span className="text-sm font-semibold text-slate-900">
                  {option.label}
                </span>
                {active ? (
                  <span className="ml-auto rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white">
                    Active
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                {option.description}
              </p>
            </button>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">
            Physical store setup
          </h2>
          <ul className="mt-4 space-y-3">
            <ReadinessRow
              done={operations.readiness.stockSourceReady}
              label="Stock location"
              hint={`${operations.counts.activeLocations} active location${operations.counts.activeLocations === 1 ? "" : "s"} — every channel fulfills from a location`}
            />
            <ReadinessRow
              done={operations.readiness.registerReady}
              label="Register configured"
              hint={`${operations.counts.activeRegisters} active register${operations.counts.activeRegisters === 1 ? "" : "s"} — counter sales and drawer sessions`}
            />
          </ul>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">
            Online selling setup
          </h2>
          <ul className="mt-4 space-y-3">
            <ReadinessRow
              done={operations.readiness.catalogReady}
              label="Product catalog"
              hint={`${operations.counts.products} product${operations.counts.products === 1 ? "" : "s"} in the catalog`}
            />
            <ReadinessRow
              done={operations.readiness.onlineChannelConnected}
              label="Channel connected"
              hint={`${operations.counts.connectedChannels} WooCommerce / custom-site integration${operations.counts.connectedChannels === 1 ? "" : "s"}`}
            />
            <ReadinessRow
              done={operations.readiness.hostedStorefrontCreated}
              label="Hosted storefront"
              hint={`${operations.counts.hostedStorefronts} storefront${operations.counts.hostedStorefronts === 1 ? "" : "s"} created (plan permitting)`}
            />
          </ul>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Related setup</h2>
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <Link
            href="/account/integrations"
            className="font-medium text-indigo-700 hover:underline"
          >
            Channels & integrations
          </Link>
          <Link
            href="/account/online-store"
            className="font-medium text-indigo-700 hover:underline"
          >
            Hosted storefront
          </Link>
          <Link
            href="/account/subscription"
            className="font-medium text-indigo-700 hover:underline"
          >
            Subscription & plan limits
          </Link>
        </div>
      </div>
    </div>
  );
}
