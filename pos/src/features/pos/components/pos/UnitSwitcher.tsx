import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover.js";
import { cn } from "@/lib/utils";
import { money } from "../../cartPricing.js";
import type { SellUnitOption } from "../../hooks/useSellUnits.js";

/**
 * Compact per-line unit switcher (packaging-unit selling): a small chip
 * showing the current unit abbreviation ("Box"); opening it lists the
 * variant's sell units with their per-unit price and available packages.
 * Only rendered for variants that actually HAVE packaging units —
 * single-unit products never see any new UI.
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-6 max-w-28 items-center gap-0.5 rounded-md border bg-muted/40 px-1.5 text-xs font-medium text-muted-foreground",
              "transition-colors hover:border-primary/40 hover:text-foreground",
            )}
            aria-label="Change sell unit"
          >
            <span className="truncate">
              {currentLabel ?? "Unit"}
            </span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
        }
      />
      <PopoverContent className="w-60 gap-1 p-1" align="start">
        <p className="px-2 py-1 text-xs text-muted-foreground">Sell unit</p>
        {units.map((unit) => {
          const isCurrent =
            (unit.uomConversionId ?? null) === currentUomConversionId;
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
                "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                isCurrent
                  ? "bg-muted font-medium"
                  : "hover:bg-muted/60 cursor-pointer",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate">{unit.unitName}</span>
                <span className="block text-xs text-muted-foreground">
                  {money(unit.salePrice)}
                  {unit.availablePackages != null
                    ? ` · ${unit.availablePackages} left`
                    : ""}
                </span>
              </span>
              {isCurrent && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  current
                </span>
              )}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
