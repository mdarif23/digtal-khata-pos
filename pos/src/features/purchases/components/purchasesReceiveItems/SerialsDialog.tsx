import { useEffect, useState } from "react";
import { useWatch } from "react-hook-form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PurchasesItems } from "../../purchase.types";
import type { UseFormReturn } from "react-hook-form";
import type { ReceiveItemsFormValues } from "../../schemas/receiveItem.schema";

export function SerialsDialog({
  item,
  form,
  index,
}: {
  item: PurchasesItems;
  form: UseFormReturn<ReceiveItemsFormValues>;
  index: number;
}) {
  const [open, setOpen] = useState(false);

  const receiveNowValue = Number(
    useWatch({
      control: form.control,
      name: `items.${index}.receiveNow`,
    }),
  ) || 0;
  const receiveNow = Math.max(0, Math.floor(receiveNowValue));
  const serials =
    useWatch({
      control: form.control,
      name: `items.${index}.serialNumbers`,
    }) ?? [];
  const inputSlots = Array.from({ length: receiveNow }, (_, i) => i);
  const serialError =
    form.formState.errors.items?.[index]?.serialNumbers?.message;

  useEffect(() => {
    const currentSerials =
      form.getValues(`items.${index}.serialNumbers`) ?? [];
    if (currentSerials.length !== receiveNow) {
      form.setValue(
        `items.${index}.serialNumbers`,
        Array.from({ length: receiveNow }, (_, i) => currentSerials[i] ?? ""),
        { shouldValidate: true, shouldDirty: true },
      );
    }
  }, [form, index, receiveNow]);

  const enteredCount = serials.filter((serial) => serial.trim().length > 0).length;
  const updateSerial = (serialIndex: number, value: string) => {
    const updatedSerials = Array.from(
      { length: receiveNow },
      (_, i) => serials[i] ?? "",
    );
    updatedSerials[serialIndex] = value;
    form.setValue(`items.${index}.serialNumbers`, updatedSerials, {
      shouldValidate: true,
      shouldDirty: true,
    });
  };
  const clearSerials = () => {
    form.setValue(
      `items.${index}.serialNumbers`,
      Array.from({ length: receiveNow }, () => ""),
      { shouldValidate: true, shouldDirty: true },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" className="hover:cursor-pointer">
            Serials ({enteredCount}/{receiveNow})
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Serial Numbers</DialogTitle>
          <DialogDescription>
            {item.variantName || item.productName} · Enter one serial number for each unit received.
          </DialogDescription>
        </DialogHeader>
        {serialError && (
          <p className="text-sm font-medium text-destructive bg-red-50 border border-red-200 p-2 rounded-md">
            {serialError}
          </p>
        )}
        {receiveNowValue !== receiveNow && (
          <p className="text-sm text-destructive">
            Serial-tracked quantities must be whole numbers.
          </p>
        )}
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">
            {enteredCount} of {receiveNow} serial numbers entered
          </p>
          {enteredCount > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={clearSerials}>
              Clear all
            </Button>
          )}
        </div>
        <div className="max-h-[400px] overflow-y-auto space-y-3 py-2">
          {receiveNow === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Enter a receive quantity to add serial numbers.
            </p>
          ) : (
            inputSlots.map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Label
                  htmlFor={`serial-${item.id}-${i}`}
                  className="w-20 text-muted-foreground"
                >
                  Serial {i + 1}
                </Label>
                <Input
                  id={`serial-${item.id}-${i}`}
                  type="text"
                  placeholder={`Scan or type serial #${i + 1}`}
                  autoComplete="off"
                  value={serials[i] ?? ""}
                  onChange={(e) => updateSerial(i, e.target.value)}
                />
              </div>
            ))
          )}
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
