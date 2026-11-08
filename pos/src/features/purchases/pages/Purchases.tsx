import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  ArrowRight,
  Barcode,
  CalendarDays,
  Package,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProductCard } from "@/components/common/ProductCard";
import { ShowVariants } from "@/components/common/ShowVariants";
import { useQueryClient } from "@tanstack/react-query";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { PurchaseCostSummary } from "../components/purchases/PurchaseCostSummary";
import { toast } from "@/components/ui/toast";
import {
  ProductType,
  ProductVariantType,
} from "@/features/products/product.schema";
import useProductStore from "@/features/products/useProductStore";
import { getVariantPurchaseCost } from "@/features/products/utils/getVariantPurchaseCost";
import type { PurchaseCart } from "../purchase.types";
import { PurchaseTable } from "../components/purchases/PurchaseTable";
import { usePurchasesStore } from "../usePurchaseStore";
import { formatCurrency } from "@/features/purchases/utils/formatCurrency";
import {
  type LookupMatch,
} from "@/features/barcodes/barcode.api";
import { useBarcodeScanner } from "@/features/barcodes/scanning/useBarcodeScanner";
import { useScanFailureToast } from "@/features/barcodes/scanning/useScanFailureToast";
import { BarcodeScanFeedback } from "@/features/barcodes/scanning/BarcodeScanFeedback";
import { createCatalogLookup } from "@/features/barcodes/scanning/catalogLookup";

const roundCurrency = (value: number | null | undefined) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
};

/** Only active products with active variants are purchasable. */
function toActiveProducts(catalog: ProductType[]) {
  return catalog
    .filter((product) => product.status === "active")
    .map((product) => ({
      ...product,
      variants: product.variants.filter(
        (variant) => variant.status === "active",
      ),
    }))
    .filter((product) => product.variants.length > 0);
}

export function PurchasesOrder() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchProducts, setSearchProducts] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [purchaseSource, setPurchaseSource] = useState<"supplier" | "walk_in">(
    "supplier",
  );
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [discount, setDiscount] = useState(0);
  const [tax, setTax] = useState(0);
  const [shippingCost, setShippingCost] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [purchasesCart, setPurchasesCart] = useState<PurchaseCart[]>([]);

  const products = useProductStore((state) => state.products);
  const suppliers = useProductStore(
    (state) => state.productSelectOptions.suppliers,
  );
  const productsLoading = useProductStore((state) => state.loading);
  const productError = useProductStore((state) => state.error);
  const createPurchase = usePurchasesStore((state) => state.createPurchase);
  const getPurchases = usePurchasesStore((state) => state.getPurchases);

  const activeProducts = useMemo(() => toActiveProducts(products), [products]);
  const filteredProducts = useMemo(() => {
    const query = searchProducts.trim().toLowerCase();
    if (!query) return activeProducts;
    return activeProducts.filter((product) => {
      const productMatches = product.name.toLowerCase().includes(query);
      const variantMatches = product.variants.some(
        (variant) =>
          variant.sku.toLowerCase().includes(query) ||
          variant.barcode?.toLowerCase().includes(query),
      );
      return productMatches || variantMatches;
    });
  }, [activeProducts, searchProducts]);

  const itemSubtotal = purchasesCart.reduce(
    (sum, item) =>
      sum +
      roundCurrency(
        item.purchaseQty * item.purchasePrice -
          item.purchaseDiscount +
          item.purchaseTax,
      ),
    0,
  );
  const [discountBasis, setDiscountBasis] = useState<
    "fixed" | "percentage"
  >("fixed");
  const appliedDiscount =
    discountBasis === "percentage"
      ? Math.min(
          roundCurrency((itemSubtotal * discount) / 100),
          Math.max(itemSubtotal, 0),
        )
      : Math.min(discount, Math.max(itemSubtotal, 0));
  const grandTotal = Math.max(
    0,
    itemSubtotal - appliedDiscount + tax + shippingCost,
  );
  const itemCount = purchasesCart.reduce(
    (sum, item) => sum + item.purchaseQty,
    0,
  );

  const handleAddPurchase = (product: ProductType) => {
    const variant = product.variants[0];
    const productId = product.id;
    const variantId = variant?.id;
    if (productId === undefined || variantId === undefined || !variant) return;

    setPurchasesCart((current) => {
      const existing = current.find(
        (item) => item.variants[0]?.id === variantId,
      );
      if (existing) {
        return current.map((item) =>
          item.variants[0]?.id === variantId
            ? { ...item, purchaseQty: item.purchaseQty + 1 }
            : item,
        );
      }

      return [
        ...current,
        {
          ...product,
          id: productId,
          variants: [{ ...variant, id: variantId }],
          purchaseQty: 1,
          purchasePrice: roundCurrency(getVariantPurchaseCost(variant)),
          purchaseDiscount: 0,
          purchaseTax: 0,
        },
      ];
    });
  };

  const handleUpdatePurchase = (
    variantId: number,
    field: "purchaseQty" | "purchasePrice" | "purchaseDiscount" | "purchaseTax",
    value: number,
  ) => {
    setPurchasesCart((current) =>
      current.map((item) => {
        if (item.variants[0]?.id !== variantId) return item;
        const quantity =
          field === "purchaseQty"
            ? Math.max(0.001, Math.round(value * 1000) / 1000)
            : item.purchaseQty;
        const price =
          field === "purchasePrice"
            ? roundCurrency(Math.max(0, value))
            : item.purchasePrice;
        const purchaseDiscount = Math.min(
          field === "purchaseDiscount"
            ? roundCurrency(Math.max(0, value))
            : item.purchaseDiscount,
          quantity * price,
        );
        return {
          ...item,
          [field]:
            field === "purchaseQty"
              ? quantity
              : field === "purchasePrice"
                ? price
                : field === "purchaseDiscount"
                  ? purchaseDiscount
                  : roundCurrency(Math.max(0, value)),
        };
      }),
    );
  };

  /**
   * Module scan handler — the scanner service only IDENTIFIES a barcode;
   * the purchase rules (active status, catalog row, cost default, add or
   * increment) live here. Throwing surfaces the failure as an error scan.
   */
  const handleResolved = useCallback(
    async (match: LookupMatch) => {
      if (
        (match.productStatus && match.productStatus !== "active") ||
        (match.variantStatus && match.variantStatus !== "active")
      ) {
        throw new Error(`${match.productName} is not available for purchase.`);
      }

      const findRow = (catalog: ProductType[]) =>
        catalog
          .flatMap((product) =>
            product.variants.map((variant) => ({ product, variant })),
          )
          .find(({ variant }) => variant.id === match.variantId);

      let row = findRow(toActiveProducts(useProductStore.getState().products));
      if (!row) {
        // Scanned variant newer than the loaded catalog — refresh once.
        await useProductStore.getState().getProducts();
        row = findRow(toActiveProducts(useProductStore.getState().products));
      }
      if (!row) {
        throw new Error(`${match.productName} is not in the loaded catalog.`);
      }

      handleAddPurchase({ ...row.product, variants: [row.variant] });
      setSearchProducts("");
    },
    // handleAddPurchase only touches setPurchasesCart and cost helpers.
    [],
  );

  // Local-first identification over the purchasable catalog; everything
  // else resolves against the server (alias barcodes, newer codes).
  const lookup = useCallback(
    createCatalogLookup(
      () => toActiveProducts(useProductStore.getState().products),
    ),
    [],
  );

  const scanner = useBarcodeScanner({
    capture: "window",
    lookup,
    onResolve: handleResolved,
  });

  useScanFailureToast(scanner.state);

  // Search-box Enter: exact product names keep the add-default-variant
  // behavior; everything else goes through the scanner.
  const handleSearchEnter = (text: string) => {
    const query = text.trim().toLowerCase();
    if (!query) return;
    const product = activeProducts.find(
      (item) => item.name.trim().toLowerCase() === query,
    );
    if (product) {
      const variant =
        product.variants.find((item) => item.isDefault) ?? product.variants[0];
      if (variant) {
        handleAddPurchase({ ...product, variants: [variant] });
        setSearchProducts("");
      }
      return;
    }
    scanner.handleScan(text);
  };

  const handleCreatePurchaseOrder = async () => {
    if (!purchasesCart.length || !purchaseDate || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await createEntityPromiseToast({
        data: {
          items: purchasesCart.map((item) => ({
            variantId: item.variants[0].id,
            quantity: item.purchaseQty,
            purchasePrice: item.purchasePrice,
            discount: item.purchaseDiscount,
            tax: item.purchaseTax,
          })),
          supplierId: purchaseSource === "supplier" ? supplierId : null,
          purchaseDate,
          notes,
          // Percentage basis sends the RAW percentage — the backend
          // resolves it authoritatively (Phase 2 service).
          discount:
            discountBasis === "percentage" ? discount : appliedDiscount,
          discountBasis,
          tax,
          shippingCost,
        },
        apiCall: createPurchase,
        entityName: "Purchase order",
        getSuccessMessage: (response) =>
          `Purchase order ${response.data.purchaseOrderNumber} created`,
      });
      await getPurchases();
      // The list is TanStack-cached (Phase 6) — refresh it so the new
      // order is there when the user lands back on it.
      await queryClient.invalidateQueries({ queryKey: ["purchases", "list"] });
      navigate("/purchases-list");
    } finally {
      setIsSubmitting(false);
    }
  };

  const getDefaultVariant = (product: ProductType): ProductVariantType | null =>
    product.variants.find((variant) => variant.isDefault) ??
    product.variants[0] ??
    null;

  return (
    <div className="min-h-[calc(100vh-1rem)] bg-muted/30 p-4 md:p-6">
      <div className="mx-auto max-w-[1600px] space-y-5">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Inventory / Purchases
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              New purchase order
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Add products, confirm supplier costs, and prepare goods for
              receiving.
            </p>
          </div>
          <Button variant="outline" render={<Link to="/purchases-list" />}>
            View purchase orders <ArrowRight />
          </Button>
        </header>

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(420px,0.9fr)]">
          <section className="overflow-hidden rounded-xl border bg-background shadow-sm">
            <div className="border-b p-4 md:p-5">
              <div className="flex items-center gap-2">
                <div className="rounded-lg bg-primary/10 p-2 text-primary">
                  <Package className="size-5" />
                </div>
                <div>
                  <h2 className="font-semibold">Product catalog</h2>
                  <p className="text-sm text-muted-foreground">
                    Search by product, SKU, or scan a barcode.
                  </p>
                </div>
              </div>
              <div className="relative mt-4">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchProducts}
                  onChange={(event) => setSearchProducts(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleSearchEnter(searchProducts);
                    }
                  }}
                  className="h-11 pl-9 pr-10"
                  placeholder="Search products or scan barcode..."
                  aria-label="Search products or scan barcode"
                />
                <Barcode className="absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>
              <BarcodeScanFeedback state={scanner.state} className="mt-2" />
            </div>
            <div className="max-h-[calc(100vh-18rem)] min-h-72 overflow-y-auto p-4 md:p-5">
              {productError && (
                <p
                  role="alert"
                  className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
                >
                  {productError}
                </p>
              )}
              {productsLoading && products.length === 0 ? (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {Array.from({ length: 6 }, (_, index) => (
                    <div
                      key={index}
                      className="aspect-[0.9] animate-pulse rounded-xl bg-muted"
                    />
                  ))}
                </div>
              ) : filteredProducts.length ? (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {filteredProducts.map((product) => {
                    const defaultVariant = getDefaultVariant(product);
                    if (!defaultVariant) return null;
                    return product.hasVariants ? (
                      <ShowVariants
                        key={product.id}
                        type="purchase"
                        product={product}
                        handleAdd={handleAddPurchase}
                        defaultVariant={defaultVariant}
                      />
                    ) : (
                      <ProductCard
                        key={product.id}
                        type="purchase"
                        product={product}
                        handleAdd={handleAddPurchase}
                        defaultVariant={defaultVariant}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="flex min-h-64 flex-col items-center justify-center text-center">
                  <Package className="size-10 text-muted-foreground/50" />
                  <p className="mt-3 font-medium">No products found</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Try another product name, SKU, or barcode.
                  </p>
                </div>
              )}
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border bg-background shadow-sm">
            <div className="flex items-center justify-between border-b p-4 md:p-5">
              <div className="flex items-center gap-2">
                <div className="rounded-lg bg-primary/10 p-2 text-primary">
                  <ShoppingCart className="size-5" />
                </div>
                <div>
                  <h2 className="font-semibold">Order details</h2>
                  <p className="text-sm text-muted-foreground">
                    {purchasesCart.length} lines · {formatCurrency(itemCount)}{" "}
                    units
                  </p>
                </div>
              </div>
              {purchasesCart.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPurchasesCart([])}
                >
                  <Trash2 /> Clear
                </Button>
              )}
            </div>

            <div className="space-y-5 p-4 md:p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1.5 text-sm font-medium">
                  <span className="flex items-center gap-2">
                    <CalendarDays className="size-4 text-muted-foreground" />
                    Purchase date
                  </span>
                  <Input
                    required
                    type="date"
                    value={purchaseDate}
                    onChange={(event) => setPurchaseDate(event.target.value)}
                  />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  <span>Purchase source</span>
                  <select
                    value={purchaseSource}
                    onChange={(event) =>
                      setPurchaseSource(
                        event.target.value as "supplier" | "walk_in",
                      )
                    }
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="supplier">Supplier</option>
                    <option value="walk_in">Walk-in / own purchase</option>
                  </select>
                </label>
              </div>
              {purchaseSource === "supplier" && (
                <label className="block space-y-1.5 text-sm font-medium">
                  Supplier <span className="text-destructive">*</span>
                  <select
                    required
                    value={supplierId ?? ""}
                    onChange={(event) =>
                      setSupplierId(
                        event.target.value ? Number(event.target.value) : null,
                      )
                    }
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Select a supplier</option>
                    {suppliers.map((supplier) => (
                      <option key={supplier.value} value={supplier.value}>
                        {supplier.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="overflow-hidden rounded-lg border">
                {purchasesCart.length ? (
                  <PurchaseTable
                    purchasesCart={purchasesCart}
                    onUpdateItem={handleUpdatePurchase}
                    onRemoveItem={(variantId) =>
                      setPurchasesCart((current) =>
                        current.filter(
                          (item) => item.variants[0]?.id !== variantId,
                        ),
                      )
                    }
                  />
                ) : (
                  <div className="flex min-h-44 flex-col items-center justify-center px-6 text-center">
                    <ShoppingCart className="size-9 text-muted-foreground/50" />
                    <p className="mt-3 font-medium">Your order is empty</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Select a product to add it to this purchase.
                    </p>
                  </div>
                )}
              </div>

              <label className="block space-y-1.5 text-sm font-medium">
                Notes
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={300}
                  rows={2}
                  placeholder="Delivery instructions, supplier reference, or other notes"
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>

              <div className="space-y-3 rounded-lg bg-muted/50 p-4">
                <p className="font-semibold">Cost summary</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Order discount{" "}
                    <span className="inline-flex overflow-hidden rounded-md border border-input align-middle">
                      <button
                        type="button"
                        onClick={() => {
                          setDiscountBasis("fixed");
                          if (discount > 100) setDiscount(roundCurrency(itemSubtotal));
                        }}
                        className={`px-2 py-0.5 text-xs ${
                          discountBasis === "fixed"
                            ? "bg-primary text-primary-foreground"
                            : "bg-background text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        ৳
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiscountBasis("percentage")}
                        className={`px-2 py-0.5 text-xs ${
                          discountBasis === "percentage"
                            ? "bg-primary text-primary-foreground"
                            : "bg-background text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        %
                      </button>
                    </span>
                    <Input
                      min={0}
                      max={
                        discountBasis === "percentage"
                          ? 100
                          : Math.max(itemSubtotal, 0)
                      }
                      step="0.01"
                      type="number"
                      value={discount}
                      onChange={(event) => {
                        const raw = Math.max(0, Number(event.target.value) || 0);
                        setDiscount(
                          discountBasis === "percentage"
                            ? Math.min(raw, 100)
                            : Math.min(
                                roundCurrency(raw),
                                Math.max(itemSubtotal, 0),
                              ),
                        );
                      }}
                      className="mt-1 h-9 bg-background text-sm text-foreground"
                    />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Additional tax
                    <Input
                      min={0}
                      step="0.01"
                      type="number"
                      value={tax}
                      onChange={(event) =>
                        setTax(
                          roundCurrency(
                            Math.max(0, Number(event.target.value) || 0),
                          ),
                        )
                      }
                      className="mt-1 h-9 bg-background text-sm text-foreground"
                    />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Supplier shipping
                    <Input
                      min={0}
                      step="0.01"
                      type="number"
                      value={shippingCost}
                      onChange={(event) =>
                        setShippingCost(
                          roundCurrency(
                            Math.max(0, Number(event.target.value) || 0),
                          ),
                        )
                      }
                      className="mt-1 h-9 bg-background text-sm text-foreground"
                    />
                  </label>
                </div>
                <PurchaseCostSummary
                  itemsSubtotal={itemSubtotal}
                  orderDiscount={appliedDiscount}
                  discountSuffix={
                    discountBasis === "percentage" ? `(${discount}%)` : undefined
                  }
                  orderTax={tax}
                  supplierShipping={shippingCost}
                  grandTotal={grandTotal}
                />
              </div>

              {purchaseSource === "supplier" && !supplierId && (
                <p className="text-sm text-muted-foreground">
                  Select a supplier to create this order.
                </p>
              )}
              <Button
                type="button"
                className="h-11 w-full"
                onClick={handleCreatePurchaseOrder}
                disabled={
                  isSubmitting ||
                  !purchaseDate ||
                  purchasesCart.length === 0 ||
                  (purchaseSource === "supplier" && !supplierId)
                }
              >
                <Plus />
                {isSubmitting ? "Creating order..." : "Create purchase order"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Inventory is updated when items are received, not when the order
                is created.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
