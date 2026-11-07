import { useMemo, useState } from "react";
import { ListPlus, PackageOpen } from "lucide-react";
import {
  Table,
  TableBody,
  TableCaption,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { VariantRowProps } from "../../product.types";
import { isSameVariant } from "../../utils/is-same-variant";
import { createVariant } from "../../constants/form-defaults";
import { VariantTableRow } from "./VariantTableRow";

function getVariantKey(options: { typeId: number; optionId: number }[]) {
  return options
    .map((option) => `${option.typeId}-${option.optionId}`)
    .sort()
    .join("|");
}

export function VariantsTable({
  form,
  append,
  remove,
  replace,
  allVariants,
  onForgetVariant,
  isEditing = false,
  inventorySummary,
}: VariantRowProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const variants = form.watch("variants") || [];
  const defaultIndex = variants.findIndex((variant) => variant.isDefault);
  const selectedVariants = useMemo(
    () => new Set(variants.map((variant) => getVariantKey(variant.options ?? []))),
    [variants],
  );
  const missingVariants = allVariants.filter(
    (variant) => !selectedVariants.has(getVariantKey(variant.options)),
  );

  const addVariant = (generatedVariant: (typeof allVariants)[number]) => {
    const currentVariants = form.getValues("variants") ?? [];
    if (
      currentVariants.some((variant) =>
        isSameVariant(variant, generatedVariant),
      )
    ) {
      return;
    }

    const newVariant = createVariant(generatedVariant);
    if (!currentVariants.some((variant) => variant.isDefault)) {
      newVariant.isDefault = true;
    }
    append(newVariant, { shouldFocus: false });
  };

  const addAllMissingVariants = () => {
    const currentVariants = form.getValues("variants") ?? [];
    const currentKeys = new Set(
      currentVariants.map((variant) => getVariantKey(variant.options ?? [])),
    );
    const additions = allVariants
      .filter((variant) => !currentKeys.has(getVariantKey(variant.options)))
      .map(createVariant);

    if (additions.length === 0) return;
    if (!currentVariants.some((variant) => variant.isDefault)) {
      additions[0]!.isDefault = true;
    }
    additions.forEach((variant) => append(variant, { shouldFocus: false }));
  };

  const removeVariant = (variantIndex: number) => {
    const currentVariants = form.getValues("variants") ?? [];
    const removedVariant = currentVariants[variantIndex];
    if (!removedVariant) return;
    onForgetVariant(removedVariant);
    const removedWasDefault = removedVariant.isDefault;
    remove(variantIndex);

    if (!removedWasDefault || currentVariants.length <= 1) return;
    const replacementDefaultIndex = Math.min(variantIndex, currentVariants.length - 2);
    form.setValue(`variants.${replacementDefaultIndex}.isDefault`, true, {
      shouldDirty: true,
      shouldTouch: true,
    });
  };

  const handleDefaultChange = (value: string) => {
    const selectedIndex = Number(value);
    if (!Number.isInteger(selectedIndex) || !variants[selectedIndex]) return;

    variants.forEach((_, index) => {
      form.setValue(`variants.${index}.isDefault`, index === selectedIndex, {
        shouldDirty: true,
        shouldTouch: true,
      });
    });
  };

  if (allVariants.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-5 py-10 text-center">
        <PackageOpen className="size-8 text-muted-foreground" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">No combinations to show yet</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          Select variant options above. Make sure each selected option has
          values configured in Variant management.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex flex-col gap-3 border-b bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{allVariants.length} combinations</Badge>
          <span>
            {missingVariants.length > 0
              ? `${missingVariants.length} not added yet`
              : "All combinations are added"}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={missingVariants.length === 0}
          onClick={addAllMissingVariants}
        >
          <ListPlus aria-hidden="true" />
          Add all missing
        </Button>
      </div>

      <RadioGroup
        aria-label="Choose the default product variant"
        className="contents"
        value={defaultIndex === -1 ? "" : String(defaultIndex)}
        onValueChange={handleDefaultChange}
      >
        <Table>
          <TableCaption className="sr-only">
            Product variant combinations and their pricing
          </TableCaption>
          <TableHeader className="bg-muted/30">
            <TableRow>
              <TableHead className="min-w-40">Variant</TableHead>
              <TableHead className="min-w-40">SKU</TableHead>
              <TableHead className="min-w-40 text-right">
                Selling price
              </TableHead>
              <TableHead className="w-24 text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allVariants.map((variant) => (
              <VariantTableRow
                key={getVariantKey(variant.options)}
                variant={variant}
                form={form}
                remove={remove}
                expanded={expanded}
                setExpanded={setExpanded}
                onAddVariant={addVariant}
                onRemoveVariant={removeVariant}
                isEditing={isEditing}
                inventorySummary={inventorySummary}
              />
            ))}
          </TableBody>
        </Table>
      </RadioGroup>
    </div>
  );
}
