import { useEffect, useState } from "react";
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
import {
  useCancelSupplierClaim,
  useCloseSupplierClaim,
  useRecoverSupplierClaim,
  useReplaceSupplierClaim,
  useRespondSupplierClaim,
} from "../hooks/useSupplierWarranties";
import {
  RECOVERY_METHOD_OPTIONS,
  SUPPLIER_RESPONSE_OPTIONS,
} from "../lib/warranty-format";

const supplierActionSchema = z
  .object({
    responseStatus: z.enum(["sent_to_supplier", "under_repair", "rejected"]),
    note: z.string().trim().max(500).optional(),
    replacementQuantity: z.string().optional(),
    replacementSerialNumbers: z.string().trim().max(2000).optional(),
    intake: z.enum(["none", "adjust"]),
    recoveryAmount: z.string().optional(),
    recoveryMethod: z.enum(["credit_note", "replacement", "cash"]),
    recoveryReferenceId: z.string().trim().max(120).optional(),
  })
  .superRefine((values, ctx) => {
    if (
      values.replacementQuantity !== undefined &&
      values.replacementQuantity !== "" &&
      (!Number.isInteger(Number(values.replacementQuantity)) ||
        Number(values.replacementQuantity) <= 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["replacementQuantity"],
        message: "Enter a positive whole quantity.",
      });
    }
    if (
      values.recoveryAmount !== undefined &&
      values.recoveryAmount !== "" &&
      !Number.isFinite(Number(values.recoveryAmount))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["recoveryAmount"],
        message: "Enter a valid amount.",
      });
    }
  });

type SupplierActionFormValues = z.infer<typeof supplierActionSchema>;

export type SupplierClaimAction =
  | "response"
  | "replacement"
  | "recovery"
  | "closed"
  | "cancelled";

const TITLES: Record<SupplierClaimAction, string> = {
  response: "Record supplier response",
  replacement: "Record replacement received",
  recovery: "Record recovery",
  closed: "Close claim",
  cancelled: "Cancel claim",
};

const DESCRIPTIONS: Record<SupplierClaimAction, string> = {
  response:
    "What did the supplier say — was the defective unit sent back, is it being repaired, or was it rejected?",
  replacement:
    "Record the replacement units received from the supplier and whether intake stock should be adjusted.",
  recovery:
    "How were you compensated — a credit note, free replacement units, or cash?",
  closed: "Close this claim. The action cannot be undone.",
  cancelled: "Cancel this claim. The action cannot be undone.",
};

const CONFIRM_ONLY = new Set<SupplierClaimAction>(["closed", "cancelled"]);

interface SupplierClaimActionDialogProps {
  claimId: number;
  /** Currently opened action, or null when the dialog is closed. */
  action: SupplierClaimAction | null;
  onClose: () => void;
}

export function SupplierClaimActionDialog({
  claimId,
  action,
  onClose,
}: SupplierClaimActionDialogProps) {
  const [serverError, setServerError] = useState("");

  const respond = useRespondSupplierClaim();
  const replace = useReplaceSupplierClaim();
  const recover = useRecoverSupplierClaim();
  const close = useCloseSupplierClaim();
  const cancel = useCancelSupplierClaim();

  const form = useForm<SupplierActionFormValues>({
    resolver: zodResolver(supplierActionSchema),
    defaultValues: {
      responseStatus: "sent_to_supplier",
      note: "",
      replacementQuantity: "",
      replacementSerialNumbers: "",
      intake: "none",
      recoveryAmount: "",
      recoveryMethod: "credit_note",
      recoveryReferenceId: "",
    },
  });

  useEffect(() => {
    if (action) {
      setServerError("");
      form.reset();
    }
  }, [action, form]);

  const isPending =
    respond.isPending ||
    replace.isPending ||
    recover.isPending ||
    close.isPending ||
    cancel.isPending;

  const show = (name: string) => {
    if (!action) return false;
    switch (action) {
      case "response":
        return name === "responseStatus" || name === "note";
      case "replacement":
        return (
          name === "replacementQuantity" ||
          name === "replacementSerialNumbers" ||
          name === "intake" ||
          name === "note"
        );
      case "recovery":
        return (
          name === "recoveryAmount" ||
          name === "recoveryMethod" ||
          name === "recoveryReferenceId" ||
          name === "note"
        );
      default:
        return false;
    }
  };

  const finish = (title: string) => {
    toast.add({ type: "success", title });
    form.reset();
    onClose();
  };

  const onConfirmOnly = async () => {
    if (!action) return;
    setServerError("");
    try {
      if (action === "closed") {
        await close.mutateAsync({ claimId });
      } else if (action === "cancelled") {
        await cancel.mutateAsync({ claimId });
      } else {
        return;
      }
      finish(TITLES[action]);
    } catch (error) {
      const message = getErrorMessage(error);
      setServerError(message);
      toast.add({ type: "error", title: "Action failed", description: message });
    }
  };

  const onFormSubmit = form.handleSubmit(async (values) => {
    if (!action) return;
    setServerError("");
    try {
      if (action === "response") {
        await respond.mutateAsync({
          claimId,
          body: {
            status: values.responseStatus,
            ...(values.note?.trim() ? { note: values.note.trim() } : {}),
          },
        });
      } else if (action === "replacement") {
        const quantity = Number(values.replacementQuantity);
        if (!values.replacementQuantity || !Number.isInteger(quantity) || quantity <= 0) {
          form.setError("replacementQuantity", {
            message: "A positive replacement quantity is required.",
          });
          return;
        }
        await replace.mutateAsync({
          claimId,
          body: {
            replacementQuantity: quantity,
            ...(values.replacementSerialNumbers?.trim()
              ? { replacementSerialNumbers: values.replacementSerialNumbers.trim() }
              : {}),
            intake: values.intake,
            ...(values.note?.trim() ? { note: values.note.trim() } : {}),
          },
        });
      } else if (action === "recovery") {
        const amount = Number(values.recoveryAmount);
        if (!values.recoveryAmount || !Number.isFinite(amount)) {
          form.setError("recoveryAmount", { message: "A recovery amount is required." });
          return;
        }
        await recover.mutateAsync({
          claimId,
          body: {
            recoveryAmount: amount,
            recoveryMethod: values.recoveryMethod,
            ...(values.recoveryReferenceId?.trim()
              ? { recoveryReferenceId: values.recoveryReferenceId.trim() }
              : {}),
            ...(values.note?.trim() ? { note: values.note.trim() } : {}),
          },
        });
      } else {
        return;
      }
      finish(TITLES[action]);
    } catch (error) {
      const message = getErrorMessage(error);
      setServerError(message);
      toast.add({ type: "error", title: "Action failed", description: message });
    }
  });

  const isConfirmOnly = action !== null && CONFIRM_ONLY.has(action);

  return (
    <Dialog
      open={action !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{action ? TITLES[action] : ""}</DialogTitle>
          <DialogDescription>
            {action ? DESCRIPTIONS[action] : ""}
          </DialogDescription>
        </DialogHeader>

        {isConfirmOnly ? (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Keep as is
            </Button>
            <Button type="button" onClick={() => void onConfirmOnly()} disabled={isPending}>
              {isPending && (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              )}
              Confirm
            </Button>
          </DialogFooter>
        ) : (
          <form className="space-y-3" onSubmit={onFormSubmit} noValidate>
            {show("responseStatus") && (
              <Controller
                name="responseStatus"
                control={form.control}
                render={({ field }) => (
                  <div className="space-y-1.5">
                    <Label>Supplier response</Label>
                    <Select
                      value={field.value}
                      onValueChange={(value) =>
                        field.onChange(
                          value as SupplierActionFormValues["responseStatus"],
                        )
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPLIER_RESPONSE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              />
            )}
            {show("replacementQuantity") && (
              <div className="space-y-1.5">
                <Label htmlFor="supplier-replacement-qty">
                  Replacement quantity
                </Label>
                <Input
                  id="supplier-replacement-qty"
                  type="number"
                  min="1"
                  placeholder="Units received back"
                  {...form.register("replacementQuantity")}
                />
                {form.formState.errors.replacementQuantity && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.replacementQuantity.message}
                  </p>
                )}
              </div>
            )}
            {show("replacementSerialNumbers") && (
              <div className="space-y-1.5">
                <Label htmlFor="supplier-replacement-serials">
                  Replacement serial numbers
                </Label>
                <Textarea
                  id="supplier-replacement-serials"
                  rows={2}
                  placeholder="Comma-separated serials of the replacement units"
                  {...form.register("replacementSerialNumbers")}
                />
              </div>
            )}
            {show("intake") && (
              <Controller
                name="intake"
                control={form.control}
                render={({ field }) => (
                  <div className="space-y-1.5">
                    <Label>Stock intake</Label>
                    <Select
                      value={field.value}
                      onValueChange={(value) =>
                        field.onChange(value as SupplierActionFormValues["intake"])
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">
                          No stock adjustment (resale/repair only)
                        </SelectItem>
                        <SelectItem value="adjust">
                          Adjust intake stock (add units back)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              />
            )}
            {show("recoveryAmount") && (
              <div className="space-y-1.5">
                <Label htmlFor="supplier-recovery-amount">Recovery amount (BDT)</Label>
                <Input
                  id="supplier-recovery-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  {...form.register("recoveryAmount")}
                />
                {form.formState.errors.recoveryAmount && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.recoveryAmount.message}
                  </p>
                )}
              </div>
            )}
            {show("recoveryMethod") && (
              <Controller
                name="recoveryMethod"
                control={form.control}
                render={({ field }) => (
                  <div className="space-y-1.5">
                    <Label>Recovery method</Label>
                    <Select
                      value={field.value}
                      onValueChange={(value) =>
                        field.onChange(
                          value as SupplierActionFormValues["recoveryMethod"],
                        )
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RECOVERY_METHOD_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              />
            )}
            {show("recoveryReferenceId") && (
              <div className="space-y-1.5">
                <Label htmlFor="supplier-recovery-reference">
                  Reference (optional)
                </Label>
                <Input
                  id="supplier-recovery-reference"
                  placeholder="Credit note / receipt number"
                  {...form.register("recoveryReferenceId")}
                />
              </div>
            )}
            {show("note") && (
              <div className="space-y-1.5">
                <Label htmlFor="supplier-action-note">Note (optional)</Label>
                <Textarea
                  id="supplier-action-note"
                  rows={2}
                  {...form.register("note")}
                />
              </div>
            )}

            {serverError && (
              <p
                className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
                role="alert"
              >
                {serverError}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending && (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                )}
                Confirm
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
