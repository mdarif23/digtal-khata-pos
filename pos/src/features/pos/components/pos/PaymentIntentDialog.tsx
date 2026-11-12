import { useMemo, useState } from "react";
import { getErrorMessage } from "@/utils/getErrorMessage";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { createPaymentIntentApi } from "../../sales.api.js";

const tk = (n: number) => `৳${n.toFixed(2)}`;

/**
 * Collect an outstanding due through a verified electronic payment
 * (Module 3 architecture): creates a payment intent server-side, sends the
 * customer's browser to the provider's gateway, and the return handler
 * page (/payment/return) verifies the result before any money is recorded.
 * Never trusts a redirect — the backend re-verifies with the provider.
 */
export function PaymentIntentDialog({
  sale,
  open,
  onOpenChange,
}: {
  sale: {
    id: number;
    invoiceNumber: string;
    dueAmount: number;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const due = Math.max(0, Number(sale.dueAmount ?? 0));
  const [amount, setAmount] = useState<string>(due.toFixed(2));
  const [method, setMethod] = useState<"bangla_qr" | "card">("bangla_qr");
  const [provider, setProvider] = useState<"mock" | "sslcommerz">("mock");
  const [busy, setBusy] = useState(false);

  const parsedAmount = useMemo(() => Number(amount), [amount]);
  const valid =
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0 &&
    parsedAmount <= due + 0.01;

  async function start() {
    if (!valid) return;
    setBusy(true);
    try {
      const origin = window.location.origin;
      // The idempotency key doubles as the gateway tran_id — the provider's
      // redirect carries it back, so the return page can verify by tranId.
      const tranId = crypto.randomUUID();
      const intent = await createPaymentIntentApi(sale.id, {
        provider,
        method,
        amount: parsedAmount,
        idempotencyKey: tranId,
        redirectUrls: {
          success: `${origin}/payment/return?intent=success&tran=${encodeURIComponent(tranId)}`,
          fail: `${origin}/payment/return?intent=failed`,
          cancel: `${origin}/payment/return?intent=cancelled`,
        },
      });
      if (!intent.gatewayUrl) {
        toast.add({
          type: "error",
          description: "The provider did not return a payment page.",
          priority: "high",
        });
        return;
      }
      toast.add({
        type: "info",
        description: "Redirecting to the payment provider…",
        priority: "high",
      });
      // Same-tab redirect: the gateway sends the customer back to
      // /payment/return, which verifies server-side before recording.
      window.location.href = intent.gatewayUrl;
    } catch (err) {
      toast.add({
        type: "error",
        description:
          getErrorMessage(err),
        priority: "high",
      });
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Collect due — {sale.invoiceNumber}
          </DialogTitle>
          <DialogDescription>
            Outstanding due: {tk(due)}. The payment is verified with the
            provider before the sale is updated — a redirect alone never
            records money.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Amount</span>
            <Input
              type="number"
              min={0.01}
              max={due}
              step={0.01}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium">Method</span>
              <select
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={method}
                onChange={(e) =>
                  setMethod(e.target.value as "bangla_qr" | "card")
                }
              >
                <option value="bangla_qr">bKash / Nagad QR</option>
                <option value="card">Card (gateway page)</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Provider</span>
              <select
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={provider}
                onChange={(e) =>
                  setProvider(e.target.value as "mock" | "sslcommerz")
                }
              >
                <option value="mock">Sandbox (mock)</option>
                <option value="sslcommerz">SSLCommerz</option>
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !valid} onClick={() => void start()}>
              {busy ? "Starting…" : "Continue to payment"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
