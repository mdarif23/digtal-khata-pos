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
  useApproveWarrantyClaim,
  useCancelWarrantyClaim,
  useCloseWarrantyClaim,
  useInspectWarrantyClaim,
  usePickupWarrantyClaim,
  useReadyWarrantyClaim,
  useRejectWarrantyClaim,
  useReplaceWarrantyClaim,
  useStaffOptions,
  useUpdateWarrantyRepair,
} from "../hooks/useWarrantyClaims";
import { CLAIM_TRANSITION_LABELS } from "../lib/warranty-format";

const actionFormSchema = z
  .object({
    inspectionNotes: z.string().trim().max(2000).optional(),
    receivedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a valid date.")
      .optional(),
    assignedUserId: z.string().optional(),
    note: z.string().trim().max(500).optional(),
    resolutionNotes: z.string().trim().max(2000).optional(),
    repairDescription: z.string().trim().max(2000).optional(),
    partsUsed: z.string().trim().max(500).optional(),
    repairCost: z.string().optional(),
    replacementVariantId: z.string().optional(),
    replacementSerialNumber: z.string().trim().max(120).optional(),
  })
  .superRefine((values, ctx) => {
    if (values.repairCost && !Number.isFinite(Number(values.repairCost))) {
      ctx.addIssue({
        code: "custom",
        path: ["repairCost"],
        message: "Enter a valid amount.",
      });
    }
  });

type ActionFormValues = z.infer<typeof actionFormSchema>;

/** Field layout per transition — one dialog renders whichever fields the
 *  chosen transition needs (all optional unless the backend requires them). */
const FIELDS_BY_TRANSITION: Record<string, string[]> = {
  under_inspection: ["inspectionNotes", "receivedDate"],
  approved: ["inspectionNotes", "assignedUserId", "note"],
  rejected: ["resolutionNotes"],
  repairing: [
    "repairDescription",
    "partsUsed",
    "repairCost",
    "assignedUserId",
    "note",
  ],
  waiting_parts: ["repairDescription", "partsUsed", "repairCost", "note"],
  replaced: ["replacementVariantId", "replacementSerialNumber", "note"],
};

const CONFIRM_ONLY = new Set(["ready_for_pickup", "closed", "cancelled"]);

const DESCRIPTIONS: Record<string, string> = {
  under_inspection:
    "Record the intake inspection notes — this moves the claim into inspection.",
  approved: "Approve the claim and optionally assign a technician.",
  rejected: "Reject the claim — a resolution note explaining why is required.",
  repairing: "Log repair progress, parts used and the internal repair cost.",
  waiting_parts: "Park the claim while waiting for spare parts.",
  replaced: "Record the replacement variant given to the customer.",
  ready_for_pickup:
    "The item is repaired and ready for the customer to pick up.",
  closed: "Close the claim once the customer has collected the item.",
  cancelled: "Cancel this claim. This cannot be undone.",
};

const EMPTY_VALUES: ActionFormValues = {};

interface ClaimActionDialogProps {
  claimId: number;
  /** Transition key from allowedTransitions, or null when closed. */
  transition: string | null;
  onClose: () => void;
}

export function ClaimActionDialog({
  claimId,
  transition,
  onClose,
}: ClaimActionDialogProps) {
  const [serverError, setServerError] = useState("");
  const staff = useStaffOptions();

  const inspect = useInspectWarrantyClaim();
  const approve = useApproveWarrantyClaim();
  const reject = useRejectWarrantyClaim();
  const repair = useUpdateWarrantyRepair();
  const ready = useReadyWarrantyClaim();
  const pickup = usePickupWarrantyClaim();
  const replace = useReplaceWarrantyClaim();
  const close = useCloseWarrantyClaim();
  const cancel = useCancelWarrantyClaim();

  const form = useForm<ActionFormValues>({
    resolver: zodResolver(actionFormSchema),
    defaultValues: EMPTY_VALUES,
  });

  useEffect(() => {
    if (transition) {
      setServerError("");
      form.reset(EMPTY_VALUES);
    }
  }, [transition, form]);

  const isPending =
    inspect.isPending ||
    approve.isPending ||
    reject.isPending ||
    repair.isPending ||
    ready.isPending ||
    pickup.isPending ||
    replace.isPending ||
    close.isPending ||
    cancel.isPending;

  const open = transition !== null;
  const fields = transition ? (FIELDS_BY_TRANSITION[transition] ?? []) : [];
  const show = (name: string) => fields.includes(name);

  const optional = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };

  /** Dispatches one transition; returns false (with errors set) on failure. */
  const runTransition = async (
    key: string,
    values: ActionFormValues,
  ): Promise<boolean> => {
    try {
      switch (key) {
        case "under_inspection": {
          const inspectionNotes = optional(values.inspectionNotes);
          await inspect.mutateAsync({
            claimId,
            body: {
              ...(inspectionNotes ? { inspectionNotes } : {}),
              ...(values.receivedDate
                ? { receivedDate: values.receivedDate }
                : {}),
            },
          });
          return true;
        }
        case "approved": {
          const inspectionNotes = optional(values.inspectionNotes);
          const assignedUserId = values.assignedUserId
            ? Number(values.assignedUserId)
            : undefined;
          const note = optional(values.note);
          await approve.mutateAsync({
            claimId,
            body: {
              ...(inspectionNotes ? { inspectionNotes } : {}),
              ...(assignedUserId !== undefined ? { assignedUserId } : {}),
              ...(note ? { note } : {}),
            },
          });
          return true;
        }
        case "rejected": {
          const resolutionNotes = optional(values.resolutionNotes);
          if (!resolutionNotes) {
            form.setError("resolutionNotes", {
              message: "A resolution note is required to reject a claim.",
            });
            return false;
          }
          await reject.mutateAsync({ claimId, body: { resolutionNotes } });
          return true;
        }
        case "repairing":
        case "waiting_parts": {
          const repairDescription = optional(values.repairDescription);
          const partsUsed = optional(values.partsUsed);
          const repairCost = values.repairCost
            ? Number(values.repairCost)
            : undefined;
          const assignedUserId = values.assignedUserId
            ? Number(values.assignedUserId)
            : undefined;
          const note = optional(values.note);
          await repair.mutateAsync({
            claimId,
            body: {
              status: key,
              ...(repairDescription ? { repairDescription } : {}),
              ...(partsUsed ? { partsUsed } : {}),
              ...(repairCost !== undefined && Number.isFinite(repairCost)
                ? { repairCost }
                : {}),
              ...(assignedUserId !== undefined ? { assignedUserId } : {}),
              ...(note ? { note } : {}),
            },
          });
          return true;
        }
        case "ready_for_pickup":
          await ready.mutateAsync({ claimId });
          return true;
        case "replaced": {
          const variantId = Number(values.replacementVariantId);
          if (!values.replacementVariantId || !Number.isInteger(variantId)) {
            form.setError("replacementVariantId", {
              message: "The replacement variant ID is required.",
            });
            return false;
          }
          const replacementSerialNumber = optional(
            values.replacementSerialNumber,
          );
          const note = optional(values.note);
          await replace.mutateAsync({
            claimId,
            body: {
              replacementVariantId: variantId,
              ...(replacementSerialNumber ? { replacementSerialNumber } : {}),
              ...(note ? { note } : {}),
            },
          });
          return true;
        }
        case "closed":
          await close.mutateAsync({ claimId });
          return true;
        case "cancelled":
          await cancel.mutateAsync({ claimId });
          return true;
        default:
          return false;
      }
    } catch (error) {
      const message = getErrorMessage(error);
      setServerError(message);
      toast.add({ type: "error", title: "Action failed", description: message });
      return false;
    }
  };

  const finish = (key: string) => {
    toast.add({
      type: "success",
      title: `Claim updated — ${CLAIM_TRANSITION_LABELS[key] ?? key}`,
    });
    form.reset(EMPTY_VALUES);
    onClose();
  };

  // Form transitions (inspection/approval/reject/repair/replacement).
  const onFormSubmit = form.handleSubmit(async (values) => {
    if (!transition) return;
    if (await runTransition(transition, values)) {
      finish(transition);
    }
  });

  // One-click transitions (ready/pickup/close/cancel) need no form values.
  const onConfirmOnly = async () => {
    if (!transition) return;
    if (await runTransition(transition, EMPTY_VALUES)) {
      finish(transition);
    }
  };

  const isConfirmOnly = CONFIRM_ONLY.has(transition ?? "");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {transition ? (CLAIM_TRANSITION_LABELS[transition] ?? transition) : ""}
          </DialogTitle>
          <DialogDescription>
            {transition ? (DESCRIPTIONS[transition] ?? "") : ""}
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
            {show("inspectionNotes") && (
              <div className="space-y-1.5">
                <Label htmlFor="claim-inspection-notes">Inspection notes</Label>
                <Textarea
                  id="claim-inspection-notes"
                  rows={3}
                  placeholder="What did the inspection find?"
                  {...form.register("inspectionNotes")}
                />
              </div>
            )}
            {show("receivedDate") && (
              <div className="space-y-1.5">
                <Label htmlFor="claim-received-date">Item received on</Label>
                <Input
                  id="claim-received-date"
                  type="date"
                  {...form.register("receivedDate")}
                />
                {form.formState.errors.receivedDate && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.receivedDate.message}
                  </p>
                )}
              </div>
            )}
            {show("assignedUserId") && (
              <Controller
                name="assignedUserId"
                control={form.control}
                render={({ field }) => (
                  <div className="space-y-1.5">
                    <Label htmlFor="claim-assignee">Assign technician</Label>
                    <Select
                      value={field.value ?? ""}
                      onValueChange={(value) =>
                        field.onChange(value === "none" ? "" : value)
                      }
                    >
                      <SelectTrigger id="claim-assignee" className="w-full">
                        <SelectValue placeholder="Unassigned" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Unassigned</SelectItem>
                        {(staff.data ?? []).map((member) => (
                          <SelectItem
                            key={member.userId}
                            value={String(member.userId)}
                          >
                            {member.fullName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {(staff.data ?? []).length === 0 && !staff.isFetching && (
                      <p className="text-xs text-muted-foreground">
                        Staff list unavailable — leave unassigned.
                      </p>
                    )}
                  </div>
                )}
              />
            )}
            {show("resolutionNotes") && (
              <div className="space-y-1.5">
                <Label htmlFor="claim-resolution-notes">Resolution note</Label>
                <Textarea
                  id="claim-resolution-notes"
                  rows={3}
                  placeholder="Why is this claim being rejected?"
                  {...form.register("resolutionNotes")}
                />
                {form.formState.errors.resolutionNotes && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.resolutionNotes.message}
                  </p>
                )}
              </div>
            )}
            {show("repairDescription") && (
              <div className="space-y-1.5">
                <Label htmlFor="claim-repair-description">
                  Repair description
                </Label>
                <Textarea
                  id="claim-repair-description"
                  rows={3}
                  placeholder="What work is being done?"
                  {...form.register("repairDescription")}
                />
              </div>
            )}
            {show("partsUsed") && (
              <div className="space-y-1.5">
                <Label htmlFor="claim-parts-used">Parts used</Label>
                <Input
                  id="claim-parts-used"
                  placeholder="e.g. Speaker module x1"
                  {...form.register("partsUsed")}
                />
              </div>
            )}
            {show("repairCost") && (
              <div className="space-y-1.5">
                <Label htmlFor="claim-repair-cost">
                  Internal repair cost (BDT)
                </Label>
                <Input
                  id="claim-repair-cost"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  {...form.register("repairCost")}
                />
                {form.formState.errors.repairCost && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.repairCost.message}
                  </p>
                )}
              </div>
            )}
            {show("replacementVariantId") && (
              <div className="space-y-1.5">
                <Label htmlFor="claim-replacement-variant">
                  Replacement variant ID
                </Label>
                <Input
                  id="claim-replacement-variant"
                  type="number"
                  min="1"
                  placeholder="Variant given to the customer"
                  {...form.register("replacementVariantId")}
                />
                {form.formState.errors.replacementVariantId && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.replacementVariantId.message}
                  </p>
                )}
              </div>
            )}
            {show("replacementSerialNumber") && (
              <div className="space-y-1.5">
                <Label htmlFor="claim-replacement-serial">
                  Replacement serial number
                </Label>
                <Input
                  id="claim-replacement-serial"
                  placeholder="Serial of the replacement unit"
                  {...form.register("replacementSerialNumber")}
                />
              </div>
            )}
            {show("note") && (
              <div className="space-y-1.5">
                <Label htmlFor="claim-note">Note (optional)</Label>
                <Textarea id="claim-note" rows={2} {...form.register("note")} />
              </div>
            )}

            {serverError && (
              <p
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
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
