import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTenant } from "@/lib/tenant";
import { fetchProduct } from "@/lib/backend";
import { formatPrice } from "@/lib/format";
import { AddToCart } from "@/components/add-to-cart";
import { AnalyticsBeacon } from "@/components/analytics-beacon";


export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const tenant = await getTenant();
  if (!tenant) return {};
  const product = await fetchProduct(tenant.config.storefront.id, Number(id));
  if (!product) return { title: "Product not found" };
  const variant = product.variants.find((v) => v.isDefault) ?? product.variants[0];
  return {
    title: product.name,
    description:
      product.description?.slice(0, 160) ||
      `Buy ${product.name} online from ${tenant.config.storefront.name}.`,
    openGraph: {
      title: product.name,
      description: product.description?.slice(0, 160) ?? undefined,
      images: product.images[0] ? [product.images[0]] : undefined,
      type: "website",
    },
    other: variant
      ? { "product:price:amount": String(variant.price), "product:price:currency": "BDT" }
      : undefined,
  };
}

// Client-rendered per tenant — excluded from prerender.
export const instant = false;

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tenant = await getTenant();
  if (!tenant) return null;
  const productId = Number(id);
  if (!Number.isInteger(productId) || productId <= 0) notFound();

  const product = await fetchProduct(tenant.config.storefront.id, productId);
  if (!product) notFound();

  const defaultVariant = product.variants.find((v) => v.isDefault) ?? product.variants[0];
  const indexing = tenant.config.storefront.flags.searchIndexingEnabled;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description ?? undefined,
    image: product.images.length > 0 ? product.images : undefined,
    brand: product.brandName ? { "@type": "Brand", name: product.brandName } : undefined,
    category: product.categoryName ?? undefined,
    offers: defaultVariant
      ? {
          "@type": "Offer",
          price: defaultVariant.price,
          priceCurrency: "BDT",
          availability:
            defaultVariant.availability > 0
              ? "https://schema.org/InStock"
              : "https://schema.org/OutOfStock",
        }
      : undefined,
  };

  return (
    <div className="mx-auto px-4 py-8" style={{ maxWidth: "var(--sf-container)" }}>
      {tenant.config.storefront.flags.analyticsEnabled &&
      tenant.config.source === "published" ? (
        <AnalyticsBeacon storefrontId={tenant.config.storefront.id} productId={product.id} />
      ) : null}
      <script
        type="application/ld+json"
        // Structured data is built entirely from server-validated fields.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(indexing ? jsonLd : { ...jsonLd, offers: undefined }),
        }}
      />
      <nav aria-label="Breadcrumb" className="text-xs opacity-60">
        <Link href="/">Home</Link>
        <span className="mx-1">/</span>
        <Link href="/products">Products</Link>
        {product.categoryName ? (
          <>
            <span className="mx-1">/</span>
            <Link href={`/products?categoryId=${product.categoryId}`}>{product.categoryName}</Link>
          </>
        ) : null}
        <span className="mx-1">/</span>
        <span>{product.name}</span>
      </nav>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="sf-card aspect-square overflow-hidden bg-slate-100">
            {product.images[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={product.images[0]} alt={product.name} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-6xl opacity-20">🛍️</div>
            )}
          </div>
          {product.images.length > 1 ? (
            <div className="grid grid-cols-4 gap-2">
              {product.images.slice(1, 5).map((image) => (
                <div key={image} className="sf-card aspect-square overflow-hidden bg-slate-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image} alt={product.name} className="h-full w-full object-cover" loading="lazy" />
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          {product.brandName ? (
            <p className="text-xs uppercase tracking-wide opacity-60">{product.brandName}</p>
          ) : null}
          <h1 className="mt-1 text-2xl font-bold sm:text-3xl">{product.name}</h1>
          {defaultVariant ? (
            <p className="mt-3 text-2xl font-bold text-[var(--sf-primary)]">
              {formatPrice(defaultVariant.price)}
            </p>
          ) : null}
          <AddToCart product={product} />
          {product.description ? (
            <div className="mt-6 border-t border-black/10 pt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide opacity-60">
                Description
              </h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed opacity-85">
                {product.description}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
