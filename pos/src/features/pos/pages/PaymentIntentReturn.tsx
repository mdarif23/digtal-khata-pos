import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button.js";
import { verifyPaymentIntentByTranApi } from "@/features/pos/sales.api.js";

/**
 * Gateway return handler. The provider redirects here after the customer
 * pays (or fails/cancels). A redirect NEVER records money — this page sends
 * the val_id to the backend, which re-verifies with the provider before the
 * sale's due is reduced.
 */
export function PaymentIntentReturn() {
  const [params] = useSearchParams();
  const [state, setState] = useState<"verifying" | "paid" | "already" | "failed" | "error">(
    "verifying",
  );
  const [message, setMessage] = useState("");
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const intent = params.get("intent");
    const valId = params.get("val_id") ?? params.get("valid");
    const tranId = params.get("tran");

    if (intent !== "success") {
      setState("failed");
      setMessage(
        intent === "cancelled"
          ? "The payment was cancelled. Nothing was recorded."
          : "The payment failed. Nothing was recorded — you can retry from the sale.",
      );
      return;
    }
    if (!valId || !tranId) {
      setState("error");
      setMessage(
        "The provider did not return a validation id. Check the payment status from the sale screen before retrying.",
      );
      return;
    }
    verifyPaymentIntentByTranApi(tranId, valId)
      .then((outcome) => {
        if (outcome.verified) {
          setState(outcome.alreadyCaptured ? "already" : "paid");
          setMessage(
            outcome.alreadyCaptured
              ? "This payment was already recorded."
              : "Payment verified and recorded against the sale.",
          );
        } else {
          setState("failed");
          setMessage(outcome.reason ?? "The payment could not be verified.");
        }
      })
      .catch(() => {
        setState("error");
        setMessage(
          "Verification could not be completed right now. The payment may still have succeeded — check the sale before retrying.",
        );
      });
  }, [params]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-6">
      <div className="w-full max-w-md rounded-xl border bg-background p-8 text-center shadow-sm">
        <div className="mb-3 text-4xl">
          {state === "verifying" && "⏳"}
          {state === "paid" && "✅"}
          {state === "already" && "✅"}
          {state === "failed" && "❌"}
          {state === "error" && "⚠️"}
        </div>
        <h1 className="text-lg font-semibold capitalize">
          {state === "verifying" ? "Verifying payment…" : state === "paid" || state === "already" ? "Payment received" : "Payment not completed"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <Button className="mt-6 w-full" onClick={() => (window.location.href = "/")}>
          Back to the register
        </Button>
      </div>
    </main>
  );
}
