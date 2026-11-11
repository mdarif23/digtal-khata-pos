import { useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { TriangleAlert, TriangleAlertIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "../../utils/formatCurrency";
import { formatQty } from "../../utils/uom";
import {
  outstandingOf,
  overReceiveInUnitOf,
} from "../../utils/receiveQuantities";
import type { PurchasesItems } from "../../purchase.types";
import type {
  ReceiveItemsFormValues,
  REJECTION_CATEGORIES,
} from "../../schemas/receiveItem.schema";

const CATEGORY_LABELS: Record<(typeof REJECTION_CATEGORIES)[number], string> = {
  damaged: "Damaged",
  incorrect: "Incorrect item",
  expired: "Expired",
  other: "Other",
};

/**
 * Per-line discrepancy details (Phase 5): the delivered/accepted/rejected
 * split and the over-receiving approval. Kept out of the main table — this
 * dialog carries everything the discrepancy workflow needs.
 *
 * UOM (migration 0062): quantities are entered in the line's SELECTED unit
 * (factor 1 = base), so the over-receive check converts to base and the
 * surplus is reported in the selected unit.
 */
export function ReceivingDiscrepancyDialog({
  item,
  form,
  index,
  conversionFactor = 1,
  unitName,
}: {
  item: PurchasesItems;
  form: UseFormReturn<ReceiveItemsFormValues>;
  index: number;
  /** The selected unit's factor (1 = base). */
  conversionFactor?: number;
  unitName?: string;
}) {
  const [open, setOpen] = useState(false);
  const receiveNow =
    useWatch({ control: form.control, name: `items.${index}.receiveNow` }) ?? 0;
  const rejectedQuantity =
    useWatch({
      control: form.control,
      name: `items.${index}.rejectedQuantity`,
    }) ?? 0;
  const rejectionCategory = useWatch({
    control: form.control,
    name: `items.${index}.rejectionCategory`,
  });
  const rejectionReason = useWatch({
    control: form.control,
    name: `items.${index}.rejectionReason`,
  });
  const overReceiveReason = useWatch({
    control: form.control,
    name: `items.${index}.overReceiveReason`,
  });

  const outstanding = outstandingOf(item);
  const over = overReceiveInUnitOf(
    item,
    Number(receiveNow) || 0,
    conversionFactor,
  );
  const unitSuffix = unitName ? ` ${unitName}` : "";
  const delivered = Number(receiveNow || 0) + Number(rejectedQuantity || 0);
  const rejectionValid =
    Number(rejectedQuantity) <= 0 ||
    (Boolean(rejectionCategory) && Boolean(rejectionReason?.trim()));
  const overValid = !over || Boolean(overReceiveReason?.trim());
  const canSave = rejectionValid && overValid;

  const save = () => {
    if (!canSave) return;
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            nativeButton={false}
            size="sm"
            variant={over || Number(rejectedQuantity) > 0 ? "outline" : "ghost"}
            className={
              over
                ? "border-amber-300 text-amber-700"
                : Number(rejectedQuantity) > 0
                  ? "border-rose-300 text-rose-700"
                  : "text-muted-foreground"
            }
          >
            {over ? (
              <>
                <TriangleAlert /> Over +{over.overQuantity}
              </>
            ) : Number(rejectedQuantity) > 0 ? (
              <>Rejected {rejectedQuantity}{unitSuffix}</>
            ) : (
              "Discrepancy…"
            )}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Discrepancy details</DialogTitle>
          <DialogDescription>
            {item.variantName || item.productName} — ordered{" "}
            {formatQty(item.quantity)} · received{" "}
            {formatQty(item.receivedQuantity)} · outstanding{" "}
            {formatQty(outstanding)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-3 text-center">
            <div>
              <p className="text-xs text-muted-foreground">Delivered</p>
              <p className="font-semibold">{delivered}{unitSuffix}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Accepted</p>
              <p className="font-semibold text-emerald-700">{receiveNow}{unitSuffix}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Rejected</p>
              <p className="font-semibold text-rose-700">{rejectedQuantity}{unitSuffix}</p>
            </div>
          </div>

          {over && (
            <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">
                  Over-receiving {over.overQuantity}
                  {unitName ?? " unit"}
                  {over.overQuantity === 1 ? "" : "s"}
                </p>
                <p className="mt-1 text-xs">
                  Beyond the outstanding {outstanding}. Over-receiving
                  requires a recorded reason and, above the business
                  tolerance, the purchases.over-receive permission — the
                  server rejects unapproved amounts.
                </p>
                <label className="mt-2 block space-y-1 font-medium">
                  Over-receiving reason
                  <textarea
                    value={overReceiveReason ?? ""}
                    onChange={(event) =>
                      form.setValue(
                        `items.${index}.overReceiveReason`,
                        event.target.value,
                        { shouldDirty: true },
                      )
                    }
                    rows={2}
                    maxLength={300}
                    placeholder="e.g. supplier shipped a full case"
                    className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
                  />
                </label>
              </div>
            </div>
          )}

          <div className="space-y-3 rounded-lg border p-3">
            <p className="font-medium">Rejected goods</p>
            <p className="text-xs text-muted-foreground">
              Refused at the dock — never stocked, valued, or payable.
            </p>
            <label className="block space-y-1 font-medium">
              Rejected quantity
              {unitName ? ` (${unitName})` : ""}
              <Input
                type="number"
                min={0}
                step={item.trackingType === "serial" ? "1" : "0.001"}
                value={rejectedQuantity}
                onChange={(event) =>
                  form.setValue(
                    `items.${index}.rejectedQuantity`,
                    Math.max(0, Number(event.target.value) || 0),
                    { shouldDirty: true },
                  )
                }
              />
            </label>
            {Number(rejectedQuantity) > 0 && (
              <>
                <label className="block space-y-1 font-medium">
                  Category
                  <select
                    value={rejectionCategory ?? ""}
                    onChange={(event) =>
                      form.setValue(
                        `items.${index}.rejectionCategory`,
                        event.target.value === ""
                          ? undefined
                          : (event.target
                              .value as ReceiveItemsFormValues["items"][number]["rejectionCategory"]),
                        { shouldDirty: true },
                      )
                    }
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Select a category…</option>
                    {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1 font-medium">
                  Reason
                  <textarea
                    value={rejectionReason ?? ""}
                    onChange={(event) =>
                      form.setValue(
                        `items.${index}.rejectionReason`,
                        event.target.value,
                        { shouldDirty: true },
                      )
                    }
                    rows={2}
                    maxLength={300}
                    placeholder="Condition, discrepancy, or reason for refusal"
                    className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
                  />
                </label>
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            disabled={!canSave}
            onClick={save}
          >
            Save discrepancy details
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
