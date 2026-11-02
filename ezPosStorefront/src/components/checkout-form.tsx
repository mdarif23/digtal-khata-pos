"use client";

import Link from "next/link";
import { useState } from "react";
import { useCart } from "./cart-context";
import { useShopper } from "./shopper-context";
import { formatPrice } from "@/lib/format";

interface Zone {
  id: number;
  name: string;
  areas: string[];
  rate: string | number;
  freeThreshold: string | number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
}

interface PlacedOrder {
  invoiceNumber: string;
  total: number;
  deliveryFee: number;
}

/**
 * COD checkout. Lines are revalidated server-side — prices, stock and the
 * delivery fee shown here are recomputed by the backend before the order is
 * created, and the client never sends totals.
 */
export function CheckoutForm({
  storefrontId,
  zones,
  storePickupEnabled,
  paymentMethods,
  returnOrigin,
}: {
  storefrontId: number;
  zones: Zone[];
  storePickupEnabled: boolean;
  paymentMethods: Array<{ method: string; label: string | null }>;
  returnOrigin: string;
}) {
  const { items, ready, clear, subtotal } = useCart();
  const { token: shopperToken } = useShopper();
  const [paymentMethod, setPaymentMethod] = useState<string>(
    paymentMethods[0]?.method ?? "cod",
  );
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    address: "",
    city: "",
    area: "",
    note: "",
  });
  const [deliveryZoneId, setDeliveryZoneId] = useState<number | null>(zones[0]?.id ?? null);
  const [storePickup, setStorePickup] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<PlacedOrder | null>(null);

  const selectedZone = zones.find((zone) => zone.id === deliveryZoneId);
  const estimatedFee = storePickup
    ? 0
    : selectedZone
      ? selectedZone.freeThreshold !== null &&
        subtotal >= Number(selectedZone.freeThreshold)
        ? 0
        : Number(selectedZone.rate)
      : null;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const idempotencyKey =
        globalThis.crypto?.randomUUID?.() ??
        `cart-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storefrontId,
          customer: {
            name: form.name,
            phone: form.phone,
            ...(form.email ? { email: form.email } : {}),
            address: form.address,
            city: form.city,
            ...(form.area ? { area: form.area } : {}),
            ...(form.note ? { note: form.note } : {}),
          },
          lines: items.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
          })),
          deliveryZoneId: storePickup ? null : deliveryZoneId,
          storePickup,
          paymentMethod,
          returnOrigin,
          ...(shopperToken ? { shopperToken } : {}),
          idempotencyKey,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string; data?: PlacedOrder }
        | null;
      const data = body?.data as
        | (PlacedOrder & { payment?: { gatewayUrl?: string } })
        | undefined;
      if (res.ok && body?.ok && data?.payment?.gatewayUrl) {
        // Online payment: send the shopper to the gateway. Verification
        // happens server-side after the redirect/IPN — never here.
        clear();
        window.location.href = data.payment.gatewayUrl;
        return;
      }
      if (res.ok && body?.ok && data) {
        setPlaced(data);
        clear();
      } else {
        setError(body?.message ?? "Checkout failed. Please try again.");
      }
    } catch {
      setError("We could not reach the store. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (placed) {
    return (
      <div className="mt-8 rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
        <p className="text-3xl">🎉</p>
        <h2 className="mt-2 text-xl font-bold text-emerald-900">Order placed!</h2>
        <p className="mt-2 text-sm text-emerald-800">
          Your order number is{" "}
          <span className="font-mono font-bold">{placed.invoiceNumber}</span>. We
          will contact you at {form.phone} to confirm delivery
          {placed.deliveryFee > 0
            ? ` (delivery ${formatPrice(placed.deliveryFee)}).`
            : "."}
        </p>
        <p className="mt-1 text-sm text-emerald-800">
          Order total: <strong>{formatPrice(placed.total)}</strong> — pay cash on
          delivery.
        </p>
        <Link href="/orders/track" className="sf-btn mt-6 inline-flex">
          Track your order
        </Link>
      </div>
    );
  }

  if (ready && items.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm opacity-70">Your cart is empty.</p>
        <Link href="/products" className="sf-btn mt-4 inline-flex">
          Browse products
        </Link>
      </div>
    );
  }

  const canSubmit =
    form.name.trim().length >= 2 &&
    form.phone.trim().length >= 6 &&
    form.address.trim().length >= 4 &&
    form.city.trim().length >= 1 &&
    (storePickup || deliveryZoneId !== null) &&
    !submitting;

  return (
    <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <fieldset className="sf-card space-y-3 p-5" disabled={submitting}>
          <legend className="px-1 text-sm font-semibold">Delivery details</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              Full name *
              <input
                className="sf-input mt-1"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                autoComplete="name"
                required
              />
            </label>
            <label className="block text-sm">
              Phone *
              <input
                className="sf-input mt-1"
                value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
                autoComplete="tel"
                inputMode="tel"
                required
              />
            </label>
          </div>
          <label className="block text-sm">
            Address *
            <textarea
              className="sf-input mt-1"
              rows={2}
              value={form.address}
              onChange={(event) => setForm({ ...form, address: event.target.value })}
              autoComplete="street-address"
              required
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              City *
              <input
                className="sf-input mt-1"
                value={form.city}
                onChange={(event) => setForm({ ...form, city: event.target.value })}
                autoComplete="address-level2"
                required
              />
            </label>
            <label className="block text-sm">
              Area
              <input
                className="sf-input mt-1"
                value={form.area}
                onChange={(event) => setForm({ ...form, area: event.target.value })}
              />
            </label>
          </div>
          <label className="block text-sm">
            Email (optional)
            <input
              className="sf-input mt-1"
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              autoComplete="email"
            />
          </label>
          <label className="block text-sm">
            Delivery instructions (optional)
            <input
              className="sf-input mt-1"
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
              maxLength={500}
            />
          </label>
        </fieldset>

        <fieldset className="sf-card space-y-2 p-5" disabled={submitting}>
          <legend className="px-1 text-sm font-semibold">Delivery method</legend>
          {storePickupEnabled ? (
            <label className="flex items-center gap-2 rounded-lg border p-3 text-sm">
              <input
                type="radio"
                name="delivery"
                checked={storePickup}
                onChange={() => setStorePickup(true)}
              />
              Store pickup — free
            </label>
          ) : null}
          {zones.map((zone) => (
            <label
              key={zone.id}
              className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${storePickup ? "" : deliveryZoneId === zone.id ? "border-[var(--sf-primary)]" : ""}`}
            >
              <input
                type="radio"
                name="delivery"
                checked={!storePickup && deliveryZoneId === zone.id}
                onChange={() => {
                  setStorePickup(false);
                  setDeliveryZoneId(zone.id);
                }}
              />
              <span className="flex-1">
                <span className="font-medium">{zone.name}</span>
                {zone.areas.length > 0 ? (
                  <span className="ml-2 text-xs opacity-60">
                    {zone.areas.slice(0, 4).join(", ")}
                  </span>
                ) : null}
                {zone.estimatedDaysMin !== null || zone.estimatedDaysMax !== null ? (
                  <span className="ml-2 text-xs opacity-60">
                    ({zone.estimatedDaysMin ?? "?"}–{zone.estimatedDaysMax ?? "?"} days)
                  </span>
                ) : null}
              </span>
              <span className="font-semibold">
                {zone.freeThreshold !== null
                  ? `৳${Number(zone.rate).toLocaleString()} (free over ৳${Number(zone.freeThreshold).toLocaleString()})`
                  : `৳${Number(zone.rate).toLocaleString()}`}
              </span>
            </label>
          ))}
          {zones.length === 0 && !storePickupEnabled ? (
            <p className="text-sm text-amber-700">
              This store has not configured delivery yet — contact the store to
              order.
            </p>
          ) : null}
        </fieldset>

        <fieldset className="sf-card space-y-2 p-5" disabled={submitting}>
          <legend className="px-1 text-sm font-semibold">Payment</legend>
          {paymentMethods.map((method) => (
            <label
              key={method.method}
              className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${paymentMethod === method.method ? "border-[var(--sf-primary)]" : ""}`}
            >
              <input
                type="radio"
                name="payment"
                checked={paymentMethod === method.method}
                onChange={() => setPaymentMethod(method.method)}
              />
              {method.label ?? (method.method === "cod" ? "Cash on delivery" : "Online payment")}
              <span className="ml-auto text-xs opacity-60">
                {method.method === "cod" ? "pay on delivery" : "pay now"}
              </span>
            </label>
          ))}
        </fieldset>
      </div>

      <aside className="sf-card h-fit p-5 lg:sticky lg:top-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide opacity-60">
          Order summary
        </h2>
        <ul className="mt-3 space-y-2 text-sm">
          {items.map((item) => (
            <li key={item.variantId} className="flex justify-between gap-2">
              <span className="min-w-0 flex-1 truncate">
                {item.name} × {item.quantity}
              </span>
              <span>{formatPrice(item.price * item.quantity)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-1 border-t border-black/10 pt-3 text-sm">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatPrice(subtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span>Delivery</span>
            <span>
              {storePickup
                ? "Free"
                : estimatedFee === null
                  ? "—"
                  : estimatedFee === 0
                    ? "Free"
                    : formatPrice(estimatedFee)}
            </span>
          </div>
          <div className="flex justify-between text-base font-bold">
            <span>Total</span>
            <span>
              {formatPrice(subtotal + (storePickup ? 0 : (estimatedFee ?? 0)))}
            </span>
          </div>
          <p className="text-xs opacity-60">Pay cash when your order arrives.</p>
        </div>
        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="sf-btn mt-4 w-full"
          disabled={!canSubmit || submitting || items.length === 0}
          onClick={() => void submit()}
        >
          {submitting ? "Placing order…" : "Place order"}
        </button>
      </aside>
    </div>
  );
}
