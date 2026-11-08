import { Controller, useWatch, type UseFormReturn } from "react-hook-form";
import { Minus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Field, FieldError } from "@/components/ui/field";
import type { PurchasesItems } from "../../purchase.types";
import type { ReceiveItemsFormValues } from "../../schemas/receiveItem.schema";
import {
  findUnitByConversionId,
  type PurchaseUnitOption,
} from "../../hooks/usePurchaseUnits";
import { unitOptionLabel } from "../../utils/uom";
import { SerialsDialog } from "./SerialsDialog";
import { BatchesDialog } from "./BatchesDialog";
import { ReceivingDiscrepancyDialog } from "../receiving/ReceivingDiscrepancyDialog";
import { ResolveOutstandingDialog } from "../receiving/ResolveOutstandingDialog";
import {
  outstandingOf,
  overReceiveInUnitOf,
} from "../../utils/receiveQuantities";

export function ItemsReceiveTable({
  receivePurchasesItems,
  form,
  unitsByVariant,
  onUnitChange,
}: {
  receivePurchasesItems: PurchasesItems[];
  form: UseFormReturn<ReceiveItemsFormValues>;
  /**
   * UOM (migration 0062): purchase-unit options per variant — populated only
   * for lines ordered in a packaging unit.
   */
  unitsByVariant: Map<number, PurchaseUnitOption[]>;
  onUnitChange: (
    index: number,
    item: PurchasesItems,
    unit: PurchaseUnitOption,
  ) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1100px] text-left text-sm">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Product</th>
            <th className="w-44 px-3 py-3 font-medium">Unit</th>
            <th className="px-3 py-3 text-right font-medium">Ordered</th>
            <th className="px-3 py-3 text-right font-medium">Received</th>
            <th className="px-3 py-3 text-right font-medium">Outstanding</th>
            <th className="w-28 px-3 py-3 font-medium">Receive now</th>
            <th className="w-28 px-3 py-3 font-medium">Unit cost</th>
            <th className="w-28 px-3 py-3 font-medium">Selling price</th>
            <th className="px-3 py-3 text-right font-medium">Total</th>
            <th className="px-4 py-3 font-medium">Tracking</th>
            <th className="px-4 py-3 font-medium">Discrepancy</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {receivePurchasesItems.map((item, index) => (
            <ReceiveItemRow
              key={item.id}
              item={item}
              index={index}
              form={form}
              units={unitsByVariant.get(item.variantId)}
              onUnitChange={onUnitChange}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReceiveItemRow({
  item,
  index,
  form,
  units,
  onUnitChange,
}: {
  item: PurchasesItems;
  index: number;
  form: UseFormReturn<ReceiveItemsFormValues>;
  units: PurchaseUnitOption[] | undefined;
  onUnitChange: (
    index: number,
    item: PurchasesItems,
    unit: PurchaseUnitOption,
  ) => void;
}) {
  const receiveNow =
    useWatch({
      control: form.control,
      name: `items.${index}.receiveNow`,
    }) ?? 0;
  const unitCost =
    useWatch({
      control: form.control,
      name: `items.${index}.unitCost`,
    }) ?? 0;
  const selectedConversionId = useWatch({
    control: form.control,
    name: `items.${index}.uomConversionId`,
  });
  // Serial-tracked lines are forced to the BASE unit: serials are per
  // piece, so a package unit can never describe one scanned serial.
  const serialLocked = item.trackingType === "serial";
  const baseUnit = units?.[0];
  const selectedUnit = findUnitByConversionId(units, selectedConversionId);
  const factor = serialLocked
    ? 1
    : (selectedUnit?.conversionFactor ?? (selectedConversionId == null ? 1 : (item.conversionFactor ?? 1)));
  const unitName = serialLocked
    ? (baseUnit?.unitName ?? item.productUnit ?? "units")
    : (selectedUnit?.unitName ?? item.productUnit ?? "units");
  // Outstanding excludes cancelled quantities (short-receiving write-offs).
  const outstanding = outstandingOf(item);
  const over = overReceiveInUnitOf(item, Number(receiveNow) || 0, factor);
  const rowTotal = (Number(receiveNow) || 0) * (Number(unitCost) || 0);
  const disabled = outstanding === 0;
  const serialError =
    form.formState.errors.items?.[index]?.serialNumbers?.message;
  const batchError =
    form.formState.errors.items?.[index]?.batches?.message;
  const orderedLabel =
    item.enteredQuantity != null
      ? `${item.enteredQuantity} ${item.productUnit ?? ""}`.trim()
      : String(item.quantity);
  const orderedBaseHint =
    item.enteredQuantity != null && Number(item.conversionFactor) !== 1
      ? `= ${item.quantity} ${item.productUnit ?? ""}`.trim()
      : null;

  return (
    <tr className="align-top">
      <td className="px-4 py-3">
        <p className="font-medium">
          {item.variantName || item.productName}
        </p>
        {item.variantOptions ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {item.variantOptions}
          </p>
        ) : null}
        {item.variantSku ? (
          <p className="text-xs text-muted-foreground">SKU: {item.variantSku}</p>
        ) : null}
      </td>
      <td className="px-3 py-2">
        {serialLocked ? (
          <span
            className="text-muted-foreground"
            title="Serial-tracked items are received per piece in the base unit."
          >
            {unitName}
            <span className="mt-0.5 block text-xs text-muted-foreground/80">
              Base unit (serials)
            </span>
          </span>
        ) : units && units.length > 1 ? (
          <select
            aria-label={`${item.variantName || item.productName} unit`}
            value={
              selectedConversionId == null
                ? "base"
                : String(selectedConversionId)
            }
            onChange={(event) => {
              const next =
                event.target.value === "base"
                  ? (units[0] ?? null)
                  : (units.find(
                      (unit) =>
                        String(unit.uomConversionId) === event.target.value,
                    ) ?? null);
              if (next) onUnitChange(index, item, next);
            }}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
          >
            {units.map((unit) => (
              <option
                key={unit.uomConversionId ?? "base"}
                value={
                  unit.uomConversionId === null
                    ? "base"
                    : String(unit.uomConversionId)
                }
              >
                {unitOptionLabel(unit, units[0]?.unitName)}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-muted-foreground">{unitName}</span>
        )}
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
          {item.productUnit ?? ""}
        </span>
      </td>
      <td className="px-3 py-3 text-right font-medium">
        {outstanding}
        <span className="block text-xs text-muted-foreground">
          {item.productUnit ?? ""}
        </span>
      </td>
      <td className="px-3 py-2">
        <NumberField
          form={form}
          name={`items.${index}.receiveNow`}
          label={`${item.variantName || item.productName} receive quantity`}
          disabled={disabled}
          min={0}
          max={outstanding + (over?.overQuantity ?? 0)}
          step={
            item.trackingType === "serial" || factor === 1 ? "1" : "0.001"
          }
        />
        {!serialLocked && factor !== 1 && (
          <span className="mt-1 block text-xs text-muted-foreground">
            1 {unitName} = {factor} {item.productUnit ?? "base units"}
          </span>
        )}
        {over && (
          <span className="mt-1 block text-xs text-amber-700">
            Over-receiving {over.overQuantity} {unitName} — reason required in
            Discrepancy…
          </span>
        )}
        {serialError && item.trackingType === "serial" && (
          <p className="mt-1 text-xs text-destructive">{serialError}</p>
        )}
        {batchError && item.trackingType === "batch" && (
          <p className="mt-1 text-xs text-destructive">{batchError}</p>
        )}
      </td>
      <td className="px-3 py-2">
        <NumberField
          form={form}
          name={`items.${index}.unitCost`}
          label={`${item.variantName || item.productName} unit cost`}
          disabled={disabled}
          min={0}
          step="0.01"
        />
        {!serialLocked && factor !== 1 && (
          <span className="mt-1 block text-xs text-muted-foreground">
            per {unitName}
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <NumberField
          form={form}
          name={`items.${index}.sellingPrice`}
          label={`${item.variantName || item.productName} selling price`}
          disabled={disabled}
          min={0}
          step="0.01"
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          per {item.productUnit ?? "unit"}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-right font-medium">
        {rowTotal.toFixed(2)}
      </td>
      <td className="px-4 py-2">
        <div className="mb-1">
          <ResolveOutstandingDialog item={item} />
        </div>
        {disabled ? (
          <span className="text-xs text-muted-foreground">Complete</span>
        ) : item.trackingType === "batch" ? (
          <div className="space-y-1">
            <BatchesDialog item={item} form={form} index={index} />
            {batchError && (
              <p className="max-w-36 text-xs text-destructive">{batchError}</p>
            )}
          </div>
        ) : item.trackingType === "serial" ? (
          <div className="space-y-1">
            <SerialsDialog item={item} form={form} index={index} />
            {serialError && (
              <p className="max-w-36 text-xs text-destructive">{serialError}</p>
            )}
          </div>
        ) : (
          <Minus className="size-4 text-muted-foreground" />
        )}
      </td>
      <td className="px-4 py-2">
        <ReceivingDiscrepancyDialog
          item={item}
          form={form}
          index={index}
          conversionFactor={factor}
          unitName={unitName}
        />
      </td>
    </tr>
  );
}

function NumberField({
  form,
  name,
  label,
  disabled,
  min,
  max,
  step,
}: {
  form: UseFormReturn<ReceiveItemsFormValues>;
  name:
    | `items.${number}.receiveNow`
    | `items.${number}.unitCost`
    | `items.${number}.sellingPrice`;
  label: string;
  disabled: boolean;
  min: number;
  max?: number;
  step: string;
}) {
  return (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <Input
            {...field}
            aria-label={label}
            aria-invalid={fieldState.invalid}
            disabled={disabled}
            min={min}
            max={max}
            step={step}
            type="number"
            value={field.value ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              field.onChange(value === "" ? 0 : Number(value));
            }}
            className="h-9"
          />
          {fieldState.error && (
            <FieldError>{fieldState.error.message}</FieldError>
          )}
        </Field>
      )}
    />
  );
}
