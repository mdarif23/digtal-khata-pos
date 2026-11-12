import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Boxes,
  Package,
  Search,
  X,
} from "lucide-react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ProductType } from "@/features/products/product.schema";
import { ProductVariantType } from "@/features/products/product.schema";
import { StockAdjustmentInput } from "@/features/products/product.types";
import useProductStore from "@/features/products/useProductStore";
import { buildVariantOptionsLabel } from "@/lib/variantDisplay";
import type { LookupMatch } from "@/features/barcodes/barcode.api";
import { useBarcodeScanner } from "@/features/barcodes/scanning/useBarcodeScanner";
import { BarcodeScanFeedback } from "@/features/barcodes/scanning/BarcodeScanFeedback";
import { createCatalogLookup } from "@/features/barcodes/scanning/catalogLookup";

const reasons: { value: StockAdjustmentInput["reason"]; label: string }[] = [
  { value: "count_correction", label: "Stock count correction" },
  { value: "damaged", label: "Damaged goods" },
  { value: "expired", label: "Expired goods" },
  { value: "lost", label: "Lost or missing" },
  { value: "found", label: "Found stock" },
];

function getVariantLabel(variant: ProductVariantType) {
  const options = buildVariantOptionsLabel(variant.options);
  return [options, variant.sku].filter(Boolean).join(" · ") || "Default variant";
}

function getQuantity(variant: ProductVariantType) {
  return variant.quantity ?? 0;
}

function getRequestErrorMessage(error: unknown) {
  if (axios.isAxiosError<{ message?: string; error?: string }>(error)) {
    return (
      error.response?.data?.message ??
      error.response?.data?.error ??
      error.message
    );
  }
  return error instanceof Error ? error.message : "Could not adjust stock.";
}

export function StockAdjustment() {
  const products = useProductStore((state) => state.products);
  const loading = useProductStore((state) => state.loading);
  const loadError = useProductStore((state) => state.error);
  const getProducts = useProductStore((state) => state.getProducts);
  const adjustVariantStock = useProductStore(
    (state) => state.adjustVariantStock,
  );
  const [search, setSearch] = useState("");
  const [showProductResults, setShowProductResults] = useState(false);
  const [productId, setProductId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [newQuantity, setNewQuantity] = useState("");
  const [reason, setReason] =
    useState<StockAdjustmentInput["reason"]>("count_correction");
  const [batchNumber, setBatchNumber] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [serialEntry, setSerialEntry] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const newQuantityRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (products.length === 0 && !loading && !loadError) {
      getProducts();
    }
  }, [getProducts, loadError, loading, products.length]);

  useEffect(() => {
    function handleOutsidePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !searchContainerRef.current?.contains(event.target)
      ) {
        setShowProductResults(false);
      }
    }

    document.addEventListener("pointerdown", handleOutsidePointerDown);
    return () =>
      document.removeEventListener("pointerdown", handleOutsidePointerDown);
  }, []);

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return products;
    return products.filter(
      (product) =>
        product.name.toLocaleLowerCase().includes(query) ||
        product.variants.some((variant) =>
          [variant.sku, variant.barcode ?? ""]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query),
        ),
    );
  }, [products, search]);

  const selectedProduct: ProductType | undefined = products.find(
    (product) => String(product.id) === productId,
  );
  const selectedVariant: ProductVariantType | undefined =
    selectedProduct?.variants.find(
      (variant) => String(variant.id) === variantId,
    );
  const currentQuantity = selectedVariant ? getQuantity(selectedVariant) : 0;
  const targetQuantity = newQuantity === "" ? Number.NaN : Number(newQuantity);
  const change = Number.isFinite(targetQuantity)
    ? targetQuantity - currentQuantity
    : 0;
  const availableReasons =
    change > 0
      ? reasons.filter((item) =>
          ["count_correction", "found"].includes(item.value),
        )
      : change < 0
        ? reasons.filter((item) => item.value !== "found")
        : reasons;
  const selectedReason = availableReasons.some(
    (item) => item.value === reason,
  )
    ? reason
    : "count_correction";
  const serialNumbers = serialEntry
    .split(/[\n,]+/)
    .map((serial) => serial.trim())
    .filter(Boolean);
  const isSerialTracked = selectedProduct?.trackingType === "serial";
  const isBatchTracked = selectedProduct?.trackingType === "batch";
  const serialCountIsValid =
    !isSerialTracked ||
    change === 0 ||
    serialNumbers.length === Math.abs(change);
  const hasDuplicateSerials =
    new Set(serialNumbers).size !== serialNumbers.length;
  const hasValidTarget =
    newQuantity !== "" &&
    Number.isInteger(targetQuantity) &&
    targetQuantity >= 0;
  const batchIsRequired = isBatchTracked && change > 0;

  useEffect(() => {
    if (
      selectedProduct &&
      !selectedProduct.variants.some(
        (variant) => String(variant.id) === variantId,
      )
    ) {
      setVariantId(String(selectedProduct.variants[0]?.id ?? ""));
    }
  }, [selectedProduct, variantId]);

  function chooseProduct(value: string) {
    const product = products.find((item) => String(item.id) === value);
    setProductId(value);
    setVariantId(String(product?.variants[0]?.id ?? ""));
    setSearch(product?.name ?? "");
    setShowProductResults(false);
    setNewQuantity("");
    setSerialEntry("");
    setSubmitError(null);
    setSuccessMessage(null);
  }

  function clearSelectedProduct() {
    setProductId("");
    setVariantId("");
    setNewQuantity("");
    setBatchNumber("");
    setUnitCost("");
    setSerialEntry("");
    setSubmitError(null);
    setSuccessMessage(null);
  }

  function updateProductSearch(value: string) {
    setSearch(value);
    setShowProductResults(true);
    clearSelectedProduct();
  }

  function chooseVariant(value: string) {
    setVariantId(value);
    setNewQuantity("");
    setSerialEntry("");
    setSubmitError(null);
    setSuccessMessage(null);
  }

  function clearSearch() {
    updateProductSearch("");
    searchInputRef.current?.focus();
  }

  /**
   * Module scan handler — the scanner service only IDENTIFIES a barcode;
   * the adjustment rule (select the exact product+variant into the form)
   * lives here. Throwing surfaces the failure as an error scan.
   */
  async function handleResolved(match: LookupMatch) {
    const findRow = (catalog: ProductType[]) =>
      catalog
        .flatMap((product) =>
          product.variants.map((variant) => ({ product, variant })),
        )
        .find(({ variant }) => variant.id === match.variantId);

    let row = findRow(useProductStore.getState().products);
    if (!row) {
      // Scanned variant newer than the loaded catalog — refresh once.
      await useProductStore.getState().getProducts();
      row = findRow(useProductStore.getState().products);
    }
    if (!row) {
      throw new Error(`${match.productName} is not in the loaded catalog.`);
    }

    chooseProduct(String(row.product.id));
    setVariantId(String(row.variant.id));
    newQuantityRef.current?.focus();
  }

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

  async function submitAdjustment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !selectedProduct ||
      !selectedVariant ||
      selectedVariant.id === undefined ||
      !hasValidTarget
    ) {
      return;
    }

    if (serialCountIsValid === false) {
      const message = `Enter exactly ${Math.abs(change)} serial number${Math.abs(change) === 1 ? "" : "s"} for this adjustment.`;
      setSubmitError(message);
      toast.add({ type: "error", description: message, priority: "high" });
      return;
    }
    if (hasDuplicateSerials) {
      setSubmitError("Serial numbers must be unique.");
      toast.add({
        type: "error",
        description: "Serial numbers must be unique.",
        priority: "high",
      });
      return;
    }
    if (batchIsRequired && !batchNumber.trim()) {
      setSubmitError("Enter a batch number for the added stock.");
      toast.add({
        type: "error",
        description: "Enter a batch number for the added stock.",
        priority: "high",
      });
      return;
    }

    const data: StockAdjustmentInput = {
      newQuantity: targetQuantity,
      reason: selectedReason,
    };
    if (batchIsRequired) data.batchNumber = batchNumber.trim();
    if (unitCost !== "") data.unitCost = Number(unitCost);
    if (isSerialTracked && serialNumbers.length > 0) {
      data.serialNumbers = serialNumbers;
    }

    setSubmitting(true);
    setSubmitError(null);
    setSuccessMessage(null);
    try {
      const result = await adjustVariantStock(selectedVariant.id, data);
      setNewQuantity(String(result.quantity));
      setSerialEntry("");
      setBatchNumber("");
      setSuccessMessage(
        `Stock updated: ${result.previousQuantity} to ${result.quantity} units (${result.change > 0 ? "+" : ""}${result.change}).`,
      );
      toast.add({
        type: "success",
        description: `Stock updated successfully. Quantity changed from ${result.previousQuantity} to ${result.quantity}.`,
        priority: "high",
      });
    } catch (error) {
      const message = getRequestErrorMessage(error);
      setSubmitError(message);
      toast.add({ type: "error", description: message, priority: "high" });
    } finally {
      setSubmitting(false);
    }
  }

  const totalUnits = products.reduce(
    (total, product) =>
      total +
      product.variants.reduce(
        (variantTotal, variant) => variantTotal + getQuantity(variant),
        0,
      ),
    0,
  );
  const lowStockCount = products.reduce(
    (total, product) =>
      total +
      product.variants.filter(
        (variant) =>
          getQuantity(variant) <= (variant.alertQuantity ?? 0),
      ).length,
    0,
  );

  if (loading && products.length === 0) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-8">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="h-72 animate-pulse rounded-xl bg-muted" />
      </main>
    );
  }

  if (loadError && products.length === 0) {
    return (
      <main className="mx-auto w-full max-w-6xl p-4 md:p-8">
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
          <h1 className="text-xl font-semibold">Could not load products</h1>
          <p className="mt-2 text-sm text-muted-foreground">{loadError}</p>
          <Button className="mt-4" onClick={getProducts}>
            Try again
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-8">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-primary">Inventory</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Stock adjustment
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Correct on-hand quantities for products and individual variants.
            Each change is recorded in inventory movement history.
          </p>
        </div>
        <div className="flex gap-3">
          <div className="rounded-xl border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">Tracked variants</p>
            <p className="mt-1 text-xl font-semibold">
              {products.reduce(
                (count, product) => count + product.variants.length,
                0,
              )}
            </p>
          </div>
          <div className="rounded-xl border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">Units on hand</p>
            <p className="mt-1 text-xl font-semibold">{totalUnits}</p>
          </div>
          <div className="rounded-xl border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">At/below alert</p>
            <p className="mt-1 flex items-center gap-1 text-xl font-semibold">
              {lowStockCount > 0 && (
                <AlertTriangle className="size-4 text-amber-500" />
              )}
              {lowStockCount}
            </p>
          </div>
        </div>
      </header>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.9fr)]">
        <div className="space-y-5 rounded-xl border bg-card p-5 shadow-sm md:p-7">
          <div>
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ArrowLeftRight className="size-5" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">Adjust inventory</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Select a variant and enter the verified quantity currently on
              hand.
            </p>
          </div>

          <form className="space-y-5" onSubmit={submitAdjustment}>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="product-search">
                Find product
              </label>
              <div ref={searchContainerRef} className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  id="product-search"
                  className={search ? "pl-9 pr-9" : "pl-9"}
                  placeholder="Search by product, SKU, or barcode"
                  value={search}
                  onFocus={() => setShowProductResults(true)}
                  onChange={(event) => {
                    updateProductSearch(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setShowProductResults(false);
                    if (event.key === "Enter") {
                      // Exact codes scan directly; anything else keeps the
                      // as-you-type result list.
                      const query = search.trim().toLowerCase();
                      const isExactCode = query
                        ? products.some((product) =>
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
                  autoComplete="off"
                  aria-expanded={showProductResults}
                  aria-controls="product-search-results"
                />
                {search && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                    aria-label="Clear product search"
                    onClick={clearSearch}
                  >
                    <X className="size-4" />
                  </Button>
                )}
                {showProductResults && (
                  <div
                    id="product-search-results"
                    className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
                  >
                    {filteredProducts.length > 0 ? (
                      filteredProducts.map((product) => (
                        <button
                          key={product.id}
                          type="button"
                          className="flex w-full items-center justify-between gap-3 rounded-sm px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
                          onClick={() => chooseProduct(String(product.id))}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">
                              {product.name}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {product.variants.length}{" "}
                              {product.variants.length === 1
                                ? "variant"
                                : "variants"}
                              {product.variants[0]?.sku
                                ? ` · ${product.variants[0].sku}`
                                : ""}
                            </span>
                          </span>
                          {String(product.id) === productId && (
                            <span className="shrink-0 text-xs text-primary">
                              Selected
                            </span>
                          )}
                        </button>
                      ))
                    ) : (
                      <p className="px-3 py-2 text-sm text-muted-foreground">
                        {loading
                          ? "Loading products…"
                          : products.length === 0
                            ? "No products are available."
                            : "No matching products found."}
                      </p>
                    )}
                  </div>
                )}
              </div>
              <BarcodeScanFeedback state={scanner.state} className="pt-1" />
            </div>

            <div className="grid gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="variant">
                  Variant
                </label>
                <select
                  id="variant"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  value={variantId}
                  disabled={!selectedProduct?.variants.length}
                  onChange={(event) => chooseVariant(event.target.value)}
                >
                  {!selectedProduct?.variants.length && (
                    <option value="">No variants available</option>
                  )}
                  {selectedProduct?.variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {getVariantLabel(variant)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {selectedVariant && (
              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-background">
                    <Package className="size-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {selectedProduct?.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {getVariantLabel(selectedVariant)}
                    </p>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs text-muted-foreground">Available</p>
                  <p className="text-lg font-semibold">{currentQuantity}</p>
                </div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label
                  className="text-sm font-medium"
                  htmlFor="new-quantity"
                >
                  Actual quantity on hand
                </label>
                <Input
                  id="new-quantity"
                  ref={newQuantityRef}
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  placeholder="Enter counted stock"
                  value={newQuantity}
                  onChange={(event) => {
                    setNewQuantity(event.target.value);
                    setSubmitError(null);
                    setSuccessMessage(null);
                  }}
                  disabled={!selectedVariant}
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="reason">
                  Reason
                </label>
                <select
                  id="reason"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={selectedReason}
                  onChange={(event) => {
                    setReason(
                      event.target.value as StockAdjustmentInput["reason"],
                    );
                    setSubmitError(null);
                    setSuccessMessage(null);
                  }}
                >
                  {availableReasons.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {batchIsRequired && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="batch-number">
                    New batch number
                  </label>
                  <Input
                    id="batch-number"
                    value={batchNumber}
                    onChange={(event) => setBatchNumber(event.target.value)}
                    placeholder="Enter batch or lot number"
                    maxLength={100}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="unit-cost">
                    Unit cost (optional)
                  </label>
                  <Input
                    id="unit-cost"
                    type="number"
                    min="0"
                    step="0.01"
                    value={unitCost}
                    onChange={(event) => setUnitCost(event.target.value)}
                    placeholder="Uses current average cost if blank"
                  />
                </div>
              </div>
            )}

            {change > 0 && !batchIsRequired && (
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="unit-cost">
                  Unit cost (optional)
                </label>
                <Input
                  id="unit-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  value={unitCost}
                  onChange={(event) => setUnitCost(event.target.value)}
                  placeholder="Uses current average cost if blank"
                />
              </div>
            )}

            {isSerialTracked && change !== 0 && (
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="serial-numbers">
                  Serial numbers to {change > 0 ? "add" : "remove"}
                </label>
                <textarea
                  id="serial-numbers"
                  className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="Enter one serial number per line"
                  value={serialEntry}
                  onChange={(event) => setSerialEntry(event.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Exactly {Math.abs(change)} unique serial number
                  {Math.abs(change) === 1 ? "" : "s"} required.
                </p>
                {hasDuplicateSerials && (
                  <p className="text-xs text-destructive">
                    Remove duplicate serial numbers before saving.
                  </p>
                )}
                {!serialCountIsValid && !hasDuplicateSerials && (
                  <p className="text-xs text-destructive">
                    Enter {Math.abs(change)} serial number
                    {Math.abs(change) === 1 ? "" : "s"} to match the stock change.
                  </p>
                )}
              </div>
            )}

            {hasValidTarget && (
              <div
                className={`flex items-center justify-between rounded-lg border p-3 ${
                  change === 0
                    ? "bg-muted/40"
                    : change > 0
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
                      : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
                }`}
              >
                <span className="text-sm font-medium">Stock change</span>
                <span className="flex items-center gap-1 text-sm font-semibold">
                  {change > 0 ? (
                    <ArrowUp className="size-4" />
                  ) : change < 0 ? (
                    <ArrowDown className="size-4" />
                  ) : null}
                  {change > 0 ? "+" : ""}
                  {change} units
                </span>
              </div>
            )}

            {submitError && (
              <p role="alert" className="text-sm text-destructive">
                {submitError}
              </p>
            )}
            {successMessage && (
              <p role="status" className="text-sm text-emerald-700">
                {successMessage}
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={
                submitting ||
                !selectedVariant ||
                !hasValidTarget ||
                change === 0 ||
                (batchIsRequired && !batchNumber.trim()) ||
                !serialCountIsValid ||
                hasDuplicateSerials
              }
            >
              <Boxes className="size-4" />
              {submitting ? "Saving adjustment…" : "Save stock adjustment"}
            </Button>
          </form>
        </div>

        <aside className="space-y-5">
          <div className="rounded-xl border bg-card p-5 shadow-sm md:p-6">
            <h2 className="font-semibold">How it works</h2>
            <ol className="mt-4 space-y-4 text-sm">
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  1
                </span>
                <span className="text-muted-foreground">
                  Choose the product and specific variant you counted.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  2
                </span>
                <span className="text-muted-foreground">
                  Enter the actual count. The difference is calculated for you.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  3
                </span>
                <span className="text-muted-foreground">
                  Choose why stock changed and save to update inventory.
                </span>
              </li>
            </ol>
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-5 dark:border-amber-900 dark:bg-amber-950/20">
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
              <div>
                <h2 className="text-sm font-semibold">Stock control</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Adjustments cannot reduce stock below zero. Batch quantities
                  are reconciled in FIFO order. Serial-tracked products require
                  the exact serials being added or removed.
                </p>
              </div>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
