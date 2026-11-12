import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useWatch, type UseFormReturn } from "react-hook-form";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { PurchasesItems } from "../../purchase.types";
import type {
  ReceiveItemsFormValues,
} from "../../schemas/receiveItem.schema";

/**
 * Per-line supplier warranty capture (migration 0064) — optional and
 * additive: a line receives fine without it. Saving writes the full
 * warranty object into the form state at `items.<index>.warranty`, which
 * flows through the receive mutation payload unchanged; "Remove" clears the
 * field so nothing is sent.
 */

const PROVIDER_ITEMS = [
  { value: "supplier", label: "Supplier" },
  { value: "manufacturer", label: "Manufacturer" },
  { value: "distributor", label: "Distributor" },
  { value: "seller", label: "Seller" },
  { value: "third_party", label: "Third party" },
] as const;

const UNIT_ITEMS = [
  { value: "months", label: "Months" },
  { value: "days", label: "Days" },
  { value: "years", label: "Years" },
] as const;

type WarrantyValue = NonNullable<
  ReceiveItemsFormValues["items"][number]["warranty"]
>;

function durationLabel(warranty: WarrantyValue): string {
  const unit =
    warranty.durationUnit.charAt(0).toUpperCase() +
    warranty.durationUnit.slice(1);
  return `${warranty.duration} ${unit}`;
}

export function WarrantyDialog({
  item,
  form,
  index,
}: {
  item: PurchasesItems;
  form: UseFormReturn<ReceiveItemsFormValues>;
  index: number;
}) {
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState("");
  const [durationUnit, setDurationUnit] = useState<"days" | "months" | "years">(
    "months",
  );
  const [provider, setProvider] = useState<
    (typeof PROVIDER_ITEMS)[number]["value"]
  >("supplier");
  const [terms, setTerms] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const current = useWatch({
    control: form.control,
    name: `items.${index}.warranty`,
  });

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      // Sync the fields with whatever is on the line right now.
      const value = form.getValues(`items.${index}.warranty`);
      setDuration(value ? String(value.duration) : "");
      setDurationUnit(value?.durationUnit ?? "months");
      setProvider(value?.provider ?? "supplier");
      setTerms(value?.terms ?? "");
      setFormError(null);
    }
  }

  function handleSave() {
    setFormError(null);
    const parsed = Number(duration);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 360) {
      setFormError("Duration must be a whole number between 1 and 360.");
      return;
    }
    const warranty: WarrantyValue = {
      duration: parsed,
      durationUnit,
      provider,
      terms: terms.trim() === "" ? null : terms.trim(),
    };
    form.setValue(`items.${index}.warranty`, warranty, {
      shouldValidate: true,
      shouldDirty: true,
    });
    setOpen(false);
  }

  function handleRemove() {
    form.setValue(`items.${index}.warranty`, undefined, {
      shouldDirty: true,
    });
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant={current ? "outline" : "ghost"}
            size="sm"
            className="hover:cursor-pointer"
          >
            <ShieldCheck
              className={current ? "text-emerald-600" : undefined}
              aria-hidden="true"
            />
            {current ? `Warranty: ${durationLabel(current)}` : "Warranty"}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Supplier warranty</DialogTitle>
          <DialogDescription>
            {item.variantName || item.productName} · Optional — record the
            warranty terms the supplier grants on the received goods. The start
            date is this purchase's first receive date.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`warranty-duration-${index}`}>
              Duration
            </FieldLabel>
            <Input
              id={`warranty-duration-${index}`}
              type="number"
              min="1"
              max="360"
              step="1"
              placeholder="e.g. 12"
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`warranty-unit-${index}`}>Unit</FieldLabel>
            <Select
              items={UNIT_ITEMS}
              value={durationUnit}
              onValueChange={(value) =>
                setDurationUnit(value as "days" | "months" | "years")
              }
            >
              <SelectTrigger id={`warranty-unit-${index}`} className="w-full">
                <SelectValue placeholder="Select a unit" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {UNIT_ITEMS.map((unit) => (
                    <SelectItem key={unit.value} value={unit.value}>
                      {unit.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`warranty-provider-${index}`}>
              Provider
            </FieldLabel>
            <Select
              items={PROVIDER_ITEMS}
              value={provider}
              onValueChange={(value) =>
                setProvider(value as (typeof PROVIDER_ITEMS)[number]["value"])
              }
            >
              <SelectTrigger
                id={`warranty-provider-${index}`}
                className="w-full"
              >
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PROVIDER_ITEMS.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field>
              <FieldLabel htmlFor={`warranty-terms-${index}`}>
                Terms (optional)
              </FieldLabel>
              <Textarea
                id={`warranty-terms-${index}`}
                rows={3}
                maxLength={5000}
                placeholder="Coverage, exclusions, claim process…"
                value={terms}
                onChange={(event) => setTerms(event.target.value)}
              />
            </Field>
          </div>
        </div>

        {formError && (
          <p className="text-sm text-destructive" role="alert">
            {formError}
          </p>
        )}

        <DialogFooter className="sm:justify-between">
          {current ? (
            <Button type="button" variant="destructive" onClick={handleRemove}>
              Remove
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <DialogClose
              render={<Button type="button" variant="outline" />}
            >
              Cancel
            </DialogClose>
            <Button type="button" onClick={handleSave}>
              Save warranty
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
