import { useState } from "react";
import { ImageOff, Package, Plus } from "lucide-react";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Card } from "@/components/ui/card";
import { SerialPickerDialog } from "@/features/pos/components/pos/SerialPickerDialog";
import { useCartStore } from "@/features/pos/stores/useCartStore";
import {
  ProductType,
  ProductVariantType,
} from "@/features/products/product.schema";
import { toast } from "../ui/toast";
import useProductStore from "@/features/products/useProductStore";
import { getVariantPurchaseCost } from "@/features/products/utils/getVariantPurchaseCost";

export interface ProductCardProps {
  product: ProductType;
  handleAdd: (product: ProductType) => void;
  defaultVariant: ProductVariantType;
  type: "purchase" | "sale";
  onSerialClick?: (prod: ProductType) => void;
}

import { formatCurrency as currency } from "@/lib/format";

export function ProductImage({
  src,
  alt,
  className,
}: {
  src: string | null;
  alt: string;
  className?: string;
}) {
  const [hasError, setHasError] = useState(false);

  if (!src || hasError) {
    return (
      <div
        className={`flex h-full w-full items-center justify-center bg-muted/50 text-muted-foreground ${className ?? ""}`}
        aria-label={`${alt} image unavailable`}
      >
        {hasError ? (
          <ImageOff className="size-8" aria-hidden="true" />
        ) : (
          <Package className="size-10" aria-hidden="true" />
        )}
      </div>
    );
  }

  return (
    <img
      className={`h-full w-full object-contain ${className ?? ""}`}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setHasError(true)}
    />
  );
}

export function ProductCard({
  product,
  handleAdd,
  defaultVariant,
  type,
  onSerialClick,
}: ProductCardProps) {
  const categories = useProductStore(
    (state) => state.productSelectOptions.categories,
  );
  const [serialDialogOpen, setSerialDialogOpen] = useState(false);
  const cartSerials = useCartStore(
    (state) =>
      state.cart.find((item) =>
        item.variants.some((variant) => variant.id === defaultVariant.id),
      )?.serialNumbers,
  );
  const addSerialItem = useCartStore((state) => state.addSerialItem);

  const totalQuantity = product.variants.reduce(
    (total, variant) => total + variant.quantity,
    0,
  );
  const totalAlertQuantity = product.variants.reduce(
    (total, variant) => total + variant.alertQuantity,
    0,
  );
  const outOfStock = totalQuantity <= 0;
  const lowStock =
    totalQuantity > 0 && totalQuantity <= totalAlertQuantity;
  const isSale = type === "sale";
  const isUnavailable = isSale && outOfStock;
  const categoryName = categories.find(
    (category) => category.value === product.categoryId,
  )?.label;
  const prices = product.variants.map((variant) =>
    isSale ? variant.sellingPrice : getVariantPurchaseCost(variant),
  );
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const maxPrice = prices.length ? Math.max(...prices) : 0;
  const priceLabel =
    prices.length > 1 && minPrice !== maxPrice
      ? `${currency(minPrice)} – ${currency(maxPrice)}`
      : currency(
          isSale
            ? defaultVariant.sellingPrice
            : getVariantPurchaseCost(defaultVariant),
        );
  const isSerial = isSale && product.trackingType === "serial";
  const canInteract = !product.hasVariants && !isUnavailable;

  const handleActivate = () => {
    if (!canInteract) return;
    if (isSerial) {
      if (onSerialClick) {
        onSerialClick(product);
      } else {
        setSerialDialogOpen(true);
      }
      return;
    }

    handleAdd({ ...product, variants: [defaultVariant] });
    if (isSale) {
      toast.add({ description: `${product.name} added to cart.` });
    }
  };

  return (
    <>
      <Card
        role={canInteract ? "button" : undefined}
        tabIndex={canInteract ? 0 : undefined}
        aria-disabled={isUnavailable || undefined}
        onClick={handleActivate}
        onKeyDown={(event) => {
          if (canInteract && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            handleActivate();
          }
        }}
        className={`group relative h-full cursor-pointer select-none gap-0 rounded-xl p-2.5 text-left shadow-none ring-1 ring-border/70 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:ring-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:p-3 ${
          isUnavailable
            ? "cursor-not-allowed opacity-75"
            : "active:scale-[0.99]"
        }`}
      >
        <div className="relative overflow-hidden rounded-lg bg-muted/30">
          <AspectRatio ratio={1}>
            <ProductImage
              src={product.imageUrl}
              alt={product.name}
              className="transition-transform duration-300 group-hover:scale-105"
            />
          </AspectRatio>
          {product.hasVariants && (
            <span className="absolute left-2 top-2 rounded-full border bg-background/90 px-2 py-0.5 text-[10px] font-medium text-foreground shadow-sm backdrop-blur">
              {product.variants.length} options
            </span>
          )}
          {isUnavailable ? (
            <span className="absolute inset-x-0 bottom-0 bg-destructive/90 px-2 py-1.5 text-center text-xs font-semibold text-white">
              Out of stock
            </span>
          ) : lowStock ? (
            <span className="absolute bottom-2 left-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Low stock
            </span>
          ) : null}
          {canInteract && (
            <span className="absolute bottom-2 right-2 flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <Plus className="size-4" aria-hidden="true" />
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1 pt-3">
          <h2 className="truncate text-sm font-medium leading-5 sm:text-[15px]">
            {product.name}
          </h2>
          <p className="mt-0.5 min-h-4 truncate text-xs text-muted-foreground">
            {categoryName ?? (product.hasVariants ? "Choose an option" : " ")}
          </p>
        </div>

        <div className="mt-2 flex items-end justify-between gap-2">
          <span className="min-w-0 truncate text-sm font-semibold tracking-tight sm:text-base">
            {priceLabel}
          </span>
          <span
            className={`shrink-0 text-[11px] ${
              lowStock ? "font-medium text-amber-700 dark:text-amber-300" : "text-muted-foreground"
            }`}
          >
            {totalQuantity} in stock
          </span>
        </div>
      </Card>

      {isSerial && !onSerialClick && (
        <SerialPickerDialog
          serialDialogOpen={serialDialogOpen}
          setSerialDialogOpen={setSerialDialogOpen}
          variantId={defaultVariant.id}
          selected={cartSerials ?? []}
          onConfirm={(serials) => {
            addSerialItem(product, defaultVariant.id, serials);
            toast.add({ description: `${product.name} added to cart.` });
          }}
        />
      )}
    </>
  );
}
