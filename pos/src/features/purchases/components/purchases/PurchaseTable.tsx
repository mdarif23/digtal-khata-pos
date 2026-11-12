import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PurchaseCart } from "../../purchase.types";
import { buildVariantOptionsLabel } from "@/lib/variantDisplay";
import { formatCurrency } from "../../utils/formatCurrency";
import { usePurchaseUnits } from "../../hooks/usePurchaseUnits";
import {
  formatConversionHint,
  unitOptionLabel,
} from "../../utils/uom";

type PurchaseLineField =
  | "purchaseQty"
  | "purchasePrice"
  | "purchaseDiscount"
  | "purchaseTax";

export function PurchaseTable({
  purchasesCart,
  onUpdateItem,
  onUnitChange,
  onRemoveItem,
}: {
  purchasesCart: PurchaseCart[];
  onUpdateItem: (variantId: number, field: PurchaseLineField, value: number) => void;
  /** UOM (migration 0062): switch the line's packaging unit. */
  onUnitChange: (
    variantId: number,
    unit: { uomConversionId: number | null; unitName: string; conversionFactor: number; defaultPurchasePrice: number | null },
  ) => void;
  onRemoveItem: (variantId: number) => void;
}) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[790px] text-left text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-3 font-medium">Product</th>
            <th className="w-28 px-2 py-3 font-medium">Unit</th>
            <th className="w-24 px-2 py-3 font-medium">Qty</th>
            <th className="w-28 px-2 py-3 font-medium">Unit cost</th>
            <th className="w-24 px-2 py-3 font-medium">Discount</th>
            <th className="w-24 px-2 py-3 font-medium">Tax</th>
            <th className="px-2 py-3 text-right font-medium">Total</th>
            <th className="w-12 px-2 py-3" aria-label="Actions" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {purchasesCart.map((item) => {
            const variant = item.variants[0];
            const variantId = variant?.id;
            if (variantId === undefined) return null;
            const lineTotal =
              item.purchaseQty * item.purchasePrice -
              item.purchaseDiscount +
              item.purchaseTax;

            return (
              <tr key={variantId} className="align-middle">
                <td className="px-3 py-3">
                  <p className="max-w-40 truncate font-medium">{item.name}</p>
                  {variant.sku && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      SKU: {variant.sku}
                    </p>
                  )}
                  {buildVariantOptionsLabel(variant.options) !== "" && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {buildVariantOptionsLabel(variant.options)}
                    </p>
                  )}
                </td>
                <td className="px-2 py-2">
                  <PurchaseUnitSelect
                    variantId={variantId}
                    selectedConversionId={item.uomConversionId}
                    fallbackUnitName={item.unitName}
                    onSelect={(unit) => onUnitChange(variantId, unit)}
                  />
                </td>
                <td className="px-2 py-2">
                  <Input
                    aria-label={`${item.name} quantity`}
                    min="0.001"
                    step="0.001"
                    type="number"
                    value={item.purchaseQty}
                    onChange={(event) =>
                      onUpdateItem(
                        variantId,
                        "purchaseQty",
                        Number(event.target.value) || 0,
                      )
                    }
                    className="h-8 px-2"
                  />
                  <ConversionHintLine item={item} />
                </td>
                <td className="px-2 py-2">
                  <Input
                    aria-label={`${item.name} unit cost`}
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.purchasePrice}
                    onChange={(event) =>
                      onUpdateItem(
                        variantId,
                        "purchasePrice",
                        Number(event.target.value) || 0,
                      )
                    }
                    className="h-8 px-2"
                  />
                </td>
                <td className="px-2 py-2">
                  <Input
                    aria-label={`${item.name} discount`}
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.purchaseDiscount}
                    onChange={(event) =>
                      onUpdateItem(
                        variantId,
                        "purchaseDiscount",
                        Number(event.target.value) || 0,
                      )
                    }
                    className="h-8 px-2"
                  />
                </td>
                <td className="px-2 py-2">
                  <Input
                    aria-label={`${item.name} tax`}
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.purchaseTax}
                    onChange={(event) =>
                      onUpdateItem(
                        variantId,
                        "purchaseTax",
                        Number(event.target.value) || 0,
                      )
                    }
                    className="h-8 px-2"
                  />
                </td>
                <td className="whitespace-nowrap px-2 py-3 text-right font-medium">
                  {formatCurrency(lineTotal)}
                </td>
                <td className="px-2 py-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => onRemoveItem(variantId)}
                  >
                    <Trash2 className="text-muted-foreground" />
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The line's packaging-unit picker. Options come from the purchase-units
 * API (lazily, per variant); until it resolves the select shows the line's
 * current unit read-only value.
 */
function PurchaseUnitSelect({
  variantId,
  selectedConversionId,
  fallbackUnitName,
  onSelect,
}: {
  variantId: number;
  selectedConversionId: number | null;
  fallbackUnitName: string;
  onSelect: (unit: {
    uomConversionId: number | null;
    unitName: string;
    conversionFactor: number;
    defaultPurchasePrice: number | null;
  }) => void;
}) {
  const unitsQuery = usePurchaseUnits(variantId);
  const units = unitsQuery.data?.units;
  const baseUnitName = unitsQuery.data?.baseUnit?.name ?? null;

  return (
    <select
      aria-label="Packaging unit"
      value={selectedConversionId === null ? "base" : String(selectedConversionId)}
      onChange={(event) => {
        if (!units) return;
        const next =
          event.target.value === "base"
            ? units[0]
            : units.find((unit) => String(unit.uomConversionId) === event.target.value);
        if (!next) return;
        onSelect({
          uomConversionId: next.uomConversionId,
          unitName: next.unitName,
          conversionFactor: next.conversionFactor,
          defaultPurchasePrice: next.defaultPurchasePrice,
        });
      }}
      disabled={!units || units.length <= 1}
      title={
        units && units.length <= 1
          ? "This product has no packaging units configured"
          : undefined
      }
      className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
    >
      {units ? (
        units.map((unit) => (
          <option
            key={unit.uomConversionId ?? "base"}
            value={unit.uomConversionId === null ? "base" : String(unit.uomConversionId)}
          >
            {unitOptionLabel(unit, baseUnitName)}
          </option>
        ))
      ) : (
        <option value={selectedConversionId === null ? "base" : String(selectedConversionId)}>
          {fallbackUnitName}
        </option>
      )}
    </select>
  );
}

/** "5 Box = 60 pc" — display-only client math (the server is authoritative). */
function ConversionHintLine({ item }: { item: PurchaseCart }) {
  const unitsQuery = usePurchaseUnits(item.variants[0]?.id ?? null);
  const baseUnitName =
    unitsQuery.data?.baseUnit?.name ??
    (item.uomConversionId === null ? item.unitName : null);
  const hint = formatConversionHint({
    enteredQuantity: item.purchaseQty,
    unitName: item.unitName,
    conversionFactor: item.conversionFactor,
    baseUnitName,
  });
  if (!hint) return null;
  return (
    <span className="mt-1 block text-xs text-muted-foreground" data-testid="conversion-hint">
      {hint}
    </span>
  );
}
