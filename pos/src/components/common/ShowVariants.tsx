import { useMemo, useState } from "react";
import { buildVariantName } from "@/lib/variantDisplay";
import {
  Check,
  PackageCheck,
  Barcode,
  ScanBarcode,
  ShoppingBag,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { ProductCard, ProductImage } from "./ProductCard";
import {
  ProductType,
  ProductVariantType,
} from "@/features/products/product.schema";
import { toast } from "../ui/toast";
import { SerialPickerDialog } from "@/features/pos/components/pos/SerialPickerDialog";
import { useCartStore } from "@/features/pos/stores/useCartStore";
import { getVariantPurchaseCost } from "@/features/products/utils/getVariantPurchaseCost";

type VariantOptionGroup = {
  typeName: string;
  options: string[];
};

const EMPTY_SERIALS: string[] = [];
import { formatCurrency as currency } from "@/lib/format";

export interface ShowVariantsProps {
  product: ProductType;
  handleAdd: (product: ProductType) => void;
  defaultVariant: ProductVariantType;
  type: "purchase" | "sale";
}

export function ShowVariants({
  product,
  handleAdd,
  defaultVariant,
  type,
}: ShowVariantsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [serialDialogOpen, setSerialDialogOpen] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<
    Record<string, string>
  >({});
  const isSale = type === "sale";
  const isSerial = isSale && product.trackingType === "serial";
  const addSerialItem = useCartStore((state) => state.addSerialItem);

  const variantGroups = useMemo(() => {
    const groups = new Map<string, Set<string>>();
    for (const variant of product.variants) {
      for (const option of variant.options ?? []) {
        const values = groups.get(option.typeName) ?? new Set<string>();
        values.add(option.value);
        groups.set(option.typeName, values);
      }
    }

    return [...groups].map(([typeName, values]) => ({
      typeName,
      options: [...values],
    }));
  }, [product.variants]);

  const selectedEntries = Object.entries(selectedOptions);
  const selectedVariant =
    variantGroups.length > 0 && selectedEntries.length === variantGroups.length
      ? product.variants.find((variant) =>
          selectedEntries.every(([typeName, value]) =>
            variant.options?.some(
              (option) =>
                option.typeName === typeName && option.value === value,
            ),
          ),
        )
      : undefined;

  const cartSerials =
    useCartStore(
      (state) =>
        state.cart.find((item) =>
          item.variants.some(
            (variant) => variant.id === selectedVariant?.id,
          ),
        )?.serialNumbers,
    ) ?? EMPTY_SERIALS;

  const getMatchingVariants = (
    typeName: string,
    optionValue: string,
  ): ProductVariantType[] => {
    const candidateSelection = {
      ...selectedOptions,
      [typeName]: optionValue,
    };

    return product.variants.filter((variant) =>
      Object.entries(candidateSelection).every(([selectedType, value]) =>
        variant.options?.some(
          (option) =>
            option.typeName === selectedType && option.value === value,
        ),
      ),
    );
  };

  const handleOptionChange = (typeName: string, value: string) => {
    setSelectedOptions((current) => {
      const next = { ...current };
      if (value) {
        next[typeName] = value;
      } else {
        delete next[typeName];
      }
      return next;
    });
  };

  const variantName = selectedVariant
    ? buildVariantName(product.name, selectedVariant.options)
    : product.name;
  const variantPrice = selectedVariant
    ? isSale
      ? selectedVariant.sellingPrice
      : getVariantPurchaseCost(selectedVariant)
    : null;
  const canSelectVariant =
    selectedVariant !== undefined &&
    (!isSale || selectedVariant.quantity > 0);

  const handleAddVariant = () => {
    if (!selectedVariant || !canSelectVariant) return;

    const { variants: _variants, ...productDetails } = product;
    const selectedProduct = {
      ...productDetails,
      name: variantName,
      variants: [selectedVariant],
    };

    if (isSerial) {
      setSerialDialogOpen(true);
      return;
    }

    handleAdd(selectedProduct);
    if (isSale) {
      toast.add({ description: `${variantName} added to cart.` });
    }
    setDialogOpen(false);
  };

  return (
    <>
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (open) setSelectedOptions({});
        }}
      >
        <DialogTrigger>
          <ProductCard
            type={type}
            product={product}
            handleAdd={handleAdd}
            defaultVariant={defaultVariant}
          />
        </DialogTrigger>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader className="pr-8">
            <DialogTitle className="text-lg">
              Choose product options
            </DialogTitle>
            <DialogDescription>
              Select an available combination to continue.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="space-y-3">
              <div className="overflow-hidden rounded-xl border bg-muted/20 p-2">
                <AspectRatio ratio={4 / 3}>
                  <ProductImage
                    src={product.imageUrl}
                    alt={product.name}
                    className="rounded-lg"
                  />
                </AspectRatio>
              </div>
              <div>
                <h3 className="font-semibold">{product.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedVariant
                    ? selectedVariant.options
                        ?.map((option) => `${option.typeName}: ${option.value}`)
                        .join(" · ")
                    : "Choose the options for this product"}
                </p>
              </div>
              <Card className="gap-0 rounded-lg bg-muted/30 p-3 shadow-none ring-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">
                    {isSale ? "Selling price" : "Avg. purchase cost"}
                  </span>
                  <span className="font-semibold">
                    {variantPrice === null
                      ? "Select options"
                      : currency(variantPrice)}
                  </span>
                </div>
                {selectedVariant && (
                  <>
                    <div className="my-2 border-t" />
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted-foreground">Stock</span>
                      <span
                        className={
                          isSale && selectedVariant.quantity === 0
                            ? "font-medium text-destructive"
                            : "font-medium"
                        }
                      >
                        {selectedVariant.quantity}{" "}
                        {isSale ? "available" : "in stock"}
                      </span>
                    </div>
                    {selectedVariant.barcode && (
                      <div className="flex items-center gap-2">
                        <Barcode className="size-4 text-muted-foreground" />
                        <span className="font-mono text-sm">
                          {selectedVariant.barcode}
                        </span>
                      </div>
                    )}
                    {selectedVariant.sku && (
                      <div className="mt-2 flex items-center justify-between gap-3 text-sm">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <ScanBarcode className="size-4" />
                          SKU
                        </span>
                        <span className="max-w-[65%] truncate font-mono text-xs">
                          {selectedVariant.sku}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </Card>
            </div>

            <div className="space-y-5">
              {variantGroups.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No selectable options are configured for this product.
                </p>
              ) : (
                variantGroups.map((group) => {
                  const selectedOption = selectedOptions[group.typeName] ?? "";
                  return (
                    <fieldset key={group.typeName} className="space-y-2.5">
                      <legend className="text-sm font-semibold">
                        {group.typeName}
                      </legend>
                      <ToggleGroup
                        value={selectedOption ? [selectedOption] : []}
                        onValueChange={(value) =>
                          handleOptionChange(group.typeName, value[0] ?? "")
                        }
                        variant="outline"
                        className="flex flex-wrap justify-start gap-2"
                        aria-label={`Choose ${group.typeName}`}
                      >
                        {group.options.map((optionValue) => {
                          const matchingVariants = getMatchingVariants(
                            group.typeName,
                            optionValue,
                          );
                          const availableQuantity = matchingVariants.reduce(
                            (quantity, variant) => quantity + variant.quantity,
                            0,
                          );
                          const available = !isSale || availableQuantity > 0;
                          const selected =
                            selectedOptions[group.typeName] === optionValue;

                          return (
                            <ToggleGroupItem
                              key={optionValue}
                              value={optionValue}
                              disabled={!available}
                              className={`h-auto min-h-10 gap-2 px-3 py-2 ${
                                selected
                                  ? "border-primary bg-primary/5 text-primary"
                                  : ""
                              } ${!available ? "line-through opacity-50" : ""}`}
                            >
                              {selected && (
                                <Check
                                  className="size-3.5"
                                  aria-hidden="true"
                                />
                              )}
                              <span>{optionValue}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {availableQuantity}
                              </span>
                            </ToggleGroupItem>
                          );
                        })}
                      </ToggleGroup>
                    </fieldset>
                  );
                })
              )}
              <div
                className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
                aria-live="polite"
              >
                {selectedVariant
                  ? canSelectVariant
                    ? `Ready to add ${variantName}.`
                    : "This option is out of stock. Choose another combination."
                  : "Choose one option from each group."}
              </div>
            </div>
          </div>

          <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!canSelectVariant}
              onClick={handleAddVariant}
            >
              {isSerial ? (
                <>
                  <PackageCheck />
                  Select serials
                </>
              ) : (
                <>
                  <ShoppingBag />
                  {isSale ? "Add to cart" : "Add to purchase"}
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {isSerial && (
        <SerialPickerDialog
          serialDialogOpen={serialDialogOpen}
          setSerialDialogOpen={(open) => {
            setSerialDialogOpen(open);
          }}
          variantId={selectedVariant?.id}
          selected={cartSerials}
          onConfirm={(serials) => {
            if (!selectedVariant) return;
            addSerialItem(
              { ...product, name: variantName, variants: [selectedVariant] },
              selectedVariant.id,
              serials,
            );
            toast.add({ description: `${variantName} added to cart.` });
            setDialogOpen(false);
          }}
        />
      )}
    </>
  );
}
