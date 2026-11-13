import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PackageSearch } from "lucide-react";
import { buildVariantName } from "@/lib/variantDisplay";
import { ProductHeader } from "./ProductHeader";
import { useCartStore } from "@/features/pos/stores/useCartStore";
import useProductStore from "@/features/products/useProductStore";
import { ProductCard } from "../../../../components/common/ProductCard";
import { ShowVariants } from "../../../../components/common/ShowVariants";
import { SerialPickerDialog } from "./SerialPickerDialog";
import {
  ProductType,
  ProductVariantType,
} from "@/features/products/product.schema";
import { toast } from "@/components/ui/toast";
import { checkAllowance } from "@/features/pos/offline/allocations.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LookupMatch } from "@/features/barcodes/barcode.api";
import {
  parseEmbeddedBarcode,
  DEFAULT_EMBEDDED_CONFIG,
} from "@/features/barcodes/scanning/embeddedBarcode";
import { useBarcodeScanner } from "@/features/barcodes/scanning/useBarcodeScanner";
import { BarcodeScanFeedback } from "@/features/barcodes/scanning/BarcodeScanFeedback";
import {
  createCatalogLookup,
  getScannedUnit,
} from "@/features/barcodes/scanning/catalogLookup";
import {
  resolveDefaultSaleUnit,
} from "@/features/pos/hooks/useSellUnits";

type ActiveSerialProduct = {
  product: ProductType;
  variantId: number | undefined;
};

const EMPTY_SERIALS: string[] = [];

export function ProductList({
  scannerEnabled = true,
}: {
  scannerEnabled?: boolean;
}) {
  const { addToCart } = useCartStore();
  const { products, productSelectOptions } = useProductStore();
  const [searchProducts, setSearchProducts] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [activeSerialProduct, setActiveSerialProduct] =
    useState<ActiveSerialProduct | null>(null);

  const filteredProducts = useMemo(() => {
    const query = searchProducts.trim().toLowerCase();

    return products.filter(
      (product) => {
        const matchesQuery =
          !query ||
          product.name.toLowerCase().includes(query) ||
          product.variants.some(
            (variant) =>
              variant.sku.toLowerCase().includes(query) ||
              variant.barcode?.toLowerCase().includes(query),
          );
        const matchesCategory =
          selectedCategory === "all" ||
          product.categoryId === Number(selectedCategory);

        return matchesQuery && matchesCategory;
      },
    );
  }, [products, searchProducts, selectedCategory]);

  const activeCategories = productSelectOptions.categories.filter(
    (category) => category.status === "active",
  );

  /**
   * Grid click → default sale unit. A plain click adds the server's
   * default sale unit (often the base unit — identical to the old
   * behavior); sell-units are fetched lazily here and cached. When they
   * cannot be fetched (offline), the base-unit line is added exactly as
   * before packaging-unit selling existed.
   */
  const handleAdd = useCallback(
    async (product: ProductType) => {
      const variant = product.variants[0];
      if (!variant || variant.id === undefined) {
        addToCart(product);
        return;
      }
      const unit = await resolveDefaultSaleUnit(variant.id);
      addToCart(product, unit ?? undefined);
    },
    [addToCart],
  );

  /**
   * Module scan handler — the scanner service only IDENTIFIES a barcode;
   * every sales business rule (catalog row, stock gate, serial tracking)
   * lives here. Throwing surfaces the failure as an error scan.
   */
  const handleResolved = useCallback(
    async (match: LookupMatch) => {
      const findRow = (catalog: ProductType[]) =>
        catalog
          .flatMap((product) =>
            product.variants.map((variant) => ({ product, variant })),
          )
          .find(({ variant }) => variant.id === match.variantId);

      // The cart entry is built from the full local catalog row; refresh
      // it when the scanned variant is newer than the loaded catalog.
      let row = findRow(useProductStore.getState().products);
      if (!row) {
        await useProductStore.getState().getProducts();
        row = findRow(useProductStore.getState().products);
      }
      if (!row) {
        throw new Error(`${match.productName} is not in the loaded catalog.`);
      }

      const { product, variant } = row;
      // A match with a sell unit means ONE PACKAGE of that unit (1 Box);
      // its barcode is not the piece barcode.
      const scannedUnit = getScannedUnit(match);
      const baseUnitsPerScan = scannedUnit?.conversionFactor ?? 1;
      // Phase 4 (Feature 10-A): embedded WEIGHT — the parsed value is the
      // quantity in base units for weight-sold variants.
      const weightQuantity =
        scannedUnit == null &&
        (variant as { soldByWeight?: boolean }).soldByWeight === true
          ? (embeddedWeightRef.current ?? 0)
          : null;
      if (weightQuantity !== null && weightQuantity > 0) {
        addToCart(
          {
            ...product,
            name: buildVariantName(product.name, variant.options),
            variants: [variant],
          },
          undefined,
          weightQuantity,
        );
        embeddedWeightRef.current = null;
        setSearchProducts("");
        toast.add({
          description: `${buildVariantName(product.name, variant.options)} × ${weightQuantity} added.`,
        });
        return;
      }
      if (variant.quantity < baseUnitsPerScan) {
        throw new Error(`${product.name} is out of stock.`);
      }

      if (product.trackingType === "serial") {
        setSearchProducts("");
        setActiveSerialProduct({ product, variantId: variant.id });
        return;
      }

      const variantName = buildVariantName(product.name, variant.options);
      // Offline allowance gate (Phase 3): allocated products can only take
      // what THIS terminal was granted; blocked products never sell offline.
      // The server re-checks and flags overages at sync time regardless.
      if (!navigator.onLine) {
        const check = await checkAllowance(variant.id, baseUnitsPerScan);
        if (!check?.allowed) {
          toast.add({ type: "error", description: check.reason, priority: "high" });
          return;
        }
      }
      addToCart(
        { ...product, name: variantName, variants: [variant] },
        scannedUnit
          ? {
              uomConversionId: scannedUnit.conversionId,
              unitName: scannedUnit.unitName,
              unitAbbreviation: scannedUnit.unitAbbreviation,
              conversionFactor: scannedUnit.conversionFactor,
              salePrice: scannedUnit.salePrice,
            }
          : undefined,
      );
      setSearchProducts("");
      toast.add({ description: `${variantName} added to cart.` });
    },
    [addToCart],
  );

  // Local-first identification: loaded catalog matches never hit the
  // network; everything else resolves against the server (alias barcodes,
  // codes newer than the catalog).
  const lookup = useCallback(
    createCatalogLookup(() => useProductStore.getState().products),
    [],
  );

  // Phase 4 (Feature 10-B): embedded price/weight barcodes — parse first,
  // fall back to normal identification when the shape doesn't match. The
  // parsed weight travels to handleResolved via a side channel (lookup
  // responses are typed without it).
  const embeddedWeightRef = useRef<number | null>(null);
  const resolveScan = useCallback(
    async (barcode: string) => {
      const embedded = parseEmbeddedBarcode(barcode, DEFAULT_EMBEDDED_CONFIG);
      if (embedded) {
        const match = await lookup(embedded.lookupBarcode);
        embeddedWeightRef.current = embedded.value;
        return match;
      }
      embeddedWeightRef.current = null;
      return lookup(barcode);
    },
    [lookup],
  );

  const scanner = useBarcodeScanner({
    capture: "window",
    enabled: scannerEnabled,
    lookup: resolveScan,
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
        description: "No product matches that name, SKU, or barcode.",
      });
    } else if (event.status === "ambiguous") {
      toast.add({
        type: "error",
        description: event.detail ?? "That barcode matches more than one product.",
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

  // Search-box Enter: exact codes go straight to the scanner; product-name
  // searches stay a filter (typing search + Enter must not error-toast when
  // the as-you-type list already shows results).
  const handleSearchEnter = (text: string) => {
    const query = text.trim().toLowerCase();
    if (!query) return;
    const isExactCode = products.some((product) =>
      product.variants.some(
        (variant) =>
          variant.barcode?.trim().toLowerCase() === query ||
          variant.sku.trim().toLowerCase() === query,
      ),
    );
    if (isExactCode) {
      scanner.handleScan(text);
      return;
    }
    const nameHits = products.some((product) =>
      product.name.toLowerCase().includes(query),
    );
    if (nameHits && filteredProducts.length > 0) return;
    scanner.handleScan(text);
  };

  const openSerialPicker = (
    product: ProductType,
    variant: ProductVariantType,
  ) => {
    setActiveSerialProduct({ product, variantId: variant.id });
  };

  const activeSerialVariantId = activeSerialProduct?.variantId;
  const selectedSerials =
    useCartStore(
    (state) =>
      state.cart.find((item) =>
        item.variants.some((variant) => variant.id === activeSerialVariantId),
      )?.serialNumbers,
    ) ?? EMPTY_SERIALS;

  return (
    <>
      <ProductHeader
        searchProducts={searchProducts}
        setSearchProducts={setSearchProducts}
        onScan={handleSearchEnter}
      />
      <BarcodeScanFeedback
        state={scanner.state}
        className="shrink-0 px-4 pt-2 sm:px-5"
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Products
          </h2>
          <div className="flex items-center gap-2">
            <Select
              value={selectedCategory}
              onValueChange={(value) => {
                if (value) setSelectedCategory(value);
              }}
            >
              <SelectTrigger
                className="h-8 w-[min(48vw,12rem)] bg-background text-xs sm:w-48"
                aria-label="Filter products by category"
              >
                <SelectValue placeholder="All categories">
                  {selectedCategory === "all"
                    ? "All categories"
                    : activeCategories.find(
                        (category) =>
                          category.value === Number(selectedCategory),
                      )?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {activeCategories.map((category) => (
                  <SelectItem
                    key={category.value}
                    value={String(category.value)}
                  >
                    {category.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span
              className="whitespace-nowrap text-xs text-muted-foreground"
              aria-live="polite"
            >
              {filteredProducts.length}
            </span>
          </div>
        </div>
        {filteredProducts.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/20 px-6 text-center">
            <PackageSearch className="mb-3 size-10 text-muted-foreground" />
            <h3 className="font-medium">No products found</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {selectedCategory !== "all" && !searchProducts.trim()
                ? "There are no products in this category."
                : "Try a different search or category."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {filteredProducts.map((product) => {
              const defaultVariant = product.variants.find(
                (variant) => variant.isDefault,
              );
              if (!defaultVariant) return null;

              return product.hasVariants ? (
                <ShowVariants
                  type="sale"
                  key={product.id}
                  product={product}
                  handleAdd={handleAdd}
                  defaultVariant={defaultVariant}
                />
              ) : (
                <ProductCard
                  type="sale"
                  key={product.id}
                  product={product}
                  handleAdd={handleAdd}
                  defaultVariant={defaultVariant}
                  onSerialClick={(selectedProduct) =>
                    openSerialPicker(selectedProduct, defaultVariant)
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      {activeSerialProduct && (
        <SerialPickerDialog
          variantId={activeSerialProduct.variantId}
          selected={selectedSerials}
          serialDialogOpen
          setSerialDialogOpen={(open) => {
            if (!open) setActiveSerialProduct(null);
          }}
          onConfirm={(serials) => {
            useCartStore
              .getState()
              .addSerialItem(
                activeSerialProduct.product,
                activeSerialProduct.variantId,
                serials,
              );
            setActiveSerialProduct(null);
          }}
        />
      )}
    </>
  );
}
