import { useState } from "react";
import { PurchasesItems } from "../../purchase.types";
import { Controller, useForm, useWatch, type UseFormReturn } from "react-hook-form";
import {
  batchSchema,
  BatchSchemaTypeInput,
  BatchSchemaTypeOutput,
} from "../../schemas/batch.schema";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { InputField } from "@/components/common/InputField";
import { Input } from "@/components/ui/input";
import { BatchDatePicker } from "./BatchDatePicker";
import { BatchListTable } from "./BatchListTable";
import { ReceiveItemsFormValues } from "../../schemas/receiveItem.schema";

export function BatchesDialog({
  item,
  form,
  index,
}: {
  item: PurchasesItems;
  form: UseFormReturn<ReceiveItemsFormValues>;
  index: number;
}) {
  const [open, setOpen] = useState(false);

  const batchForm = useForm<
    BatchSchemaTypeInput,
    unknown,
    BatchSchemaTypeOutput
  >({
    resolver: zodResolver(batchSchema),
    defaultValues: {
      batchNumber: "",
      quantity: 0,
      manufacturedDate: null,
      expiryDate: null,
    },
  });
  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      batchForm.reset();
    }
  }
  const receiveNow =
    useWatch({
      control: form.control,
      name: `items.${index}.receiveNow`,
    }) ?? 0;
  const currentBatches =
    useWatch({
      control: form.control,
      name: `items.${index}.batches`,
    }) ?? [];
  const batchTotal = currentBatches.reduce(
    (sum, batch) => sum + batch.quantity,
    0,
  );
  const remainingQuantity = Math.max(0, receiveNow - batchTotal);
  const batchError = form.formState.errors.items?.[index]?.batches?.message;

  function onSubmit(data: BatchSchemaTypeOutput) {
    if (data.quantity > remainingQuantity) {
      batchForm.setError("quantity", {
        type: "validate",
        message: `Only ${remainingQuantity} more can be assigned to this receipt.`,
      });
      return;
    }

    const existingBatches = form.getValues(`items.${index}.batches`) || [];
    form.setValue(`items.${index}.batches`, [...existingBatches, data], {
      shouldValidate: true,
      shouldDirty: true,
    });

    batchForm.reset();
  }
  const handleRemoveBatch = (batchIndex: number) => {
    const currentBatches = form.getValues(`items.${index}.batches`) || [];
    const updatedBatches = currentBatches.filter((_, i) => i !== batchIndex);
    form.setValue(`items.${index}.batches`, updatedBatches, {
      shouldValidate: true,
      shouldDirty: true,
    });
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button type="button" className="hover:cursor-pointer">
            Batches ({currentBatches.length})
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Batch Information</DialogTitle>
          <DialogDescription>
            {item.variantName || item.productName} · Assign {receiveNow} units across batches.{" "}
            {remainingQuantity} remaining.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <div className="flex gap-3">
            <InputField
              name="batchNumber"
              form={batchForm}
              fieldLabel="Batch Number"
              placeholder="Enter batch number"
            />
            <Controller
              name="quantity"
              control={batchForm.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={field.name}>Quantity</FieldLabel>
                  <Input
                    min={1}
                    max={remainingQuantity}
                    step="0.001"
                    id={field.name}
                    {...field}
                    type="number"
                    disabled={remainingQuantity === 0}
                    aria-label="Batch quantity"
                    value={field.value ?? ""}
                  />
                  {fieldState.error && (
                    <FieldError>{fieldState.error.message}</FieldError>
                  )}
                </Field>
              )}
            />
          </div>
          <div className="flex gap-3">
            <BatchDatePicker
              name="manufacturedDate"
              batchForm={batchForm}
              label="Manufactured Date"
            />
            <BatchDatePicker
              name="expiryDate"
              batchForm={batchForm}
              label="Expiry Date"
            />
          </div>
          <div className="flex justify-end">
              <Button
                type="button"
                disabled={remainingQuantity === 0}
                onClick={() => batchForm.handleSubmit(onSubmit)()}
              >
                Add Batch
              </Button>
          </div>
        </FieldGroup>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Batch list</h2>
              <p className="text-sm text-muted-foreground">
                {batchTotal} / {receiveNow} units assigned
              </p>
          </div>
          {batchError && (
              <p className="text-sm text-destructive" role="alert">
                {batchError}
              </p>
          )}
          <div className="overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
              {currentBatches.length > 0 ? (
                <BatchListTable
                  batchList={currentBatches}
                  handleRemoveBatch={handleRemoveBatch}
                />
              ) : (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  No batches added yet.
                </p>
              )}
          </div>
        </div>
        <DialogFooter>
          <DialogClose
            render={
              <Button type="button" variant="outline">
                Done
              </Button>
            }
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
