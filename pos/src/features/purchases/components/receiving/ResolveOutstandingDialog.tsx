import { useState } from "react";
import { CircleCheckIcon } from "lucide-react";
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
import { toast } from "@/components/ui/toast";
import { formatCurrency } from "../../utils/formatCurrency";
import { outstandingOf } from "../../utils/receiveQuantities";
import type {
  OutstandingResolution,
  PurchasesItems,
} from "../../purchase.types";
import { useResolveOutstanding } from "../../hooks/usePurchaseDiscrepancies";

const RESOLUTION_OPTIONS: {
  value: OutstandingResolution;
  label: string;
  description: string;
}[] = [
  {
    value: "receive_later",
    label: "Receive later",
    description: "Another receiving session is expected for this line.",
  },
  {
    value: "backordered",
    label: "Keep on backorder",
    description: "The outstanding quantity stays owed by the supplier.",
  },
  {
    value: "cancel",
    label: "Cancel outstanding",
    description:
      "Write the quantity off — excluded from outstanding and removed from the payable.",
  },
];

/**
 * Short-receiving resolution (Phase 3 API) for one line: record what
 * happens to the outstanding quantity. Cancelling reduces the payable and
 * completes the line; nothing is ever silently cancelled.
 */
export function ResolveOutstandingDialog({ item }: { item: PurchasesItems }) {
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState<OutstandingResolution>("receive_later");
  const [quantity, setQuantity] = useState(outstandingOf(item));
  const [reason, setReason] = useState("");
  const resolve = useResolveOutstanding(item.purchaseId);
  const outstanding = outstandingOf(item);

  if (outstanding <= 0) return null;

  const submit = async () => {
    const trimmed = quantity > outstanding ? outstanding : quantity;
    try {
      const result = await resolve.mutateAsync({
        items: [
          {
            purchaseItemId: item.id,
            quantity: Math.max(0, Math.floor(trimmed)),
            resolution,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          },
        ],
      });
      const cancelled = result.data.cancelledValue;
      toast.add({
        type: "success",
        description:
          cancelled > 0
            ? `Outstanding resolved — payable reduced by ৳ ${formatCurrency(cancelled)}.`
            : "Outstanding resolution recorded.",
      });
      setOpen(false);
      setReason("");
    } catch (error) {
      const message =
        (error as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "Unable to resolve the outstanding quantity.";
      toast.add({ type: "error", description: message, priority: "high" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button nativeButton={false} size="sm" variant="ghost">
            Resolve…
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resolve outstanding quantity</DialogTitle>
          <DialogDescription>
            {item.variantName || item.productName} — {outstanding} outstanding
            of {item.quantity} ordered.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="space-y-2">
            {RESOLUTION_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 has-data-[checked=true]:border-primary"
                data-checked={resolution === option.value}
              >
                <input
                  type="radio"
                  name={`resolution-${item.id}`}
                  checked={resolution === option.value}
                  onChange={() => setResolution(option.value)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <label className="block space-y-1 font-medium">
            Quantity to resolve
            <Input
              type="number"
              min={0}
              max={outstanding}
              step={1}
              value={quantity}
              disabled={resolution !== "cancel"}
              onChange={(event) =>
                setQuantity(
                  Math.min(
                    outstanding,
                    Math.max(0, Number(event.target.value) || 0),
                  ),
                )
              }
            />
            <span className="block text-xs font-normal text-muted-foreground">
              {resolution === "cancel"
                ? "Cancelled quantities are written off and reduce the payable."
                : "Receive-later and backordered keep the full outstanding quantity."}
            </span>
          </label>

          <label className="block space-y-1 font-medium">
            Reason{" "}
            <span className="font-normal text-muted-foreground">(recorded)</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              maxLength={300}
              placeholder="Why is this quantity being resolved?"
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
            />
          </label>
        </div>

        <DialogFooter>
          <Button
            type="button"
            disabled={resolve.isPending || quantity <= 0}
            onClick={submit}
          >
            <CircleCheckIcon />
            {resolve.isPending ? "Recording…" : "Record resolution"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
