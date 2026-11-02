"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/components/providers/auth-provider";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import {
  fetchOrderDetail,
  fetchOrders,
  markOrderPaid,
  setFulfillmentStatus,
  type OrderDetail,
  type UnifiedOrder,
} from "@/lib/api/orders";

const CHANNELS = [
  { value: "", label: "All channels" },
  { value: "pos", label: "Physical POS" },
  { value: "woocommerce", label: "WooCommerce" },
  { value: "custom_storefront", label: "Custom storefront" },
] as const;

const STATUSES = ["", "pending", "completed", "cancelled", "refunded"] as const;

const channelLabel: Record<string, string> = {
  pos: "POS",
  woocommerce: "WooCommerce",
  custom_storefront: "Storefront",
};

function money(amount: number | null): string {
  return `BDT ${Number(amount ?? 0).toLocaleString()}`;
}

function detailRow(label: string, value: string) {
  return (
    <div className="flex justify-between py-1 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-900">{value}</span>
    </div>
  );
}

export function OrdersCenter() {
  const { businessId } = useActiveBusiness();

  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [orders, setOrders] = useState<UnifiedOrder[] | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const reload = useCallback(
    async (selectId?: number) => {
      if (!businessId) return;
      const result = await fetchOrders(businessId, { channel, status, page });
      setOrders(result.data?.orders ?? []);
      setHasMore((result.data?.orders?.length ?? 0) >= 25);
      if (selectId) {
        const d = await fetchOrderDetail(businessId, selectId);
        setDetail(d.ok && d.data ? d.data : null);
      }
    },
    [businessId, channel, status, page],
  );

  useEffect(() => {
    void (async () => {
      await reload();
    })();
  }, [reload]);

  async function act(
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Orders
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Every sale across every channel — the counter and your online
          stores — with fulfillment tracking for online orders.
        </p>
      </div>

      {message ? (
        <Alert tone={message.ok ? "info" : "warning"} title={message.ok ? "Done" : "Action failed"}>
          {message.text}
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {CHANNELS.map((c) => (
          <button
            key={c.value || "all"}
            type="button"
            className={
              channel === c.value
                ? "rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white"
                : "rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-400"
            }
            onClick={() => {
              setChannel(c.value);
              setPage(1);
            }}
          >
            {c.label}
          </button>
        ))}
        <span className="mx-1 text-slate-300">|</span>
        {STATUSES.map((s) => (
          <button
            key={s || "any"}
            type="button"
            className={
              status === s
                ? "rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white"
                : "rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-400"
            }
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
          >
            {s || "any status"}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {orders === null ? (
          <p className="px-5 py-8 text-sm text-slate-500">Loading…</p>
        ) : orders.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-500">
            No orders match these filters.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2 font-medium">Invoice</th>
                <th className="px-5 py-2 font-medium">Channel</th>
                <th className="px-5 py-2 font-medium">Customer</th>
                <th className="px-5 py-2 font-medium">Total</th>
                <th className="px-5 py-2 font-medium">Payment</th>
                <th className="px-5 py-2 font-medium">Fulfillment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {orders.map((order) => (
                <tr key={order.id}>
                  <td className="px-5 py-3">
                    <button
                      type="button"
                      className="font-medium text-indigo-700 hover:underline"
                      onClick={() => {
                        setDetail(null);
                        void (async () => {
                          const d = await fetchOrderDetail(
                            businessId!,
                            order.id,
                          );
                          if (d.ok && d.data) setDetail(d.data);
                        })();
                      }}
                    >
                      {order.invoiceNumber}
                    </button>
                    {order.externalOrderNumber ? (
                      <span className="block text-xs text-slate-400">
                        #{order.externalOrderNumber}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {channelLabel[order.channel] ?? order.channel}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {order.customerName ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {money(order.finalTotal)}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {order.paymentStatus}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {order.channel === "pos" ? "—" : order.fulfillmentStatus}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager page={page} hasMore={hasMore} onPage={setPage} />
      </div>

      {detail ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">
                {detail.invoiceNumber}
                <span className="ml-2 text-xs font-normal text-slate-500">
                  {channelLabel[detail.channel] ?? detail.channel} ·{" "}
                  {detail.status} · payment {detail.paymentStatus}
                </span>
              </p>
              {detail.customerName ? (
                <p className="mt-1 text-xs text-slate-500">
                  {detail.customerName}
                  {detail.customerPhone ? ` · ${detail.customerPhone}` : ""}
                  {detail.customerEmail ? ` · ${detail.customerEmail}` : ""}
                </p>
              ) : null}
            </div>
            {detail.channel !== "pos" && detail.status === "pending" ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  act(
                    () => markOrderPaid(businessId!, detail.id),
                    detail.id,
                  )
                }
              >
                Mark paid (COD)
              </Button>
            ) : null}
            {detail.channel !== "pos" && detail.status === "completed" ? (
              <div className="flex gap-2">
                {(["processing", "shipped", "delivered"] as const)
                  .filter(
                    (s) =>
                      !(
                        (detail.fulfillmentStatus === "processing" &&
                          s === "processing") ||
                        (detail.fulfillmentStatus === "shipped" &&
                          s === "shipped") ||
                        (detail.fulfillmentStatus === "delivered" &&
                          s === "delivered")
                      ),
                  )
                  .map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        act(
                          () =>
                            setFulfillmentStatus(businessId!, detail.id, s),
                          detail.id,
                        )
                      }
                    >
                      Mark {s}
                    </Button>
                  ))}
              </div>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDetail(null)}
              aria-label="Close order detail"
            >
              Close
            </Button>
          </div>

          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Items
              </h3>
              <ul className="mt-2 divide-y divide-slate-100">
                {detail.items.map((item) => (
                  <li key={item.id} className="flex justify-between py-2 text-sm">
                    <span className="text-slate-700">
                      {item.productName}
                      <span className="block text-xs text-slate-400">
                        {item.sku} · ×{item.quantity}
                      </span>
                    </span>
                    <span className="font-medium text-slate-900">
                      {money(item.lineTotal)}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 border-t border-slate-100 pt-2">
                {detailRow("Subtotal", money(detail.subtotal))}
                {detail.vat ? detailRow("VAT", money(detail.vat)) : null}
                {detailRow("Total", money(detail.finalTotal))}
                {detail.dueAmount && detail.dueAmount > 0
                  ? detailRow("Due", money(detail.dueAmount))
                  : null}
              </div>
            </div>
            <div className="text-sm text-slate-600">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Details
              </h3>
              <div className="mt-2 space-y-1">
                {detailRow("Location", detail.locationName ?? "—")}
                {detailRow("Placed", detail.createdAt ? new Date(detail.createdAt).toLocaleString() : "—")}
                {detail.externalOrderNumber
                  ? detailRow("External ref", detail.externalOrderNumber)
                  : null}
                {detail.note ? detailRow("Note", detail.note) : null}
                {detailRow("Fulfillment", detail.fulfillmentStatus)}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Pager({
  page,
  hasMore,
  onPage,
}: {
  page: number;
  hasMore: boolean;
  onPage: (next: number) => void;
}) {
  if (page === 1 && !hasMore) return null;
  return (
    <div className="flex items-center gap-3 px-5 py-3 text-sm">
      <button
        type="button"
        disabled={page === 1}
        onClick={() => onPage(page - 1)}
        className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 disabled:opacity-40"
      >
        ← Previous
      </button>
      <span className="text-xs text-slate-500">Page {page}</span>
      <button
        type="button"
        disabled={!hasMore}
        onClick={() => onPage(page + 1)}
        className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 disabled:opacity-40"
      >
        Next →
      </button>
    </div>
  );
}
