"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import { useAuth } from "@/components/providers/auth-provider";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import {
  connectWoocommerce,
  createStorefrontKey,
  disconnectIntegration,
  fetchIntegrations,
  fetchStorefrontKeys,
  fetchSyncLogs,
  revokeStorefrontKey,
  syncProducts,
  syncStock,
  type Integration,
  type StorefrontKey,
  type SyncLog,
} from "@/lib/api/integrations";
import { fetchSubscription, updateBusiness } from "@/lib/api/account";

const statusStyle: Record<string, string> = {
  connected: "font-medium text-green-700",
  error: "font-medium text-red-600",
  paused: "font-medium text-amber-700",
  disconnected: "font-medium text-slate-400",
};

export function IntegrationsCenter() {
  const { businessId } = useActiveBusiness();

  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  // Business mode
  const [mode, setMode] = useState<string>("");
  const [modeBusy, setModeBusy] = useState(false);

  // API keys
  const [keys, setKeys] = useState<StorefrontKey[] | null>(null);
  const [keyName, setKeyName] = useState("");
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [shownSecret, setShownSecret] = useState<{
    publishableKey: string;
    secretKey: string;
  } | null>(null);

  // Connect form
  const [storeName, setStoreName] = useState("");
  const [storeUrl, setStoreUrl] = useState("");
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [showForm, setShowForm] = useState(false);

  const reload = useCallback(
    async (selectId?: number) => {
      if (!businessId) return;
      const result = await fetchIntegrations(businessId);
      const list = result.data ?? [];
      setIntegrations(list);
      const target = selectId ?? selectedId ?? list[0]?.id;
      if (target) {
        const logsResult = await fetchSyncLogs(businessId, target);
        setLogs(logsResult.data ?? []);
        setSelectedId(target);
      }
    },
    [businessId, selectedId],
  );

  useEffect(() => {
    void (async () => {
      await reload();
    })();
    if (businessId) {
      void (async () => {
        const detail = await fetch(
          `${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000"}/api/businesses/${businessId}`,
          {
            headers: {
              Authorization: `Bearer ${
                (await import("@/lib/api/auth")).getAccessToken() ?? ""
              }`,
              "X-Business-Id": String(businessId),
            },
          },
        );
        if (detail.ok) {
          const body = (await detail.json()) as { business: { mode: string } };
          setMode(body.business.mode);
        }
        void fetchSubscription(businessId);
        const keyList = await fetchStorefrontKeys(businessId);
        setKeys(keyList.data ?? []);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  if (!businessId) {
    return <p className="text-sm text-slate-500">Create a business first.</p>;
  }

  async function connect() {
    setBusy(true);
    setMessage(null);
    const result = await connectWoocommerce(businessId!, {
      name: storeName.trim(),
      storeUrl: storeUrl.trim(),
      consumerKey: consumerKey.trim(),
      consumerSecret: consumerSecret.trim(),
    });
    setBusy(false);
    setMessage({ text: result.message, ok: result.ok });
    if (result.ok && result.data) {
      setStoreName("");
      setStoreUrl("");
      setConsumerKey("");
      setConsumerSecret("");
      setShowForm(false);
      await reload(result.data.integrationId);
    }
  }

  async function action(
    fn: () => Promise<{ ok: boolean; message: string }>,
    selectId?: number,
  ) {
    setBusy(true);
    setMessage(null);
    const result = await fn();
    setBusy(false);
    setMessage({ text: result.message, ok: result.ok });
    await reload(selectId);
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Integrations
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Connect your WooCommerce store. ezPos stays the source of truth for
          stock and prices; store credentials are encrypted and never shown
          again.
        </p>
      </div>

      {message ? (
        <Alert tone={message.ok ? "info" : "warning"} title={message.ok ? "Done" : "Action failed"}>
          {message.text}
        </Alert>
      ) : null}

      {/* Business operating mode */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Business mode</h2>
        <p className="mt-1 text-xs text-slate-500">
          How this business sells. Online features need an online-capable
          mode; switching to physical-only requires disconnecting stores
          first.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {[
            { value: "physical_only", label: "Physical shop only" },
            { value: "online_only", label: "Online only" },
            { value: "omnichannel", label: "Physical + online" },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={modeBusy}
              className={
                mode === option.value
                  ? "rounded-full bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white"
                  : "rounded-full border border-slate-300 px-4 py-1.5 text-xs font-medium text-slate-600 hover:border-slate-400 disabled:opacity-50"
              }
              onClick={() => {
                setModeBusy(true);
                void (async () => {
                  const result = await updateBusiness(businessId!, {
                    mode: option.value as
                      | "physical_only"
                      | "online_only"
                      | "omnichannel",
                  });
                  setModeBusy(false);
                  setMessage({ text: result.message, ok: result.ok });
                  if (result.ok) setMode(option.value);
                })();
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Storefront API keys */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">API keys</h2>
            <p className="text-xs text-slate-500">
              For custom websites — see the{" "}
              <a
                href="/developers"
                className="font-medium text-indigo-700 hover:underline"
              >
                developer documentation
              </a>
              .
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowKeyForm((v) => !v)}
          >
            {showKeyForm ? "Cancel" : "Create API key"}
          </Button>
        </div>

        {shownSecret ? (
          <div className="border-b border-slate-100 bg-indigo-50/60 px-5 py-4">
            <p className="text-sm font-semibold text-indigo-900">
              Secret key — shown once, store it now
            </p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-white p-3 text-xs text-slate-800">
{`Publishable (browser): ${shownSecret.publishableKey}
Secret (server only):  ${shownSecret.secretKey}`}
            </pre>
          </div>
        ) : null}

        {showKeyForm ? (
          <div className="space-y-3 border-b border-slate-100 bg-slate-50 px-5 py-4">
            <TextField
              id="api-key-name"
              label="Key name"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              placeholder="My website"
            />
            <Button
              disabled={busy || keyName.trim().length < 2}
              onClick={() => {
                setBusy(true);
                setMessage(null);
                void (async () => {
                  const result = await createStorefrontKey(businessId!, {
                    name: keyName.trim(),
                    scopes: [
                      "products:read",
                      "inventory:read",
                      "orders:read",
                      "orders:write",
                    ],
                  });
                  setBusy(false);
                  if (result.ok && result.data) {
                    setShownSecret({
                      publishableKey: result.data.publishableKey,
                      secretKey: result.data.secretKey,
                    });
                    setKeyName("");
                    setShowKeyForm(false);
                    const list = await fetchStorefrontKeys(businessId!);
                    setKeys(list.data ?? []);
                  } else {
                    setMessage({ text: result.message, ok: false });
                  }
                })();
              }}
            >
              {busy ? "Creating…" : "Create key"}
            </Button>
          </div>
        ) : null}

        {keys === null ? (
          <p className="px-5 py-6 text-sm text-slate-500">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">
            No API keys yet. Create one to connect a custom website.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {keys.map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-slate-900">
                    {key.name}
                    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-600">
                      {key.environment}
                    </span>
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-slate-500">
                    {key.publishableKey}
                  </p>
                  <p className="text-xs text-slate-400">
                    {key.requestCount.toLocaleString()} requests
                    {key.lastUsedAt
                      ? ` · last used ${new Date(key.lastUsedAt).toLocaleString()}`
                      : ""}
                  </p>
                </div>
                {key.revokedAt ? (
                  <span className="text-xs font-medium text-slate-400">
                    revoked
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void (async () => {
                        const result = await revokeStorefrontKey(
                          businessId!,
                          key.id,
                        );
                        setBusy(false);
                        setMessage({ text: result.message, ok: result.ok });
                        const list = await fetchStorefrontKeys(businessId!);
                        setKeys(list.data ?? []);
                      })();
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Connected stores</h2>
          <Button size="sm" variant="outline" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : "Connect WooCommerce"}
          </Button>
        </div>

        {showForm ? (
          <div className="space-y-4 border-b border-slate-100 bg-slate-50 px-5 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id="wc-name"
                label="Store name"
                value={storeName}
                onChange={(event) => setStoreName(event.target.value)}
                placeholder="My WooCommerce store"
              />
              <TextField
                id="wc-url"
                label="Store URL"
                value={storeUrl}
                onChange={(event) => setStoreUrl(event.target.value)}
                placeholder="https://mystore.com"
              />
              <TextField
                id="wc-key"
                label="Consumer key"
                value={consumerKey}
                onChange={(event) => setConsumerKey(event.target.value)}
                hint="WooCommerce → Settings → Advanced → REST API. Never your WordPress password."
              />
              <TextField
                id="wc-secret"
                label="Consumer secret"
                type="password"
                value={consumerSecret}
                onChange={(event) => setConsumerSecret(event.target.value)}
              />
            </div>
            <Button onClick={connect} disabled={busy}>
              {busy ? "Connecting…" : "Connect store"}
            </Button>
          </div>
        ) : null}

        {integrations === null ? (
          <p className="px-5 py-6 text-sm text-slate-500">Loading…</p>
        ) : integrations.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">
            No stores connected yet.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {integrations.map((integration) => (
              <li
                key={integration.id}
                className={
                  selectedId === integration.id
                    ? "bg-indigo-50/50 px-5 py-4"
                    : "px-5 py-4"
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <button
                    type="button"
                    className="text-left"
                    onClick={() => {
                      setSelectedId(integration.id);
                      setLogs([]);
                      void reload(integration.id);
                    }}
                  >
                    <p className="text-sm font-medium text-slate-900">
                      {integration.name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {integration.storeUrl} · last sync{" "}
                      {integration.lastSyncAt
                        ? new Date(integration.lastSyncAt).toLocaleString()
                        : "never"}
                    </p>
                  </button>
                  <div className="flex items-center gap-2">
                    <span className={statusStyle[integration.status] ?? ""}>
                      {integration.status}
                    </span>
                    {integration.status === "connected" ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            action(
                              () => syncProducts(businessId!, integration.id),
                              integration.id,
                            )
                          }
                        >
                          Sync products
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            action(
                              () => syncStock(businessId!, integration.id),
                              integration.id,
                            )
                          }
                        >
                          Push stock
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            action(
                              () =>
                                disconnectIntegration(
                                  businessId!,
                                  integration.id,
                                ),
                              integration.id,
                            )
                          }
                        >
                          Disconnect
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
          Synchronization log {selectedId ? "" : "— select a store"}
        </h2>
        {logs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">
            {selectedId ? "No sync activity yet." : "No store selected."}
          </p>
        ) : (
          <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
            {logs.map((log) => (
              <li key={log.id} className="flex items-baseline justify-between gap-4 px-5 py-2.5 text-sm">
                <span className="flex-1">
                  <span
                    className={
                      log.status === "success"
                        ? "font-medium text-green-700"
                        : "font-medium text-red-600"
                    }
                  >
                    {log.jobType}
                  </span>
                  {log.message ? (
                    <span className="ml-2 text-slate-500">{log.message}</span>
                  ) : null}
                </span>
                <span className="whitespace-nowrap text-xs text-slate-400">
                  {new Date(log.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
