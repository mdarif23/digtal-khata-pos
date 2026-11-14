import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { useCartStore } from "../../stores/useCartStore.js";
import { useCustomerStore } from "@/store/useCustomerStore.js";
import { useCartTotals, type CartTotalsView } from "./CartItems";
import { createQuotationApi } from "@/features/quotations/quotations.api.js";

const tk = (n: number) => `৳${n.toFixed(2)}`;

/**
 * "Save as quotation" (E1-002): the quotation backend (create/transition/
 * convert) was complete but nothing in the UI ever CREATED one — the whole
 * pipeline was unreachable. This captures the current cart as a quotation
 * draft; QuotationsPage handles the send/accept/convert lifecycle.
 *
 * Line discounts convert to money: the quotation item schema carries a
 * per-line money discount, the cart stores {percentage|fixed, value}.
 */
export function SaveQuotationDialog({
  open,
  onOpenChange,
  totals,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totals: CartTotalsView;
}) {
  const cart = useCartStore((s) => s.cart);
  const resetCart = useCartStore((s) => s.resetCart);
  const customer = useCustomerStore((s) => s.showCustomerInfo);
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const customerId = customer && customer.id > 0 ? customer.id : null;
  const customerName = customer?.name?.trim() || null;

  async function save() {
    if (cart.length === 0) return;
    setBusy(true);
    try {
      const quote = await createQuotationApi({
        customerId,
        customerNameSnapshot: customerName,
        items: cart.map((item) => {
          const unitPrice = Number(item.unitPrice ?? item.sellingPrice) || 0;
          let discount = 0;
          if (item.discount && item.discount.value > 0) {
            discount =
              item.discount.type === "percentage"
                ? (Number(item.quantity) * unitPrice * item.discount.value) / 100
                : item.discount.value;
          }
          return {
            variantId: item.variants[0]?.id ?? 0,
            quantity: Number(item.quantity),
            unitPrice,
            discount: Number(discount.toFixed(2)),
          };
        }),
        vatPercent: totals.vatPercent ?? 0,
        notes: notes.trim() || null,
        validUntil: validUntil || null,
      });
      toast.add({
        type: "success",
        description: `Quotation ${quote.quoteNumber} saved — manage it on the Quotations page.`,
        priority: "high",
      });
      resetCart();
      setValidUntil("");
      setNotes("");
      onOpenChange(false);
    } catch (err) {
      toast.add({
        type: "error",
        description: getErrorMessage(err),
        priority: "high",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as quotation</DialogTitle>
          <DialogDescription>
            {cart.length} line item{cart.length === 1 ? "" : "s"} for{" "}
            {customerName ?? "Walk-in customer"} — {tk(totals.finalTotal)}.
            The quotation lands on the Quotations page as a draft.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Valid until (optional)</span>
            <Input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Notes (optional)</span>
            <Input
              maxLength={2000}
              placeholder="Anything the customer should know"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={busy || cart.length === 0} onClick={() => void save()}>
              {busy ? "Saving…" : "Save quotation"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
