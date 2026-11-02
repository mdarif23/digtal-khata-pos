"use client";

import Link from "next/link";
import { useCart } from "@/components/cart-context";
import { formatPrice } from "@/lib/format";

export function CartView() {
  const { items, ready, setQuantity, removeItem, subtotal } = useCart();

  if (!ready) {
    return <p className="py-20 text-center text-sm opacity-60">Loading cart…</p>;
  }

  if (items.length === 0) {
    return (
      <div className="mx-auto px-4 py-20 text-center" style={{ maxWidth: "var(--sf-container)" }}>
        <h1 className="text-2xl font-bold">Your cart is empty</h1>
        <Link href="/products" className="sf-btn mt-6 inline-flex">
          Continue shopping
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto px-4 py-8" style={{ maxWidth: "var(--sf-container)" }}>
      <h1 className="text-2xl font-bold">Your cart</h1>
      <ul className="mt-6 divide-y divide-black/10 border-y border-black/10">
        {items.map((item) => (
          <li key={item.variantId} className="flex flex-wrap items-center gap-4 py-4">
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-slate-100">
              {item.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.image} alt={item.name} className="h-full w-full object-cover" />
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <Link href={`/products/${item.productId}`} className="font-medium hover:underline">
                {item.name}
              </Link>
              {item.variantLabel ? (
                <p className="text-xs opacity-60">{item.variantLabel}</p>
              ) : null}
              <p className="text-sm text-[var(--sf-primary)]">{formatPrice(item.price)}</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label={`Decrease ${item.name}`}
                className="sf-btn-outline px-2.5"
                onClick={() => setQuantity(item.variantId, item.quantity - 1)}
              >
                −
              </button>
              <span className="w-8 text-center text-sm font-semibold">{item.quantity}</span>
              <button
                type="button"
                aria-label={`Increase ${item.name}`}
                className="sf-btn-outline px-2.5"
                onClick={() => setQuantity(item.variantId, item.quantity + 1)}
              >
                +
              </button>
            </div>
            <p className="w-24 text-right text-sm font-semibold">
              {formatPrice(item.price * item.quantity)}
            </p>
            <button
              type="button"
              className="text-xs text-red-600 hover:underline"
              onClick={() => removeItem(item.variantId)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <Link href="/products" className="text-sm opacity-70 hover:underline">
          ← Continue shopping
        </Link>
        <div className="text-right">
          <p className="text-sm opacity-70">Subtotal</p>
          <p className="text-xl font-bold">{formatPrice(subtotal)}</p>
          <p className="mt-1 text-xs opacity-60">
            Delivery calculated at checkout
          </p>
          <Link href="/checkout" className="sf-btn mt-3 inline-flex">
            Checkout
          </Link>
        </div>
      </div>
    </div>
  );
}
