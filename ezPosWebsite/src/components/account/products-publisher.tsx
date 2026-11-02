"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import { formatPrice } from "@/lib/format";
import {
  fetchProducts,
  fetchVisibility,
  upsertVisibility,
  deleteVisibility,
  type ProductRow,
  type VisibilityRow,
} from "@/lib/api/online-store";

/**
 * Choose which catalog products appear on the storefront, with per-product
 * website SEO. The catalog stays the source of truth — this only manages
 * visibility; prices and stock always come from the business.
 */
export function ProductsPublisher() {
  const params = useParams<{ id: string }>();
  const storeId = Number(params?.id);
  const { businessId } = useActiveBusiness();
  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [visibility, setVisibility] = useState<Map<number, VisibilityRow>>(new Map());
  const [message, setMessage] = useState<{ tone: "info" | "warning"; text: string; role?: "alert" } | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!businessId || !Number.isInteger(storeId) || storeId <= 0) return;
    const [productsResult, visibilityResult] = await Promise.all([
      fetchProducts(businessId),
      fetchVisibility(businessId, storeId),
    ]);
    if (productsResult.ok && Array.isArray(productsResult.data)) {
      setProducts(productsResult.data);
    } else {
      setMessage({
        tone: "warning",
        text: `Could not load your catalog: ${productsResult.message}`,
        role: "alert",
      });
      setProducts([]);
    }
    if (visibilityResult.ok && Array.isArray(visibilityResult.data)) {
      const map = new Map<number, VisibilityRow>();
      for (const row of visibilityResult.data) map.set(row.productId, row);
      setVisibility(map);
    }
  }, [businessId, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!products) return [];
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter((product) =>
      product.name.toLowerCase().includes(q),
    );
  }, [products, query]);

  async function togglePublished(product: ProductRow) {
    if (!businessId) return;
    setBusyId(product.id);
    const current = visibility.get(product.id);
    const result = await upsertVisibility(businessId, storeId, product.id, {
      published: !(current?.published ?? false),
    });
    setBusyId(null);
    if (result.ok) {
      setVisibility((currentMap) => {
        const next = new Map(currentMap);
        next.set(product.id, {
          ...(current ?? {
            visibilityId: 0,
            productId: product.id,
            productName: product.name,
            productStatus: product.status,
            featured: false,
            seoTitle: null,
            seoDescription: null,
            websiteImageUrls: null,
            sortOrder: 0,
          }),
          published: !(current?.published ?? false),
        });
        return next;
      });
    } else {
      setMessage({ tone: "warning", text: result.message, role: "alert" });
    }
  }

  async function toggleFeatured(product: ProductRow) {
    if (!businessId) return;
    setBusyId(product.id);
    const current = visibility.get(product.id);
    const result = await upsertVisibility(businessId, storeId, product.id, {
      featured: !(current?.featured ?? false),
      published: true,
    });
    setBusyId(null);
    if (result.ok) {
      setVisibility((currentMap) => {
        const next = new Map(currentMap);
        next.set(product.id, {
          ...(current ?? {
            visibilityId: 0,
            productId: product.id,
            productName: product.name,
            productStatus: product.status,
            published: true,
            seoTitle: null,
            seoDescription: null,
            websiteImageUrls: null,
            sortOrder: 0,
          }),
          featured: !(current?.featured ?? false),
          published: true,
        });
        return next;
      });
    } else {
      setMessage({ tone: "warning", text: result.message, role: "alert" });
    }
  }

  async function saveSeo(product: ProductRow, seoTitle: string, seoDescription: string) {
    if (!businessId) return;
    setBusyId(product.id);
    const result = await upsertVisibility(businessId, storeId, product.id, {
      seoTitle: seoTitle || null,
      seoDescription: seoDescription || null,
    });
    setBusyId(null);
    setMessage({
      tone: result.ok ? "info" : "warning",
      text: result.ok ? "Product SEO saved." : result.message,
      role: result.ok ? undefined : "alert",
    });
    await load();
  }

  if (products === null) {
    return <p className="text-sm text-slate-500" role="status">Loading catalog…</p>;
  }

  return (
    <div className="space-y-6">
      {message ? (
        <Alert tone={message.tone} title={message.text} role={message.role ?? "status"} />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-slate-900">Products on your store</h2>
          <p className="text-sm text-slate-600">
            {visibility.size ? `${visibility.size} published` : "Nothing published yet"} ·
            prices and stock always follow your ezPos catalog
          </p>
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search products…"
          aria-label="Search products"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </div>

      <ul className="space-y-2">
        {filtered.map((product) => {
          const row = visibility.get(product.id);
          const defaultVariant = product.variants?.find((v) => v.isDefault);
          return (
            <li key={product.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-900">{product.name}</p>
                  <p className="text-sm text-slate-500">
                    {defaultVariant
                      ? formatPrice(defaultVariant.sellingPrice, "BDT")
                      : "No default variant"}
                    {product.status === "active" ? "" : ` · ${product.status ?? "inactive"}`}
                    {row?.published ? " · on store" : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={row?.featured ? "primary" : "outline"}
                  onClick={() => void toggleFeatured(product)}
                  disabled={busyId === product.id}
                  title="Featured products can appear in your homepage Featured section"
                >
                  {row?.featured ? "Featured" : "Feature"}
                </Button>
                <Button
                  size="sm"
                  variant={row?.published ? "outline" : "primary"}
                  onClick={() => void togglePublished(product)}
                  disabled={busyId === product.id}
                >
                  {row?.published ? "Unpublish" : "Publish"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setExpandedId(expandedId === product.id ? null : product.id)}
                >
                  {expandedId === product.id ? "Close" : "SEO"}
                </Button>
              </div>

              {expandedId === product.id ? (
                <ProductSeoForm
                  key={`${product.id}-${row?.seoTitle ?? ""}-${row?.seoDescription ?? ""}`}
                  initialTitle={row?.seoTitle ?? ""}
                  initialDescription={row?.seoDescription ?? ""}
                  onSave={(title, description) => void saveSeo(product, title, description)}
                  busy={busyId === product.id}
                  onRemove={
                    row
                      ? () => {
                          if (businessId) void (async () => {
                            setBusyId(product.id);
                            const result = await deleteVisibility(businessId, storeId, product.id);
                            setBusyId(null);
                            if (result.ok) await load();
                            else setMessage({ tone: "warning", text: result.message, role: "alert" });
                          })();
                        }
                      : undefined
                  }
                />
              ) : null}
            </li>
          );
        })}
      </ul>

      {filtered.length === 0 ? (
        <p className="text-sm text-slate-500">
          No products match. Add products in your ezPos catalog first.
        </p>
      ) : null}
    </div>
  );
}

function ProductSeoForm({
  initialTitle,
  initialDescription,
  onSave,
  onRemove,
  busy,
}: {
  initialTitle: string;
  initialDescription: string;
  onSave: (title: string, description: string) => void;
  onRemove?: () => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  return (
    <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
      <div>
        <label className="block text-sm font-medium text-slate-700" htmlFor={`seo-t-${initialTitle}`}>
          SEO title <span className="font-normal text-slate-400">(search results)</span>
        </label>
        <input
          id={`seo-t-${initialTitle}`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700" htmlFor={`seo-d-${initialTitle}`}>
          SEO description
        </label>
        <textarea
          id={`seo-d-${initialTitle}`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={300}
          rows={2}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onSave(title, description)} disabled={busy}>
          Save
        </Button>
        {onRemove ? (
          <Button size="sm" variant="ghost" onClick={onRemove} disabled={busy}>
            Remove from store
          </Button>
        ) : null}
      </div>
    </div>
  );
}
