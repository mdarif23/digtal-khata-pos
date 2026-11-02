"use client";

import { useState } from "react";
import { useShopper } from "./shopper-context";
import { formatPrice } from "@/lib/format";

const STATUS_LABELS: Record<string, string> = {
  pending: "Placed",
  completed: "Confirmed",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

/** Shopper account: sign in / register, then order history. */
export function ShopperAccount({ enabled }: { enabled: boolean }) {
  const { profile, ready, signIn, signOut } = useShopper();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [form, setForm] = useState({ email: "", password: "", fullName: "", phone: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!enabled) {
    return (
      <p className="py-16 text-center text-sm opacity-70">
        This store does not offer customer accounts — you can check out as a
        guest and track orders by order number and phone.
      </p>
    );
  }

  if (!ready) {
    return <p className="py-16 text-center text-sm opacity-60">Loading…</p>;
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await signIn(mode, {
      email: form.email,
      password: form.password,
      ...(mode === "register"
        ? { fullName: form.fullName, ...(form.phone ? { phone: form.phone } : {}) }
        : {}),
    });
    setBusy(false);
    if (!result.ok) setError(result.message);
  }

  if (profile) {
    const orders = profile.orders ?? [];
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold">{profile.shopper.fullName ?? "Your account"}</h1>
            <p className="text-sm opacity-70">{profile.shopper.email}</p>
          </div>
          <button type="button" className="sf-btn-outline" onClick={signOut}>
            Sign out
          </button>
        </div>

        <h2 className="text-lg font-semibold">Your orders</h2>
        {orders.length === 0 ? (
          <p className="text-sm opacity-70">No orders yet.</p>
        ) : (
          <ul className="space-y-2">
            {orders.map((order) => (
              <li key={order.invoiceNumber} className="sf-card flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
                <span className="font-mono font-semibold">{order.invoiceNumber}</span>
                <span>{STATUS_LABELS[order.status] ?? order.status}</span>
                <span className="capitalize">Payment: {order.paymentStatus}</span>
                <span className="font-semibold">{formatPrice(order.total)}</span>
                <span className="text-xs opacity-60">
                  {new Date(order.createdAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm py-8">
      <h1 className="text-2xl font-bold">
        {mode === "login" ? "Sign in" : "Create account"}
      </h1>
      <div className="sf-card mt-4 space-y-3 p-5">
        {mode === "register" ? (
          <label className="block text-sm">
            Full name
            <input
              className="sf-input mt-1"
              value={form.fullName}
              onChange={(event) => setForm({ ...form, fullName: event.target.value })}
              autoComplete="name"
            />
          </label>
        ) : null}
        <label className="block text-sm">
          Email
          <input
            className="sf-input mt-1"
            type="email"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
            autoComplete="email"
          />
        </label>
        <label className="block text-sm">
          Password
          <input
            className="sf-input mt-1"
            type="password"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </label>
        {mode === "register" ? (
          <label className="block text-sm">
            Phone (optional)
            <input
              className="sf-input mt-1"
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
              inputMode="tel"
            />
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="sf-btn w-full"
          disabled={busy || form.email.length < 5 || form.password.length < 8}
          onClick={() => void submit()}
        >
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <button
          type="button"
          className="w-full text-center text-sm opacity-70 hover:underline"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
        >
          {mode === "login"
            ? "No account yet? Create one"
            : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
