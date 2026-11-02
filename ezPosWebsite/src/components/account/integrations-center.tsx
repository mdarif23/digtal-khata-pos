"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import { useAuth } from "@/components/providers/auth-provider";
import {
  connectWoocommerce,
  disconnectIntegration,
  fetchIntegrations,
  fetchSyncLogs,
  syncProducts,
  syncStock,
  type Integration,
  type SyncLog,
} from "@/lib/api/integrations";

const statusStyle: Record<string, string> = {
  connected: "font-medium text-green-700",
  error: "font-medium text-red-600",
  paused: "font-medium text-amber-700",
  disconnected: "font-medium text-slate-400",
};

export function IntegrationsCenter() {
  const { businesses } = useAuth();
  const businessId = businesses[0]?.businessId ?? null;

  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

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
    void reload();
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
