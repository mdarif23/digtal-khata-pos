import Link from "next/link";
import type { StorefrontProduct } from "@/lib/backend";
import { formatPrice } from "@/lib/format";

/** Shared product card. Price from the default variant (server-rendered). */
export function ProductCard({ product }: { product: StorefrontProduct }) {
  const variant = product.variants.find((v) => v.isDefault) ?? product.variants[0];
  const image = product.images[0];
  const inStock = (variant?.availability ?? 0) > 0;

  return (
    <Link href={`/products/${product.id}`} className="sf-card block group">
      <div className="aspect-square overflow-hidden bg-slate-100">
        {image ? (
          // Storefront images are tenant-controlled URLs served over the CDN
          // host; next/image would need a remote-pattern allowlist per tenant.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={product.name}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-4xl opacity-20">
            🛍️
          </div>
        )}
      </div>
      <div className="p-3">
        {product.categoryName ? (
          <p className="text-[11px] uppercase tracking-wide opacity-50">
            {product.categoryName}
          </p>
        ) : null}
        <p className="mt-0.5 line-clamp-2 text-sm font-medium text-[var(--sf-text)]">
          {product.name}
        </p>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-sm font-bold text-[var(--sf-primary)]">
            {variant ? formatPrice(variant.price) : "—"}
          </span>
          {!inStock ? (
            <span className="text-[11px] font-semibold uppercase text-red-600">
              Out of stock
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
