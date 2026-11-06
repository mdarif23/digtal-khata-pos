import { Input } from "@/components/ui/input";

/**
 * Whole-number return quantity input, clamped to the line's returnable
 * maximum (received − returned, capped by available stock).
 */
export function ReturnQuantityInput({
  value,
  maxReturn,
  label,
  disabled,
  onChange,
}: {
  value: number;
  maxReturn: number;
  label: string;
  disabled: boolean;
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
      </span>
    </>
  );
}
