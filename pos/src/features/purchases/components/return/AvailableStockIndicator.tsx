/**
 * On-hand stock display for a returnable line — already netted against
 * quantities selected on sibling lines sharing the same variant.
 */
export function AvailableStockIndicator({
  availableStock,
  maxReturn,
}: {
  availableStock: number;
  maxReturn: number;
}) {
  return (
    <span
      className={
        maxReturn <= 0
          ? "text-xs font-medium text-muted-foreground"
          : "text-xs font-medium text-emerald-700"
      }
    >
      {availableStock} in stock
      {maxReturn < availableStock ? ` · ${maxReturn} returnable` : ""}
    </span>
  );
}
