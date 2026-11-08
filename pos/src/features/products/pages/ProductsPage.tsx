import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ProductOverview from "../components/ProductsPage/Table.js";
import { DataTable } from "../components/ProductsPage/Table/data-table.js";
import { columns } from "../components/ProductsPage/Table/columns.js";
import useProductStore from "../useProductStore.js";
import type { ProductType } from "../product.schema.js";
import { calculateProductStats } from "../utils/calculateProductStats.js";
import { getProductStockState } from "../utils/getProductStockState.js";
import { buildVariantOptionsLabel } from "@/lib/variantDisplay";
import { toast } from "@/components/ui/toast";
import type { LookupMatch } from "@/features/barcodes/barcode.api";
import { useBarcodeScanner } from "@/features/barcodes/scanning/useBarcodeScanner";
import { BarcodeScanFeedback } from "@/features/barcodes/scanning/BarcodeScanFeedback";
import { createCatalogLookup } from "@/features/barcodes/scanning/catalogLookup";

type ProductStatusFilter = "all" | "active" | "draft" | "inactive";
type StockFilter = "all" | "in-stock" | "low-stock" | "out-of-stock";

function csvCell(value: string | number | null | undefined) {
  const text = String(value ?? "");
  const safeText = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

function downloadProductsCsv(
  products: ProductType[],
  categories: { value: number; label: string }[],
  brands: { value: number; label: string }[],
  unitAbbreviationById: Map<number, string>,
) {
  const rows: (string | number | null | undefined)[][] = [
    [
      "Product",
      "Product status",
      "Category",
      "Brand",
      "Variant",
      "SKU",
      "Barcode",
      "Stock",
      "Alert quantity",
      "Purchase cost",
      "Selling price",
      // Stock quantities are base units; the unit label names them when known.
      "Stock unit",
    ],
  ];

  for (const product of products) {
    const category =
      categories.find((item) => item.value === product.categoryId)?.label ?? "";
    const brand =
      brands.find((item) => item.value === product.brandId)?.label ?? "";
    const stockUnit =
      (product.unitId !== null
        ? unitAbbreviationById.get(product.unitId)
        : undefined) ?? "";

    if (product.variants.length === 0) {
      rows.push([
        product.name,
        product.status,
        category,
        brand,
        "",
        "",
        "",
        0,
        "",
        "",
        "",
        stockUnit,
      ]);
      continue;
    }

    for (const variant of product.variants) {
      rows.push([
        product.name,
        product.status,
        category,
        brand,
        buildVariantOptionsLabel(variant.options),
        variant.sku,
        variant.barcode,
        variant.quantity,
        variant.alertQuantity,
        variant.purchaseCost ?? variant.purchasePrice,
        variant.sellingPrice,
        stockUnit,
      ]);
    }
  }

  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `products-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const stockFilters: { value: StockFilter; label: string }[] = [
  { value: "all", label: "All stock" },
  { value: "in-stock", label: "In stock" },
  { value: "low-stock", label: "Low stock" },
  { value: "out-of-stock", label: "Out of stock" },
];

export function Products() {
  const products = useProductStore((state) => state.products);
  const loading = useProductStore((state) => state.loading);
  const error = useProductStore((state) => state.error);
  const getProducts = useProductStore((state) => state.getProducts);
  const productSelectOptions = useProductStore(
    (state) => state.productSelectOptions,
  );
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProductStatusFilter>("all");
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [brandFilter, setBrandFilter] = useState("all");
  const navigate = useNavigate();

  /**
   * Module scan handler — the scanner service only IDENTIFIES a barcode;
   * the product-management rule (open the product edit page and highlight
   * the scanned variant) lives here. Unknown barcodes never create
   * products. Throwing surfaces the failure as an error scan.
   */
  const handleResolved = useCallback(
    async (match: LookupMatch) => {
      const findRow = (catalog: ProductType[]) =>
        catalog
          .flatMap((product) =>
            product.variants.map((variant) => ({ product, variant })),
          )
          .find(({ variant }) => variant.id === match.variantId);

      let row = findRow(useProductStore.getState().products);
      if (!row) {
        await useProductStore.getState().getProducts();
        row = findRow(useProductStore.getState().products);
      }
      if (!row) {
        throw new Error(`${match.productName} is not in the loaded catalog.`);
      }
      navigate(`/product/${row.product.id}/edit`, {
        state: { highlightVariantId: match.variantId },
      });
    },
    [navigate],
  );

  const scanner = useBarcodeScanner({
    capture: "window",
    lookup: useCallback(
      createCatalogLookup(() => useProductStore.getState().products),
      [],
    ),
    onResolve: handleResolved,
  });

  // Scan outcome → toast (spec §16: never silently ignore failed scans).
  const lastHandledEventId = useRef(0);
  useEffect(() => {
    const event = scanner.state.last;
    if (!event || event.id <= lastHandledEventId.current) return;
    lastHandledEventId.current = event.id;
    if (event.status === "not_found") {
      toast.add({
        type: "error",
        description: "No product matches that barcode.",
      });
    } else if (event.status === "ambiguous") {
      toast.add({
        type: "error",
        description:
          event.detail ?? "That barcode matches more than one product.",
        priority: "high",
      });
    } else if (event.status === "error") {
      toast.add({
        type: "error",
        description: event.detail ?? "Scan failed.",
        priority: "high",
      });
    }
  }, [scanner.state.last]);

  const stats = useMemo(() => calculateProductStats(products), [products]);
  const stockCounts = useMemo(
    () => ({
      "all": products.length,
      "in-stock": products.filter(
        (product) => getProductStockState(product) === "in-stock",
      ).length,
      "low-stock": products.filter(
        (product) => getProductStockState(product) === "low-stock",
      ).length,
      "out-of-stock": products.filter(
        (product) => getProductStockState(product) === "out-of-stock",
      ).length,
    }),
    [products],
  );

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return products.filter((product) => {
      const matchesSearch =
        query.length === 0 ||
        product.name.toLocaleLowerCase().includes(query) ||
        product.variants.some((variant) =>
          [variant.sku, variant.barcode ?? ""]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query),
        );
      const matchesStatus =
        statusFilter === "all" || product.status === statusFilter;
      const matchesStock =
        stockFilter === "all" || getProductStockState(product) === stockFilter;
      const matchesCategory =
        categoryFilter === "all" ||
        String(product.categoryId) === categoryFilter;
      const matchesBrand =
        brandFilter === "all" || String(product.brandId) === brandFilter;

      return (
        matchesSearch &&
        matchesStatus &&
        matchesStock &&
        matchesCategory &&
        matchesBrand
      );
    });
  }, [
    brandFilter,
    categoryFilter,
    products,
    search,
    statusFilter,
    stockFilter,
  ]);

  const hasActiveFilters =
    search !== "" ||
    statusFilter !== "all" ||
    stockFilter !== "all" ||
    categoryFilter !== "all" ||
    brandFilter !== "all";

  const clearFilters = () => {
    setSearch("");
    setStatusFilter("all");
    setStockFilter("all");
    setCategoryFilter("all");
    setBrandFilter("all");
  };

  const unitAbbreviationById = useMemo(
    () =>
      new Map(
        productSelectOptions.units.map((unit) => [unit.value, unit.abbreviation]),
      ),
    [productSelectOptions.units],
  );

  const exportProducts = (rows: ProductType[]) =>
    downloadProductsCsv(
      rows,
      productSelectOptions.categories,
      productSelectOptions.brands,
      unitAbbreviationById,
    );

  return (
    <div className="min-h-screen bg-muted/20 p-4 md:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <ProductOverview
          stats={stats}
          onExport={() => exportProducts(filteredProducts)}
        />

        <section className="rounded-xl border bg-card p-4 shadow-sm md:p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                aria-label="Search products"
                placeholder="Search by product, SKU, or barcode"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    // Exact codes open the scanned variant; text stays a filter.
                    const query = search.trim().toLowerCase();
                    const isExactCode = query
                      ? useProductStore
                          .getState()
                          .products.some((product) =>
                            product.variants.some(
                              (variant) =>
                                variant.barcode?.trim().toLowerCase() ===
                                  query ||
                                variant.sku.trim().toLowerCase() === query,
                            ),
                          )
                      : false;
                    if (isExactCode) {
                      event.preventDefault();
                      scanner.handleScan(search.trim());
                    }
                  }
                }}
                className="h-10 pl-9 pr-10"
              />
              {search && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear product search"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  onClick={() => setSearch("")}
                >
                  <X aria-hidden="true" />
                </Button>
              )}
            </div>
            <BarcodeScanFeedback
              state={scanner.state}
              className="min-w-0 flex-1"
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:w-auto">
              <select
                aria-label="Filter by product status"
                className="h-10 min-w-36 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as ProductStatusFilter)
                }
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="draft">Draft</option>
                <option value="inactive">Inactive</option>
              </select>
              <select
                aria-label="Filter by category"
                className="h-10 min-w-36 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
              >
                <option value="all">All categories</option>
                {productSelectOptions.categories.map((category) => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter by brand"
                className="h-10 min-w-36 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                value={brandFilter}
                onChange={(event) => setBrandFilter(event.target.value)}
              >
                <option value="all">All brands</option>
                {productSelectOptions.brands.map((brand) => (
                  <option key={brand.value} value={brand.value}>
                    {brand.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-medium text-muted-foreground">
              Stock:
            </span>
            {stockFilters.map((filter) => (
              <Button
                key={filter.value}
                type="button"
                variant={stockFilter === filter.value ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={stockFilter === filter.value}
                onClick={() => setStockFilter(filter.value)}
              >
                {filter.label}
                <span className="ml-1 rounded-full bg-background px-1.5 py-0.5 text-xs text-muted-foreground">
                  {stockCounts[filter.value]}
                </span>
              </Button>
            ))}
            {hasActiveFilters && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={clearFilters}
              >
                Clear filters
              </Button>
            )}
          </div>
        </section>

        {error && (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-destructive">
              Couldn’t load products: {error}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void getProducts()}
              disabled={loading}
            >
              Try again
            </Button>
          </div>
        )}

        <section className="rounded-xl border bg-card p-3 shadow-sm sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Showing{" "}
              <span className="font-medium text-foreground">
                {filteredProducts.length.toLocaleString()}
              </span>{" "}
              of {products.length.toLocaleString()} products
            </p>
          </div>
          <DataTable
            columns={columns}
            data={filteredProducts}
            loading={loading && products.length === 0}
            getRowCanExpand={(row) => row.original.hasVariants}
            onExportSelected={exportProducts}
          />
        </section>
      </div>
    </div>
  );
}

export default Products;
