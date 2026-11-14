import { ClipboardList } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import type { PurchaseDetailItem } from "../../purchase.types";
import {
  estimateReturnUnitPrice,
  maxReturnableForItem,
} from "../../utils/returnCalculations";
import {
  enteredToBaseQuantity,
  roundQuantity,
  unitCostFromBase,
  unitOptionLabel,
} from "../../utils/uom";
import type {
  PurchaseUnitOption,
} from "../../hooks/usePurchaseUnits";
import { AvailableStockIndicator } from "./AvailableStockIndicator";
import { ReturnQuantityInput } from "./ReturnQuantityInput";

/**
 * Eligible return lines: only received units still in stock can be
 * returned. The unit cost shown is the client's per-unit credit ESTIMATE —
 * the server credits actual batch costs (FIFO) and its total is displayed
 * after processing.
 *
 * UOM (migration 0062): each line's return quantity is entered in its
 * SELECTED packaging unit (defaulting to the PO line's unit); the server
 * base figures are converted to that unit (floored) for display only.
 */
export function ReturnItemsTable({
  orderItems,
  returnedByItem,
  returnQuantities,
  lineCredits,
  serialsByItem,
  unitsByVariant,
  resolveLineUnit,
  onUnitChange,
  selectedSerials,
  onToggleSerial,
  onQuantityChange,
}: {
  /** Detail lines with availableStock already overridden to the RECEIVING
   *  location's stock (Phase 1) — never the caller's active location. */
  orderItems: PurchaseDetailItem[];
  returnedByItem: Map<number, number>;
  /** Per-line quantities in each line's SELECTED unit. */
  returnQuantities: Record<number, number>;
  /** Phase 2: server-authoritative per-line credits from the return
   *  preview. Absent for a line = the preview has not caught up; the
   *  estimate column shows the fallback and is marked with a footnote. */
  lineCredits?: Map<number, number>;
  /** Phase 5: eligible serials per serial-tracked line (picker data). */
  serialsByItem?: Map<number, { id: number; serialNumber: string }[]>;
  /** UOM (migration 0062): purchase-unit options per variant (fetched only
   *  for lines ordered in a packaging unit). */
  unitsByVariant: Map<number, PurchaseUnitOption[]>;
  /** The line's selected unit (defaults to the PO line's entered unit). */
  resolveLineUnit: (item: PurchaseDetailItem) => {
    conversionId: number | null;
    unit: PurchaseUnitOption | null;
  };
  onUnitChange: (item: PurchaseDetailItem, unit: PurchaseUnitOption) => void;
  /** Phase 5: the caller's selected serial ids per line. */
  selectedSerials?: Map<number, number[]>;
  onToggleSerial?: (
    item: PurchaseDetailItem,
    serialId: number,
    checked: boolean,
  ) => void;
  onQuantityChange: (item: PurchaseDetailItem, value: number) => void;
}) {
  if (orderItems.length === 0) {
    return (
      <div className="p-8 text-center">
        <ClipboardList className="mx-auto size-9 text-muted-foreground/50" />
        <p className="mt-3 font-medium">No items on this order</p>
      </div>
    );
  }

  // Phase 4: a variant may span several lines (scans fill them in order) —
  // label the rows so the user can see which line received a unit.
  const linesPerVariant = new Map<number, number>();
  for (const item of orderItems) {
    linesPerVariant.set(
      item.variantId,
      (linesPerVariant.get(item.variantId) ?? 0) + 1,
    );
  }
  const lineIndexByItem = new Map<number, number>();
  const variantSeen = new Map<number, number>();
  for (const item of orderItems) {
    if ((linesPerVariant.get(item.variantId) ?? 0) > 1) {
      const index = (variantSeen.get(item.variantId) ?? 0) + 1;
      variantSeen.set(item.variantId, index);
      lineIndexByItem.set(item.id, index);
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1020px] text-left text-sm">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Product</th>
            <th className="w-44 px-3 py-3 font-medium">Unit</th>
            <th className="px-3 py-3 text-right font-medium">Ordered</th>
            <th className="px-3 py-3 text-right font-medium">Received</th>
            <th className="px-3 py-3 text-right font-medium">Returned</th>
            <th className="px-3 py-3 font-medium">Available stock</th>
            <th className="w-32 px-3 py-3 font-medium">Return qty</th>
            <th className="px-4 py-3 text-right font-medium">Unit cost*</th>
            <th className="px-4 py-3 text-right font-medium">Return total</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {orderItems.map((item) => {
            const returned = returnedByItem.get(item.id) ?? 0;
            const { conversionId, unit } = resolveLineUnit(item);
            const factor = unit?.conversionFactor ?? 1;
            const unitName = unit?.unitName ?? item.productUnit ?? "units";
            const baseUnitName = item.productUnit ?? "units";
            const serialLocked = item.trackingType === "serial";
            // Sibling selections are converted to base before the
            // variant-wide stock cap (quantities are held per line unit).
            const selectedForVariant = orderItems.reduce(
              (sum, otherItem) =>
                otherItem.variantId === item.variantId &&
                otherItem.id !== item.id
                  ? sum +
                    enteredToBaseQuantity(
                      returnQuantities[otherItem.id] ?? 0,
                      resolveLineUnit(otherItem).unit?.conversionFactor ?? 1,
                    )
                  : sum,
              0,
            );
            const availableStock = Math.max(
              0,
              Number(item.availableStock ?? 0) - selectedForVariant,
            );
            const maxReturnBase = maxReturnableForItem(
              item,
              returned,
              selectedForVariant,
            );
            const maxReturn = Math.floor(
              roundQuantity(maxReturnBase / factor),
            );
            const quantity = returnQuantities[item.id] ?? 0;
            const unitPrice = estimateReturnUnitPrice(item);
            const authoritativeCredit = lineCredits?.get(item.id);
            const orderedLabel =
              item.enteredQuantity != null
                ? `${item.enteredQuantity} ${item.productUnit ?? ""}`.trim()
                : String(item.quantity);
            const orderedBaseHint =
              item.enteredQuantity != null &&
              Number(item.conversionFactor) !== 1
                ? `= ${item.quantity} ${baseUnitName}`
                : null;
            return (
              <tr key={item.id}>
                <td className="px-4 py-3">
                  <p className="font-medium">
                    {item.variantName || item.productName}
                    {lineIndexByItem.has(item.id) && (
                      <span
                        className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                        data-testid={`return-line-${item.id}`}
                      >
                        Line {lineIndexByItem.get(item.id)}
                      </span>
                    )}
                  </p>
                  {item.variantOptions && item.variantName ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.productName} · {item.variantOptions}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.trackingType} tracking
                  </p>
                </td>
                <td className="px-3 py-2">
                  {serialLocked ? (
                    <span
                      className="text-muted-foreground"
                      title="Serial-tracked items are returned per piece in the base unit."
                    >
                      {baseUnitName}
                      <span className="mt-0.5 block text-xs text-muted-foreground/80">
                        Base unit (serials)
                      </span>
                    </span>
                  ) : (() => {
                    const units = unitsByVariant.get(item.variantId);
                    if (!units || units.length <= 1) {
                      return (
                        <span className="text-muted-foreground">
                          {unitName}
                        </span>
                      );
                    }
                    return (
                      <select
                        aria-label={`${item.variantName || item.productName} unit`}
                        value={conversionId === null ? "base" : String(conversionId)}
                        onChange={(event) => {
                          const next =
                            event.target.value === "base"
                              ? (units[0] ?? null)
                              : (units.find(
                                  (option) =>
                                    String(option.uomConversionId) ===
                                    event.target.value,
                                ) ?? null);
                          if (next) onUnitChange(item, next);
                        }}
                        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                      >
                        {units.map((option) => (
                          <option
                            key={option.uomConversionId ?? "base"}
                            value={
                              option.uomConversionId === null
                                ? "base"
                                : String(option.uomConversionId)
                            }
                          >
                            {unitOptionLabel(option, units[0]?.unitName)}
                          </option>
                        ))}
                      </select>
                    );
                  })()}
                </td>
                <td className="px-3 py-3 text-right">
                  {orderedLabel}
                  {orderedBaseHint && (
                    <span className="block text-xs text-muted-foreground">
                      {orderedBaseHint}
                    </span>
                  )}
                </td>
                <td className="px-3 py-3 text-right">
                  {item.receivedQuantity}
                  <span className="block text-xs text-muted-foreground">
                    {baseUnitName}
                  </span>
                </td>
                <td className="px-3 py-3 text-right">
                  {returned}
                  <span className="block text-xs text-muted-foreground">
                    {baseUnitName}
                  </span>
                </td>
                <td className="px-3 py-3">
                  <AvailableStockIndicator
                    availableStock={availableStock}
                    maxReturn={maxReturnBase}
                  />
                </td>
                <td className="px-3 py-2">
                  <ReturnQuantityInput
                    value={quantity}
                    maxReturn={maxReturn}
                    unitName={factor !== 1 ? unitName : undefined}
                    label={`Return quantity for ${item.variantName || item.productName}`}
                    disabled={maxReturn <= 0}
                    onChange={(value) => onQuantityChange(item, value)}
                  />
                  {factor !== 1 && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      1 {unitName} = {factor} {baseUnitName}
                    </span>
                  )}
                  {item.trackingType === "serial" &&
                    (serialsByItem?.get(item.id)?.length ?? 0) > 0 && (
                      <fieldset
                        className="mt-2 space-y-1"
                        data-testid={`serial-picker-${item.id}`}
                      >
                        <legend className="text-xs text-muted-foreground">
                          Select the serial numbers ({quantity} of{" "}
                          {serialsByItem!.get(item.id)!.length})
                        </legend>
                        {serialsByItem!.get(item.id)!.map((serial) => (
                          <label
                            key={serial.id}
                            className="flex items-center gap-1.5 text-xs"
                          >
                            <input
                              type="checkbox"
                              className="size-3.5"
                              checked={
                                selectedSerials?.get(item.id)?.includes(
                                  serial.id,
                                ) ?? false
                              }
                              onChange={(event) =>
                                onToggleSerial?.(
                                  item,
                                  serial.id,
                                  event.target.checked,
                                )
                              }
                            />
                            <span className="font-mono">
                              {serial.serialNumber}
                            </span>
                          </label>
                        ))}
                      </fieldset>
                    )}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  {formatCurrency(unitCostFromBase(unitPrice, factor))}
                  <span className="block text-xs text-muted-foreground">
                    per {unitName}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-medium">
                  ৳{" "}
                  {formatCurrency(
                    authoritativeCredit ??
                      quantity * unitCostFromBase(unitPrice, factor),
                  )}
                  {authoritativeCredit === undefined && quantity > 0 ? (
                    <span className="text-muted-foreground">*</span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t px-4 py-2 text-xs text-muted-foreground">
        * Shown while the server preview catches up: the final credit uses
        each unit&apos;s actual batch cost (FIFO), not the line estimate.
      </p>
    </div>
  );
}
