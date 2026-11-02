import Link from "next/link";
import { getTenant } from "@/lib/tenant";
import { fetchCatalog } from "@/lib/backend";
import { ProductCard } from "@/components/product-card";


interface SearchParams {
  search?: string;
  categoryId?: string;
  brandId?: string;
  sort?: string;
  page?: string;
}

// Client-rendered per tenant — excluded from prerender.
export const instant = false;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await getTenant();
  if (!tenant) return null;
  const params = await searchParams;
  const storefrontId = tenant.config.storefront.id;

  const categoryId = params.categoryId ? Number(params.categoryId) : undefined;
  const brandId = params.brandId ? Number(params.brandId) : undefined;
  const page = params.page ? Number(params.page) : 1;
  const catalog = await fetchCatalog({
    storefrontId,
    search: params.search,
    categoryId,
    brandId,
    sort: params.sort,
    page: Number.isInteger(page) && page > 0 ? page : 1,
  });

  if (!catalog) {
    return (
      <div className="mx-auto px-4 py-20 text-center text-sm opacity-70" style={{ maxWidth: "var(--sf-container)" }}>
        The catalog is unavailable right now. Please try again shortly.
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(catalog.total / catalog.pageSize));
  const activeCategory = catalog.categories.find((c) => c.id === categoryId);
  const activeBrand = catalog.brands.find((b) => b.id === brandId);

  function pageLink(target: number): string {
    const query = new URLSearchParams();
    if (params.search) query.set("search", params.search);
    if (categoryId) query.set("categoryId", String(categoryId));
    if (brandId) query.set("brandId", String(brandId));
    if (params.sort) query.set("sort", params.sort);
    if (target > 1) query.set("page", String(target));
    const qs = query.toString();
    return qs ? `/products?${qs}` : "/products";
  }

  return (
    <div className="mx-auto px-4 py-8" style={{ maxWidth: "var(--sf-container)" }}>
      <nav aria-label="Breadcrumb" className="text-xs opacity-60">
        <Link href="/">Home</Link>
        <span className="mx-1">/</span>
        <span>Products</span>
        {activeCategory ? (
          <>
            <span className="mx-1">/</span>
            <span>{activeCategory.name}</span>
          </>
        ) : null}
        {activeBrand ? (
          <>
            <span className="mx-1">/</span>
            <span>{activeBrand.name}</span>
          </>
        ) : null}
      </nav>

      <h1 className="mt-3 text-2xl font-bold">
        {params.search
          ? `Search: “${params.search}”`
          : (activeCategory?.name ?? activeBrand?.name ?? "All products")}
      </h1>
      <p className="mt-1 text-sm opacity-60">{catalog.total} products</p>

      <div className="mt-6 grid gap-8 lg:grid-cols-[200px_1fr]">
        <aside className="space-y-6 text-sm">
          <div>
            <p className="mb-2 font-semibold uppercase tracking-wide opacity-60">Categories</p>
            <ul className="space-y-1">
              <li>
                <Link
                  href={pageLink(1).replace(/([?&])categoryId=\d+&?/, "$1").replace(/[?&]$/, "")}
                  className={!categoryId ? "font-semibold text-[var(--sf-primary)]" : ""}
                >
                  All
                </Link>
              </li>
              {catalog.categories.map((category) => (
                <li key={category.id}>
                  <Link
                    href={`/products?categoryId=${category.id}`}
                    className={categoryId === category.id ? "font-semibold text-[var(--sf-primary)]" : ""}
                  >
                    {category.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-2 font-semibold uppercase tracking-wide opacity-60">Sort</p>
            <ul className="space-y-1">
              {[
                { value: "", label: "Newest" },
                { value: "price_asc", label: "Price: low to high" },
                { value: "price_desc", label: "Price: high to low" },
                { value: "name", label: "Name A–Z" },
              ].map((option) => {
                const query = new URLSearchParams();
                if (params.search) query.set("search", params.search);
                if (categoryId) query.set("categoryId", String(categoryId));
                if (brandId) query.set("brandId", String(brandId));
                if (option.value) query.set("sort", option.value);
                const qs = query.toString();
                return (
                  <li key={option.label}>
                    <Link
                      href={qs ? `/products?${qs}` : "/products"}
                      className={
                        (params.sort ?? "") === option.value
                          ? "font-semibold text-[var(--sf-primary)]"
                          : ""
                      }
                    >
                      {option.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>

        <div>
          {catalog.products.length === 0 ? (
            <p className="py-16 text-center text-sm opacity-70">
              No products found. Try a different search or category.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {catalog.products.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          )}

          {totalPages > 1 ? (
            <nav aria-label="Pagination" className="mt-8 flex justify-center gap-2 text-sm">
              {Array.from({ length: Math.min(totalPages, 10) }, (_, index) => index + 1).map((target) => (
                <Link
                  key={target}
                  href={pageLink(target)}
                  aria-current={target === catalog.page ? "page" : undefined}
                  className={`rounded-lg border px-3 py-1.5 ${
                    target === catalog.page
                      ? "border-[var(--sf-primary)] font-semibold text-[var(--sf-primary)]"
                      : "border-black/10"
                  }`}
                >
                  {target}
                </Link>
              ))}
            </nav>
          ) : null}
        </div>
      </div>
    </div>
  );
}
