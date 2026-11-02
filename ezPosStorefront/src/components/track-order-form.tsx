"use client";

import { useState } from "react";
import { formatPrice } from "@/lib/format";

interface TrackedOrder {
  invoiceNumber: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string | null;
  total: number;
  createdAt: string;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Placed — awaiting confirmation",
  completed: "Confirmed",
  cancelled: "Cancelled",
};

export function TrackOrderForm({ storefrontId }: { storefrontId: number }) {
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookup() {
    setBusy(true);
    setError(null);
    setOrder(null);
    try {
      const res = await fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storefrontId, invoiceNumber, phone }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string; data?: TrackedOrder }
        | null;
      if (res.ok && body?.ok && body.data) {
        setOrder(body.data);
      } else {
        setError(body?.message ?? "No order matches those details.");
      }
    } catch {
      setError("We could not reach the store. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-bold">Track your order</h1>
      <div className="sf-card mt-6 space-y-3 p-5">
        <label className="block text-sm">
          Order number
          <input
            className="sf-input mt-1"
            value={invoiceNumber}
            onChange={(event) => setInvoiceNumber(event.target.value)}
            placeholder="e.g. INV-1001"
          />
        </label>
        <label className="block text-sm">
          Phone used at checkout
          <input
            className="sf-input mt-1"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            inputMode="tel"
          />
        </label>
        <button
          type="button"
          className="sf-btn w-full"
          disabled={busy || invoiceNumber.trim().length < 3 || phone.trim().length < 6}
          onClick={() => void lookup()}
        >
          {busy ? "Looking up…" : "Find my order"}
        </button>
        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </div>

      {order ? (
        <div className="sf-card mt-6 p-5 text-sm">
          <p className="font-mono text-base font-bold">{order.invoiceNumber}</p>
          <p className="mt-1">
            Status:{" "}
            <span className="font-semibold">
              {STATUS_LABELS[order.status] ?? order.status}
            </span>
          </p>
          <p>
            Payment: <span className="capitalize">{order.paymentStatus}</span>
          </p>
          {order.fulfillmentStatus ? (
            <p className="capitalize">Fulfillment: {order.fulfillmentStatus}</p>
          ) : null}
          <p className="mt-1 font-semibold">{formatPrice(order.total)}</p>
          <p className="mt-2 text-xs opacity-60">
            Placed {new Date(order.createdAt).toLocaleString()}
          </p>
        </div>
      ) : null}
    </div>
  );
}
