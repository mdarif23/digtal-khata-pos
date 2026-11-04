import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useState } from "react";
import { buildVariantName } from "@/lib/variantDisplay";
import { Button } from "@/components/ui/button";
import { GroupedVariantOption, ShowVariantsProps } from "../../purchase.types";
import { ProductCard } from "./ProductCard";
export function ShowVariants({
  product,
  handleAddPurchase,
  defaultVariant,
}: ShowVariantsProps) {
  const [selectedVariant, setSelectedVariant] = useState<
    Record<string, string>
  >({});
  const variantsGroup = product.variants.reduce<GroupedVariantOption[]>(
    (group, current) => {
      current.options?.forEach((option) => {
        // 1. Check if the typeName already exists in our array
        let existingGroup = group.find((g) => g.typeName === option.typeName);

        // 2. If it doesn't exist, create it and push it to the array
        if (!existingGroup) {
          existingGroup = { typeName: option.typeName, optionsName: [] };
          group.push(existingGroup);
        }

        // 3. Check if the value already exists in THIS specific group
        // This is much faster and cleaner than searching the whole array again!
        if (!existingGroup.optionsName.includes(option.value)) {
          existingGroup.optionsName.push(option.value);
        }
      });

      return group;
    },
    [],
  );
  const selectedEntries = Object.entries(selectedVariant);
  const findVariant =
    selectedEntries.length === variantsGroup.length
      ? product.variants.find((variant) =>
          selectedEntries.every(([typeName, value]) =>
            variant.options?.some(
              (option) =>
                option.typeName === typeName && option.value === value,
            ),
          ),
        )
      : undefined;
  function isOptionAvailable(typeName: string, optionName: string) {
    const candidateSelection = { ...selectedVariant, [typeName]: optionName };

    return product.variants.some((variant) => {
      if (variant.quantity <= 0) return false;

      return Object.entries(candidateSelection).every(([tName, val]) =>
        variant.options?.some(
          (option) => option.typeName === tName && option.value === val,
        ),
      );
    });
  }
  const handleValueChange = (
    value: string[],
    variant: GroupedVariantOption,
  ) => {
    const selectedValue = Array.isArray(value) ? value[0] : value;

    setSelectedVariant((prev) => {
      const updated = { ...prev };

      if (!selectedValue) {
        // deselected — remove this attribute type entirely
        delete updated[variant.typeName];
      } else {
        updated[variant.typeName] = selectedValue;
      }

      return updated;
    });
  };
  const variantFullName = findVariant
    ? buildVariantName(product.name, findVariant.options)
    : "Select Variant";
  return (
    <Dialog>
      <DialogTrigger>
        <ProductCard
          product={product}
          handleAddPurchase={handleAddPurchase}
          defaultVariant={defaultVariant}
        />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Product has variations. Please select a variation.
          </DialogTitle>
        </DialogHeader>
        <Card>
          <CardContent>
            <AspectRatio ratio={16 / 9} className="w-full max-w-sm rounded-lg">
              <img
                className="h-full w-full object-contain rounded-md"
                src={
                  product.imageUrl ??
                  "https://www.startech.com.bd/image/cache/catalog/ceiling-fan/qulik/windora/windora-01-500x500.webp"
                }
                alt={product.name}
              />
            </AspectRatio>
            <span className="text-xl"> {variantFullName}</span>
            {variantsGroup.map((variant) => (
              <div key={variant.typeName} className="flex flex-col gap-3">
                <span className="text-lg">{variant.typeName}</span>
                <ToggleGroup
                  value={(() => {
                    const selectedValue = selectedVariant[variant.typeName];
                    return selectedValue ? [selectedValue] : [];
                  })()}
                  onValueChange={(value) => {
                    handleValueChange(value, variant);
                  }}
                  variant="outline"
                >
                  {variant.optionsName.map((optionName, key) => {
                    const available = isOptionAvailable(
                      variant.typeName,
                      optionName,
                    );
                    const id = `${key}-${variant.typeName}`;
                    return (
                      <ToggleGroupItem
                        key={id}
                        value={optionName}
                        disabled={!available}
                        className={!available ? "opacity-50 line-through" : ""}
                      >
                        {optionName}
                      </ToggleGroupItem>
                    );
                  })}
                </ToggleGroup>
              </div>
            ))}
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button variant="outline">Cancel</Button>
            <Button
              onClick={() => {
                if (findVariant === undefined) return;
                const { variants, ...updatedProduct } = product;
                handleAddPurchase({
                  ...updatedProduct,
                  variants: findVariant ? [findVariant] : [],
                });
              }}
            >
              Add Variant
            </Button>
          </CardFooter>
        </Card>
      </DialogContent>
    </Dialog>
  );
}
