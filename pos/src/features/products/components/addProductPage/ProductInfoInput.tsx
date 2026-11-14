import { useEffect, useState } from "react";
import { Controller, useFieldArray } from "react-hook-form";
import { Barcode, Plus, Trash2 } from "lucide-react";
import { ProductInfoInputProps } from "../../product.types";
import { Field, FieldError, FieldLabel } from "@/components/ui/field.js";
import { InputField } from "./InputField";
import { ExpiryDatePicker } from "./ExpiryDatePicker";
import { InputFile } from "./InputFile";
import { variantStatus } from "../../constants/form-status";
import { SelectOptions } from "./SelectOptions";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ProductInfoInput({
  form,
  variantIndex,
  remove,
  canRemoveVariant = true,
  canEditImages = true,
  canEditStock = true,
  inventorySummary = null,
}: ProductInfoInputProps) {
  const [isPasteDialogOpen, setIsPasteDialogOpen] = useState(false);
  const [pastedSerials, setPastedSerials] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [serialNotice, setSerialNotice] = useState("");
  const serialFieldName = `variants.${variantIndex}.serialNumbers` as const;
  const {
    fields: serialFields,
    append: appendSerial,
    remove: removeSerial,
  } = useFieldArray({
    control: form.control,
    name: serialFieldName,
  });
  const hasVariants = form.watch("hasVariants");
  const source = form.watch("source");
  const trackingType = form.watch("trackingType");

  useEffect(() => {
    if (
      !canEditStock ||
      source !== "opening" ||
      trackingType !== "serial"
    ) {
      return;
    }

    form.setValue(`variants.${variantIndex}.quantity`, serialFields.length, {
      shouldDirty: true,
      shouldValidate: true,
    });
  }, [canEditStock, form, serialFields.length, source, trackingType, variantIndex]);

  const importSerials = () => {
    const serials = pastedSerials
      .split(/\r?\n/)
      .map((serial) => serial.trim())
      .filter(Boolean);
    const currentSerials =
      form.getValues(serialFieldName)?.map((item) => item.serial.trim()) ?? [];
    const existing = new Set(
      currentSerials.map((serial) => serial.toLocaleLowerCase()),
    );
    const additions: string[] = [];

    for (const serial of serials) {
      const normalized = serial.toLocaleLowerCase();
      if (existing.has(normalized)) continue;
      existing.add(normalized);
      additions.push(serial);
    }

    if (additions.length === 0) {
      setPasteError(
        serials.length === 0
          ? "Enter at least one serial number."
          : "All entered serial numbers are already in the list.",
      );
      return;
    }

    additions.forEach((serial) => appendSerial({ serial }));
    setSerialNotice(
      `Added ${additions.length} serial number${additions.length === 1 ? "" : "s"}${serials.length > additions.length ? "; duplicates were skipped." : "."}`,
    );
    setPastedSerials("");
    setPasteError("");
    setIsPasteDialogOpen(false);
  };

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
      {source === "opening" && (
        <InputField
          placeholder="0.00"
          label="Purchase price"
          type="number"
          name={`variants.${variantIndex}.purchasePrice`}
          form={form}
        />
      )}
      {!hasVariants && (
        <InputField
          placeholder="0.00"
          label="Selling price"
          type="number"
          name={`variants.${variantIndex}.sellingPrice`}
          form={form}
        />
      )}
      {source === "opening" && canEditStock && (
        <InputField
          disabled={trackingType === "serial"}
          numberFormat="quantity"
          placeholder="0"
          label="Opening quantity"
          type="number"
          name={`variants.${variantIndex}.quantity`}
          form={form}
        />
      )}
      <InputField
        numberFormat="quantity"
        placeholder="0"
        label="Low-stock alert quantity"
        type="number"
        name={`variants.${variantIndex}.alertQuantity`}
        form={form}
      />
      <InputField
        placeholder="Enter barcode"
        label="Barcode"
        type="text"
        name={`variants.${variantIndex}.barcode`}
        form={form}
      />
      <div>
        <FieldLabel className="text-sm">Weight</FieldLabel>
        <div className="mt-1 flex gap-2">
          <InputField
            placeholder="0.0000"
            label=""
            type="number"
            name={`variants.${variantIndex}.weight`}
            form={form}
          />
          <Controller
            control={form.control}
            name={`variants.${variantIndex}.weightUnit`}
            render={({ field }) => (
              <select
                aria-label="Weight unit"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={field.value ?? "kg"}
                onChange={(e) => field.onChange(e.target.value)}
              >
                <option value="kg">kg</option>
                <option value="g">g</option>
                <option value="lb">lb</option>
                <option value="oz">oz</option>
              </select>
            )}
          />
        </div>
      </div>
      {!canEditStock && inventorySummary && (
        <div className="md:col-span-2 lg:col-span-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-xs text-slate-600">
          <p className="font-semibold text-slate-700">
            Current inventory — {inventorySummary.totalStock} in stock across all locations
            {inventorySummary.serialCount > 0
              ? ` · ${inventorySummary.serialCount} serial number(s) in stock`
              : ""}
          </p>
          {inventorySummary.batches.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {inventorySummary.batches.map((batch) => (
                <li key={batch.batchNumber}>
                  Batch <span className="font-mono">{batch.batchNumber}</span> —{" "}
                  {batch.quantityRemaining} remaining
                  {batch.expiryDate ? ` · expires ${batch.expiryDate}` : ""}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-slate-400">
            Read-only — stock changes go through Stock Adjustment or stock counts.
          </p>
        </div>
      )}
      {source === "opening" && trackingType === "batch" && (
        <InputField
          placeholder="Enter batch number"
          label="Batch number"
          type="text"
          name={`variants.${variantIndex}.batchNumber`}
          form={form}
        />
      )}
      {!hasVariants && (
        <InputField
          placeholder="Auto-generated if blank"
          label="SKU"
          type="text"
          name={`variants.${variantIndex}.sku`}
          form={form}
        />
      )}
      {source === "opening" && trackingType === "batch" && (
        <ExpiryDatePicker form={form} index={variantIndex} />
      )}
      {hasVariants && canEditImages && (
        <InputFile
          urlName={`variants.${variantIndex}.imageUrl`}
          fileName={`variants.${variantIndex}.imageFile`}
          form={form}
          label="Variant image"
        />
      )}
      <SelectOptions
        options={variantStatus}
        label="Variant status"
        form={form}
        name={`variants.${variantIndex}.status`}
      />

      {canEditStock && trackingType === "serial" && source === "opening" && (
        <section
          aria-labelledby={`serials-heading-${variantIndex}`}
          className="space-y-3 rounded-lg border bg-background p-4 md:col-span-2 lg:col-span-3"
        >
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div className="space-y-1">
              <h3
                id={`serials-heading-${variantIndex}`}
                className="flex items-center gap-2 text-sm font-medium"
              >
                <Barcode className="size-4 text-muted-foreground" aria-hidden="true" />
                Serial numbers
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {serialFields.length}
                </span>
              </h3>
              <p className="text-xs text-muted-foreground">
                Opening quantity is calculated from the serial numbers listed
                here. Add one serial per unit.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setPasteError("");
                  setIsPasteDialogOpen(true);
                }}
              >
                Paste list
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => appendSerial({ serial: "" })}
              >
                <Plus aria-hidden="true" />
                Add serial
              </Button>
            </div>
          </div>

          {serialNotice && (
            <p className="text-sm text-success" role="status">
              {serialNotice}
            </p>
          )}

          {serialFields.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center">
              <p className="text-sm font-medium">No serial numbers yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add serials one at a time or paste a list on separate lines.
              </p>
            </div>
          ) : (
            <div className="grid max-h-80 grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
              {serialFields.map((serialField, serialIndex) => {
                const serialName =
                  `variants.${variantIndex}.serialNumbers.${serialIndex}.serial` as const;
                const serialId = `variant-${variantIndex}-serial-${serialIndex}`;

                return (
                  <Controller
                    key={serialField.id}
                    control={form.control}
                    name={serialName}
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid}>
                        <FieldLabel htmlFor={serialId}>
                          Serial number {serialIndex + 1}
                        </FieldLabel>
                        <div className="flex items-center gap-2">
                          <Input
                            {...field}
                            id={serialId}
                            aria-invalid={fieldState.invalid}
                            placeholder="e.g. IMEI12345678"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove serial number ${serialIndex + 1}`}
                            onClick={() => removeSerial(serialIndex)}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </div>
                        {fieldState.invalid && (
                          <FieldError errors={[fieldState.error]} />
                        )}
                      </Field>
                    )}
                  />
                );
              })}
            </div>
          )}
        </section>
      )}

      {hasVariants && canRemoveVariant && (
        <div className="flex justify-end md:col-span-2 lg:col-span-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => remove?.(variantIndex)}
          >
            <Trash2 aria-hidden="true" />
            Remove variant
          </Button>
        </div>
      )}

      <Dialog
        open={isPasteDialogOpen}
        onOpenChange={(open) => {
          setIsPasteDialogOpen(open);
          if (!open) setPasteError("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Paste serial numbers</DialogTitle>
            <DialogDescription>
              Paste one serial number per line. Blank lines and duplicates
              already in this variant will be skipped.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            aria-label="Serial numbers to import"
            value={pastedSerials}
            onChange={(event) => {
              setPastedSerials(event.target.value);
              setPasteError("");
            }}
            placeholder={"IMEI12345678\nIMEI12345679\nIMEI12345680"}
            rows={8}
          />
          {pasteError && (
            <p className="text-sm text-destructive" role="alert">
              {pasteError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsPasteDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button type="button" onClick={importSerials}>
              Add serials
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
