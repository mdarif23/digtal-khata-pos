import { Input } from "@/components/ui/input";

/**
 * Whole-number return quantity input, clamped to the line's returnable
 * maximum (received − returned, capped by available stock). UOM (migration
 * 0062): the value is in the line's SELECTED packaging unit — when one is
 * active the max label and the step stay unit-suffixed.
 */
export function ReturnQuantityInput({
  value,
  maxReturn,
  label,
  disabled,
  unitName,
  onChange,
}: {
  value: number;
  maxReturn: number;
  label: string;
  disabled: boolean;
  /** The selected packaging unit (absent = base unit). */
  unitName?: string | undefined;
  onChange: (value: number) => void;
}) {
  return (
    <>
      <Input
        aria-label={label}
        type="number"
        min={0}
        max={maxReturn}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
        className="h-9"
      />
      <span className="mt-1 block text-xs text-muted-foreground">
        Max {maxReturn}
        {unitName ? ` ${unitName}` : ""}
      </span>
    </>
  );
}
