import { useEffect, useRef, useState } from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge.js";
import { Layers3, Package } from "lucide-react";
import { Controller } from "react-hook-form";
import { Switch } from "@/components/ui/switch";
import { ProductTypeInput } from "../../product.schema";
import { generateVariants } from "../../utils/generate-variants";
import { emptyVariant } from "../../constants/form-defaults";
import { isSameVariant } from "../../utils/is-same-variant";
import { MultipleVariantSelector } from "./MultipleVariantSelector";
import { VariantsTable } from "./VariantsTable";
import { ProductInfoInput } from "./ProductInfoInput";
import { AccordionCardProps } from "../../product.types";
import useProductStore from "../../useProductStore";

function getVariantKey(options: ProductTypeInput["variants"][number]["options"]) {
  return (options ?? [])
    .map((option) => `${option.typeId}-${option.optionId}`)
    .sort()
    .join("|");
}

export function VariantsInfoCard({
  form,
  append,
  replace,
  remove,
  fields,
  isEditing = false,
  inventorySummary,
}: AccordionCardProps) {
  const [selectedVariantTypeNames, setSelectedVariantTypeNames] = useState<
    string[]
  >([]);
  const [singleVariantBackup, setSingleVariantBackup] = useState<
    ProductTypeInput["variants"][number] | null
  >(null);
  const variantDrafts = useRef(
    new Map<string, ProductTypeInput["variants"][number]>(),
  );
  const productVariantOptions = useProductStore(
    (state) => state.productVariantOptions,
  );
  const hasVariants = form.watch("hasVariants");
  const variants = form.watch("variants") || [];
  const existingTypeNames = Array.from(
    new Set(
      variants.flatMap((variant) =>
        variant.options?.map((option) => option.typeName) ?? [],
      ),
    ),
  );
  const activeTypeNames = isEditing
    ? existingTypeNames
    : selectedVariantTypeNames;
  useEffect(() => {
    for (const variant of variants) {
      if (variant.options?.length) {
        variantDrafts.current.set(getVariantKey(variant.options), variant);
      }
    }
  }, [variants]);
  const selectedGroups = productVariantOptions.filter((option) =>
    activeTypeNames.includes(option.typeName),
  );
  const generatedVariants = generateVariants(selectedGroups);
  const allVariants = isEditing
    ? [
        ...variants.flatMap((variant) =>
          variant.options?.length ? [{ options: variant.options }] : [],
        ),
        ...generatedVariants.filter(
          (generatedVariant) =>
            !variants.some((variant) =>
              isSameVariant(variant, generatedVariant),
            ),
        ),
      ]
    : generatedVariants;

  const handleVariantTypeChange = (typeNames: string[]) => {
    const generated = generateVariants(
      productVariantOptions.filter((option) =>
        typeNames.includes(option.typeName),
      ),
    );
    const currentVariants = form.getValues("variants") ?? [];
    for (const variant of currentVariants) {
      if (variant.options?.length) {
        variantDrafts.current.set(getVariantKey(variant.options), variant);
      }
    }
    const nextVariants = generated.flatMap((generatedVariant) => {
      const currentVariant = currentVariants.find((variant) =>
        isSameVariant(variant, generatedVariant),
      );
      const savedVariant =
        currentVariant ??
        variantDrafts.current.get(getVariantKey(generatedVariant.options));
      return savedVariant
        ? [{ ...savedVariant, options: generatedVariant.options }]
        : [];
    });
    const defaultIndex = nextVariants.findIndex((variant) => variant.isDefault);
    const normalizedVariants = nextVariants.map((variant, index) => ({
      ...variant,
      isDefault: index === (defaultIndex === -1 ? 0 : defaultIndex),
    }));

    setSelectedVariantTypeNames(typeNames);
    replace(normalizedVariants);
  };

  const handleHasVariantsChange = (value: boolean) => {
    if (isEditing) return;

    if (value) {
      const currentVariant = form.getValues("variants")?.[0];
      if (currentVariant) setSingleVariantBackup(currentVariant);
      form.setValue("hasVariants", true, { shouldDirty: true });
      replace([]);
      return;
    }

    form.setValue("hasVariants", false, { shouldDirty: true });
    replace([singleVariantBackup ?? emptyVariant]);
    setSingleVariantBackup(null);
    setSelectedVariantTypeNames([]);
  };

  const forgetVariantDraft = (
    variant: ProductTypeInput["variants"][number],
  ) => {
    if (variant.options?.length) {
      variantDrafts.current.delete(getVariantKey(variant.options));
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Layers3 className="size-5 text-primary" aria-hidden="true" />
            Variants & inventory
          </CardTitle>
          <CardDescription>
            Set pricing and stock details for this product or each of its
            variants.
          </CardDescription>
        </div>
        <CardAction className="flex items-center gap-2">
          <Controller
            name="hasVariants"
            control={form.control}
            render={({ field }) => (
              <Switch
                id="has-variants"
                checked={field.value}
                disabled={isEditing}
                onCheckedChange={(value) => {
                  field.onChange(value);
                  handleHasVariantsChange(value);
                }}
              />
            )}
          />
          <Label htmlFor="has-variants" className="cursor-pointer">
            Multiple variants
          </Label>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-5">
        {hasVariants ? (
          <>
            {!isEditing && (
              <MultipleVariantSelector
                selectedVariantTypeNames={selectedVariantTypeNames}
                onSelectionChange={handleVariantTypeChange}
              />
            )}
            {isEditing && (
              <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                <div className="flex items-start gap-3 text-sm text-muted-foreground">
                  <Package
                    className="mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <p>
                    Add new size or color values in Variant management first.
                    Existing combinations and their stock history are preserved.
                  </p>
                </div>
                <MultipleVariantSelector
                  selectedVariantTypeNames={activeTypeNames}
                  onSelectionChange={() => undefined}
                  disabled
                />
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  {isEditing ? "Product variants" : "Available combinations"}
                </span>
                <Badge variant="outline">
                  {allVariants.length} total
                </Badge>
                <Badge variant="secondary">
                  {variants.length} {isEditing ? "saved or staged" : "added"}
                </Badge>
              </div>
              {allVariants.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {variants.filter((variant) => variant.id === undefined)
                    .length > 0
                    ? "New variants start with zero stock. Receive stock through a purchase or stock adjustment."
                    : "Choose a default variant with the radio button."}
                </p>
              )}
            </div>

            <VariantsTable
              form={form}
              append={append}
              remove={remove}
              replace={replace}
              allVariants={allVariants}
              onForgetVariant={forgetVariantDraft}
              isEditing={isEditing}
                inventorySummary={inventorySummary}
            />
          </>
        ) : (
          <div className="rounded-lg border bg-muted/10 p-4 sm:p-5">
            <div className="mb-4">
              <h3 className="font-medium">Default variant</h3>
              <p className="text-sm text-muted-foreground">
                Add pricing, stock thresholds, and tracking details for this
                product.
              </p>
            </div>
            {fields.length > 0 && (
              <ProductInfoInput
                form={form}
                variantIndex={0}
                canRemoveVariant={false}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
