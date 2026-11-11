import { useState } from "react";
import { Check, ChevronDown, Package } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover.js";
import { cn } from "@/lib/utils";
import { money } from "../../cartPricing.js";
import type { SellUnitOption } from "../../hooks/useSellUnits.js";

/**
 * Per-line unit switcher (packaging-unit selling): a chip showing the
 * current unit ("Box"); opening it lists the variant's sell units with
 * their conversion ("1 Box = 12 Pcs"), per-package price and available
 * packages. `units` may still be loading — the trigger stays visible and
 * the popover explains it instead of the control disappearing entirely.
 */
export function UnitSwitcher({
  units,
  currentUomConversionId,
  currentLabel,
  onSwitch,
}: {
  units: SellUnitOption[];
  /** Unit id of the cart line this chip belongs to (null = base unit). */
  currentUomConversionId: number | null;
  currentLabel: string | null;
  onSwitch: (unit: SellUnitOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const baseUnitName = units.find((u) => u.uomConversionId === null)?.unitName;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-7 max-w-32 items-center gap-1 rounded-md border bg-muted/60 px-2 text-xs font-semibold text-foreground",
              "transition-colors hover:border-primary/50 hover:bg-muted",
            )}
            aria-label="Change sell unit"
          >
            <Package className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {currentLabel ?? "Unit"}
            </span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <PopoverContent className="w-64 gap-1 p-1.5" align="start">
        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
          Sell as…
        </p>
        {units.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            Loading units…
          </p>
        ) : (
          units.map((unit) => {
            const isCurrent =
              (unit.uomConversionId ?? null) === currentUomConversionId;
            const isPackage = unit.conversionFactor > 1;
            return (
              <button
                key={unit.uomConversionId ?? "base"}
                type="button"
                disabled={isCurrent}
                onClick={() => {
                  setOpen(false);
                  if (!isCurrent) onSwitch(unit);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                  isCurrent
                    ? "bg-muted font-medium"
                    : "hover:bg-muted/60 cursor-pointer",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate">{unit.unitName}</span>
                  <span className="block text-xs text-muted-foreground">
                    {isPackage && baseUnitName
                      ? `1 ${unit.unitName} = ${
                          unit.conversionFactor % 1 === 0
                            ? unit.conversionFactor.toFixed(0)
                            : unit.conversionFactor.toFixed(3)
                        } ${baseUnitName} · `
                      : ""}
                    {money(unit.salePrice)}
                    {unit.availablePackages != null
                      ? ` · ${unit.availablePackages} left`
                      : ""}
                  </span>
                </span>
                {isCurrent && (
                  <Check className="size-4 shrink-0 text-primary" />
                )}
              </button>
            );
          })
        )}
      </PopoverContent>
    </Popover>
  );
}
