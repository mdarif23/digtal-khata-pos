import { Field, FieldDescription, FieldLabel } from "@/components/ui/field.js";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { useProductVariantOptionsQuery } from "../../hooks/useProductOptions.js";

export function MultipleVariantSelector({
  selectedVariantTypeNames,
  onSelectionChange,
  disabled = false,
}: {
  selectedVariantTypeNames: string[];
  onSelectionChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const anchor = useComboboxAnchor();
  const productVariantOptions = useProductVariantOptionsQuery().data ?? [];
  const variantTypeNames = productVariantOptions.map(
    (option) => option.typeName,
  );

  return (
    <Field>
      <FieldLabel>Variant options</FieldLabel>
      <Combobox
        multiple
        autoHighlight
        disabled={disabled}
        items={variantTypeNames}
        value={selectedVariantTypeNames}
        onValueChange={onSelectionChange}
      >
        <ComboboxChips ref={anchor} className="w-full bg-background">
          <ComboboxValue>
            {(values) => (
              <>
                {values.map((value: string) => (
                  <ComboboxChip key={value}>{value}</ComboboxChip>
                ))}
                <ComboboxChipsInput
                  aria-label="Select variant options"
                  placeholder={
                    values.length > 0
                      ? "Add another option…"
                      : "Choose size, color, or other options"
                  }
                />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>No variant options found.</ComboboxEmpty>
          <ComboboxList>
            {(item) => (
              <ComboboxItem key={item} value={item}>
                {item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <FieldDescription>
        Choose one or more dimensions. The combinations are generated below;
        configured details are kept for combinations that remain selected.
      </FieldDescription>
    </Field>
  );
}
