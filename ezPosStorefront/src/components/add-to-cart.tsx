"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useCart } from "./cart-context";
import { formatPrice } from "@/lib/format";
import type { StorefrontProduct } from "@/lib/backend";

/**
 * Variant selection + add-to-cart. Availability comes from the server
 * (reservation engine); checkout revalidates stock server-side.
 */
export function AddToCart({ product }: { product: StorefrontProduct }) {
  const { addItem } = useCart();
  const inStockVariants = useMemo(
    () => product.variants.filter((variant) => variant.availability > 0),
    [product.variants],
  );
  const [variantId, setVariantId] = useState<number | null>(
    (product.variants.find((v) => v.isDefault) ?? product.variants[0])?.id ?? null,
  );
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);

  const selected =
    product.variants.find((variant) => variant.id === variantId) ??
    product.variants[0];
  const soldOut = !selected || selected.availability <= 0;

  if (product.variants.length === 0) {
    return (
      <p className="mt-6 rounded-lg bg-slate-100 p-4 text-sm opacity-70">
        This product is currently unavailable.
      </p>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      {product.variants.length > 1 ? (
        <div>
          <label htmlFor="variant" className="mb-1 block text-sm font-medium">
            Option
          </label>
          <select
            id="variant"
            className="sf-input max-w-xs"
            value={variantId ?? ""}
            onChange={(event) => {
              setVariantId(Number(event.target.value));
              setAdded(false);
            }}
          >
            {product.variants.map((variant) => (
              <option key={variant.id} value={variant.id} disabled={variant.availability <= 0}>
                {[variant.sku, formatPrice(variant.price)].filter(Boolean).join(" — ")}
                {variant.availability <= 0 ? " (out of stock)" : ""}
              </option>
            ))}
          </select>
          {inStockVariants.length === 0 ? (
            <p className="mt-2 text-sm font-semibold text-red-600">Out of stock</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Decrease quantity"
            className="sf-btn-outline rounded-r-none"
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            disabled={soldOut}
          >
            −
          </button>
          <input
            aria-label="Quantity"
            className="sf-input w-14 rounded-none text-center"
            value={quantity}
            readOnly
          />
          <button
            type="button"
            aria-label="Increase quantity"
            className="sf-btn-outline rounded-l-none"
            onClick={() => setQuantity((q) => Math.min(99, q + 1))}
            disabled={soldOut}
          >
            +
          </button>
        </div>
        <button
          type="button"
          className="sf-btn"
          disabled={soldOut}
          onClick={() => {
            if (!selected) return;
            addItem({
              variantId: selected.id,
              productId: product.id,
              name: product.name,
              variantLabel: product.variants.length > 1 ? selected.sku : "",
              price: selected.price,
              image: product.images[0] ?? null,
              quantity,
            });
            setAdded(true);
          }}
        >
          {soldOut ? "Out of stock" : "Add to cart"}
        </button>
        {added ? (
          <Link href="/cart" className="text-sm font-semibold text-[var(--sf-primary)] hover:underline">
            Added — view cart →
          </Link>
        ) : null}
      </div>
      {selected && selected.availability > 0 && selected.availability <= 5 ? (
        <p className="text-xs font-medium text-amber-700">
          Only {selected.availability} left in stock
        </p>
      ) : null}
    </div>
  );
}
