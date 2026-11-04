import { useMemo, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ActiveSerialProduct = {
  product: ProductType;
  variantId: number | undefined;
};

const EMPTY_SERIALS: string[] = [];

export function ProductList() {
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

  const handleScan = (code: string) => {
    const normalizedCode = code.trim().toLowerCase();
    const match = products
      .flatMap((product) =>
        product.variants.map((variant) => ({ product, variant })),
      )
      .find(
        ({ variant }) =>
          variant.barcode?.trim().toLowerCase() === normalizedCode ||
          variant.sku.trim().toLowerCase() === normalizedCode,
      );

    if (!match) {
      if (filteredProducts.length === 0) {
        toast.add({
          type: "error",
          description: "No product matches that name, SKU, or barcode.",
        });
      }
      return;
    }

    const { product, variant } = match;
    if (variant.quantity <= 0) {
      toast.add({
        type: "error",
        description: `${product.name} is out of stock.`,
      });
      return;
    }

    if (product.trackingType === "serial") {
      setSearchProducts("");
      setActiveSerialProduct({ product, variantId: variant.id });
      return;
    }

    const variantName = buildVariantName(product.name, variant.options);
    addToCart({ ...product, name: variantName, variants: [variant] });
    setSearchProducts("");
    toast.add({ description: `${variantName} added to cart.` });
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
        onScan={handleScan}
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
                  handleAdd={addToCart}
                  defaultVariant={defaultVariant}
                />
              ) : (
                <ProductCard
                  type="sale"
                  key={product.id}
                  product={product}
                  handleAdd={addToCart}
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
