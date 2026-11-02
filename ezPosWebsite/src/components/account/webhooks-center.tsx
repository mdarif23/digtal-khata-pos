"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import { useAuth } from "@/components/providers/auth-provider";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  fetchWebhookDeliveries,
  fetchWebhookEndpoints,
  testWebhookEndpoint,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "@/lib/api/webhooks";

const EVENTS = ["order.created", "order.paid", "order.cancelled"] as const;

const deliveryStyle: Record<string, string> = {
  delivered: "font-medium text-green-700",
  pending: "font-medium text-amber-700",
  failed: "font-medium text-red-600",
};

export function WebhooksCenter() {
  const { businesses } = useAuth();
  const businessId = businesses[0]?.businessId ?? null;

  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([
    "order.created",
  ]);
  const [shownSecret, setShownSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(
    null,
  );

  const reload = useCallback(
    async (selectId?: number) => {
      if (!businessId) return;
      const result = await fetchWebhookEndpoints(businessId);
      const list = result.data ?? [];
      setEndpoints(list);
      const target = selectId ?? selectedId ?? list[0]?.id;
      if (target) {
        setSelectedId(target);
        const deliveriesResult = await fetchWebhookDeliveries(
          businessId,
          target,
        );
        setDeliveries(deliveriesResult.data ?? []);
      } else {
        setSelectedId(null);
        setDeliveries([]);
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

  async function create() {
    setBusy(true);
    setMessage(null);
    const result = await createWebhookEndpoint(businessId!, {
      url: url.trim(),
      events: selectedEvents,
    });
    setBusy(false);
    if (result.ok && result.data) {
      setShownSecret(result.data.secret);
      setUrl("");
      await reload(result.data.id);
    } else {
      setMessage({ text: result.message, ok: false });
    }
  }

  async function remove(endpoint: WebhookEndpoint) {
    setBusy(true);
    setMessage(null);
    const result = await deleteWebhookEndpoint(businessId!, endpoint.id);
    setBusy(false);
    setMessage({ text: result.message, ok: result.ok });
    await reload();
  }

  async function test(endpoint: WebhookEndpoint) {
    setBusy(true);
    setMessage(null);
    const result = await testWebhookEndpoint(businessId!, endpoint.id);
    setBusy(false);
    setMessage({ text: result.message, ok: result.ok });
    setTimeout(() => void reload(selectedId ?? undefined), 1500);
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Webhooks
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          ezPos POSTs signed events to your endpoints as orders progress.
          Signature: <code className="text-xs">X-Ezpos-Signature: sha256=HMAC(body, secret)</code>{" "}
          — see the{" "}
          <a href="/developers" className="font-medium text-indigo-700 hover:underline">
            developer documentation
          </a>
          .
        </p>
      </div>

      {message ? (
        <Alert tone={message.ok ? "info" : "warning"} title={message.ok ? "Done" : "Action failed"}>
          {message.text}
        </Alert>
      ) : null}

      {shownSecret ? (
        <Alert tone="info" title="Signing secret — shown once">
          <code className="break-all text-xs">{shownSecret}</code>
          <p className="mt-1">
            Store it now: ezPos keeps it encrypted and uses it to sign every
            delivery. Verify deliveries by comparing the HMAC of the raw body.
          </p>
        </Alert>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">New endpoint</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <TextField
            id="webhook-url"
            label="Endpoint URL"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://yourstore.com/api/ezpos/webhook"
          />
          <div>
            <span className="block text-sm font-medium text-slate-700">
              Events
            </span>
            <div className="mt-2 flex flex-wrap gap-3">
              {EVENTS.map((event) => (
                <label key={event} className="flex items-center gap-1.5 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(event)}
                    onChange={(changeEvent) => {
                      const checked = changeEvent.target.checked;
                      setSelectedEvents((current) =>
                        checked
                          ? [...current, event]
                          : current.filter((e) => e !== event),
                      );
                    }}
                  />
                  {event}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-4">
          <Button
            onClick={create}
            disabled={busy || url.trim().length < 8 || selectedEvents.length === 0}
          >
            {busy ? "Creating…" : "Create endpoint"}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
            Endpoints
          </h2>
          {endpoints === null ? (
            <p className="px-5 py-6 text-sm text-slate-500">Loading…</p>
          ) : endpoints.length === 0 ? (
            <p className="px-5 py-6 text-sm text-slate-500">
              No endpoints registered.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {endpoints.map((endpoint) => (
                <li key={endpoint.id}>
                  <button
                    type="button"
                    className={
                      selectedId === endpoint.id
                        ? "w-full px-5 py-3 text-left bg-indigo-50"
                        : "w-full px-5 py-3 text-left hover:bg-slate-50"
                    }
                    onClick={() => {
                      setSelectedId(endpoint.id);
                      setDeliveries([]);
                      void reload(endpoint.id);
                    }}
                  >
                    <p className="break-all text-sm font-medium text-slate-900">
                      {endpoint.url}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {endpoint.events.join(", ")}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          {!selectedId ? (
            <p className="px-6 py-10 text-center text-sm text-slate-500">
              Select an endpoint to see its delivery history.
            </p>
          ) : (
            <div>
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
                <h2 className="text-sm font-semibold text-slate-900">
                  Delivery history
                </h2>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      const endpoint = endpoints?.find(
                        (e) => e.id === selectedId,
                      );
                      if (endpoint) void test(endpoint);
                    }}
                  >
                    Send test event
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      const endpoint = endpoints?.find(
                        (e) => e.id === selectedId,
                      );
                      if (endpoint) void remove(endpoint);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
              {deliveries.length === 0 ? (
                <p className="px-5 py-6 text-sm text-slate-500">
                  No deliveries yet. Events appear as orders progress.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {deliveries.map((delivery) => (
                    <li
                      key={delivery.id}
                      className="flex items-baseline justify-between gap-4 px-5 py-2.5 text-sm"
                    >
                      <span className={deliveryStyle[delivery.status] ?? ""}>
                        {delivery.event}
                        <span className="ml-2 text-xs text-slate-400">
                          attempt {delivery.attempts}
                        </span>
                      </span>
                      {delivery.lastError ? (
                        <span className="flex-1 truncate text-xs text-red-500">
                          {delivery.lastError}
                        </span>
                      ) : null}
                      <span className="whitespace-nowrap text-xs text-slate-400">
                        {new Date(delivery.createdAt).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
