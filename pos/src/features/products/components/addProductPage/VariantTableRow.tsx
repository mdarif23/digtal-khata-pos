import { Fragment } from "react";
import { TableCell, TableRow } from "@/components/ui/table";
import { InputField } from "./InputField";
import { ProductInfoInput } from "./ProductInfoInput";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RadioGroupItem } from "@/components/ui/radio-group";
import { VariantTableRowProps } from "../../product.types";
import { isSameVariant } from "../../utils/is-same-variant";
export function VariantTableRow({
  variant,
  form,
  remove,
  expanded,
  setExpanded,
  onAddVariant,
  onRemoveVariant,
  isEditing = false,
}: VariantTableRowProps) {
  const variants = form.watch("variants") || [];
  const variantIndex = variants.findIndex((item) =>
    isSameVariant(item, variant),
  );
  const added = variantIndex !== -1;
  const isNewVariant = added && variants[variantIndex]?.id === undefined;
  const isDefault = added && form.watch(`variants.${variantIndex}.isDefault`);
  const id = variant.options
    .map((option) => `${option.typeId}-${option.optionId}`)
    .join("-");
  const radioId = `radio-${id}`;
  const variantLabel = variant.options
    .map((option) => `${option.typeName}: ${option.value}`)
    .join(" / ");
  const detailsId = `variant-details-${id}`;

  return (
    <Fragment>
      <TableRow data-variant-id={added ? variants[variantIndex]?.id : undefined}>
        <TableCell>
          <div className="flex items-center gap-3">
            {added && (
              <RadioGroupItem
                value={String(variantIndex)}
                id={radioId}
                aria-label={`Set ${variantLabel} as the default variant`}
              />
            )}
            <span className="font-medium">{variantLabel}</span>
            {isDefault && <Badge variant="secondary">Default</Badge>}
          </div>
        </TableCell>
        <TableCell>
          {added ? (
            <InputField
              placeholder="auto-generated if blank"
              type="text"
              name={`variants.${variantIndex}.sku`}
              form={form}
            />
          ) : (
            <span className="text-sm text-muted-foreground">Add to configure</span>
          )}
        </TableCell>
        <TableCell>
          {added ? (
            <InputField
              placeholder="0.00"
              type="number"
              name={`variants.${variantIndex}.sellingPrice`}
              form={form}
            />
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </TableCell>

        <TableCell>
          <div className="flex">
            {added ? (
              (!isEditing || isNewVariant) && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${variantLabel}`}
                  title={`Remove ${variantLabel}`}
                  onClick={() => {
                    setExpanded(null);
                    onRemoveVariant(variantIndex);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              )
            ) : (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Add ${variantLabel}`}
                title={`Add ${variantLabel}`}
                onClick={() => {
                  onAddVariant(variant);
                }}
              >
                <Plus aria-hidden="true" />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={!added}
              aria-label={`${expanded === id ? "Collapse" : "Expand"} ${variantLabel} details`}
              aria-expanded={added && expanded === id}
              aria-controls={detailsId}
              title={added ? "Show variant details" : "Add variant first"}
              onClick={() => setExpanded(expanded === id ? null : id)}
            >
              <ChevronDown
                className={`size-5 transition-transform duration-200 ${expanded === id ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {expanded === id && added && (
        <TableRow>
          <TableCell id={detailsId} className="bg-muted/20 p-4 sm:p-5" colSpan={4}>
            <ProductInfoInput
              form={form}
              variantIndex={variantIndex}
              remove={remove}
              canRemoveVariant={false}
              canEditImages={!isEditing}
              canEditStock={!isEditing}
            />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
