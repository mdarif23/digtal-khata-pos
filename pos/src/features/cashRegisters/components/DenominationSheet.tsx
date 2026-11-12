import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/features/reports/utils/reportUtils";
import type { DenominationCount } from "../registers.api";

/**
 * Denomination counting sheet (Phase 1): one input per configured note/coin
 * value, with the live rendered total. The total must equal the single
 * amount the user entered — the sheet documents the count, it never
 * replaces it (mirrors the server-side validation).
 */
export function DenominationSheet(props: {
  denominations: number[];
  counts: Record<number, string>;
  onCountsChange: (counts: Record<number, string>) => void;
}) {
  const total = props.denominations.reduce(
    (sum, value) => sum + value * (Number(props.counts[value] ?? 0) || 0),
    0,
  );
  const anyCount = props.denominations.some(
    (value) => (Number(props.counts[value] ?? 0) || 0) > 0,
  );

  return (
    <div className="grid gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <Label>Count by denominations (optional)</Label>
        <span className="text-xs text-muted-foreground">
          {anyCount ? `Sheet total: ${formatCurrency(total)}` : "All zeros = skip sheet"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3">
        {props.denominations.map((value) => (
          <div key={value} className="flex items-center gap-1.5">
            <span className="w-14 text-xs text-muted-foreground">
              ×{formatCurrency(value)}
            </span>
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              className="h-8 w-20"
              value={props.counts[value] ?? ""}
              onChange={(e) =>
                props.onCountsChange({
                  ...props.counts,
                  [value]: e.target.value.replace(/\D/g, ""),
                })
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Converts the sheet UI state to the API payload (empty sheet = omitted). */
export function sheetToPayload(
  denominations: number[],
  counts: Record<number, string>,
): DenominationCount[] | undefined {
  const rows = denominations
    .map((value) => ({ value, count: Number(counts[value] ?? 0) || 0 }))
    .filter((row) => row.count > 0);
  return rows.length > 0 ? rows : undefined;
}
