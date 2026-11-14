import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { useCreateSupplierWarranty } from "../hooks/useSupplierWarranties";

const DURATION_UNITS = [
  { value: "month", label: "Months" },
  { value: "year", label: "Years" },
  { value: "day", label: "Days" },
] as const;

const supplierWarrantySchema = z.object({
  purchaseItemId: z
    .string()
    .min(1, "Enter the purchase item this warranty covers.")
    .regex(/^\d+$/, "Purchase item ID must be a number."),
  duration: z
    .string()
    .min(1, "Enter the duration the supplier committed to.")
    .regex(/^\d+$/, "Duration must be a whole number."),
  durationUnit: z.enum(["month", "year", "day"]),
  provider: z.string().trim().max(120).optional(),
  terms: z.string().trim().max(2000).optional(),
});

type SupplierWarrantyFormValues = z.infer<typeof supplierWarrantySchema>;

interface AddSupplierWarrantyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Registers a supplier-side warranty against a purchase item line
 * (POST /supplier-warranties). Defect claims against it are tracked from
 * the Supplier Claims page.
 */
export function AddSupplierWarrantyDialog({
  open,
  onOpenChange,
}: AddSupplierWarrantyDialogProps) {
  const [serverError, setServerError] = useState("");
  const create = useCreateSupplierWarranty();

  const form = useForm<SupplierWarrantyFormValues>({
    resolver: zodResolver(supplierWarrantySchema),
    defaultValues: {
      purchaseItemId: "",
      duration: "",
      durationUnit: "month",
      provider: "",
      terms: "",
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError("");
    try {
      const created = await create.mutateAsync({
        purchaseItemId: Number(values.purchaseItemId),
        duration: Number(values.duration),
        durationUnit: values.durationUnit,
        ...(values.provider?.trim() ? { provider: values.provider.trim() } : {}),
        ...(values.terms?.trim() ? { terms: values.terms.trim() } : {}),
      });
      toast.add({
        type: "success",
        title: "Supplier warranty registered",
        description: `${created.productName} — ${created.duration} ${created.durationUnit}(s).`,
      });
      form.reset();
      onOpenChange(false);
    } catch (error) {
      const message = getErrorMessage(error);
      setServerError(message);
      toast.add({
        type: "error",
        title: "Could not register the warranty",
        description: message,
      });
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setServerError("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add supplier warranty</DialogTitle>
          <DialogDescription>
            Record the warranty a supplier gave you on a purchase item.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-3" onSubmit={onSubmit} noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="supplier-warranty-purchase-item">
              Purchase item ID
            </Label>
            <Input
              id="supplier-warranty-purchase-item"
              type="number"
              min="1"
              placeholder="The purchase line this warranty covers"
              {...form.register("purchaseItemId")}
            />
            {form.formState.errors.purchaseItemId && (
              <p className="text-xs text-destructive">
                {form.formState.errors.purchaseItemId.message}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="supplier-warranty-duration">Duration</Label>
              <Input
                id="supplier-warranty-duration"
                type="number"
                min="1"
                placeholder="e.g. 12"
                {...form.register("duration")}
              />
              {form.formState.errors.duration && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.duration.message}
                </p>
              )}
            </div>
            <Controller
              name="durationUnit"
              control={form.control}
              render={({ field }) => (
                <div className="space-y-1.5">
                  <Label>Unit</Label>
                  <Select
                    value={field.value}
                    onValueChange={(value) =>
                      field.onChange(value as SupplierWarrantyFormValues["durationUnit"])
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DURATION_UNITS.map((unit) => (
                        <SelectItem key={unit.value} value={unit.value}>
                          {unit.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="supplier-warranty-provider">Provider (optional)</Label>
            <Input
              id="supplier-warranty-provider"
              placeholder="Who honours it — e.g. the brand distributor"
              {...form.register("provider")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="supplier-warranty-terms">Terms (optional)</Label>
            <Textarea
              id="supplier-warranty-terms"
              rows={3}
              placeholder="What the supplier committed to cover…"
              {...form.register("terms")}
            />
          </div>

          {serverError && (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {serverError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              )}
              Register warranty
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
