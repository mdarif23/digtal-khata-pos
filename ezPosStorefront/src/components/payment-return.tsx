"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/format";

interface VerifyPaymentResult {
  paid: boolean;
  invoiceNumber: string;
  amount: number;
  message: string;
}

export function PaymentReturn({
  storefrontId,
  saleId,
  valId,
  outcome,
}: {
  storefrontId: number;
  saleId: number | null;
  valId: string | null;
  outcome: string | null;
}) {
  const [state, setState] = useState<
    { kind: "pending" } | { kind: "result"; result: VerifyPaymentResult } | { kind: "error"; message: string }
  >({ kind: "pending" });

  useEffect(() => {
    if (outcome === "fail" || outcome === "cancel") {
      setState({
        kind: "error",
        message:
          outcome === "cancel"
            ? "Payment cancelled — your order is saved and unpaid."
            : "The payment failed. You can try again from your order.",
      });
      return;
    }
    if (saleId === null || !valId) {
      setState({ kind: "error", message: "Missing payment details in the link." });
      return;
    }
    void (async () => {
      try {
        const res = await fetch("/api/pay/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storefrontId, saleId, valId }),
        });
        const body = (await res.json().catch(() => null)) as
          | { ok?: boolean; message?: string; data?: VerifyPaymentResult }
          | null;
        if (res.ok && body?.ok && body.data) {
          setState({ kind: "result", result: body.data });
        } else {
          setState({ kind: "error", message: body?.message ?? "Verification failed." });
        }
      } catch {
        setState({ kind: "error", message: "We could not reach the store. Try again." });
      }
    })();
  }, [outcome, saleId, valId, storefrontId]);

  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      {state.kind === "pending" ? (
        <p className="text-sm opacity-70" role="status">
          Verifying your payment…
        </p>
      ) : null}

      {state.kind === "result" && state.result.paid ? (
        <div className="sf-card p-8">
          <p className="text-3xl">✅</p>
          <h1 className="mt-2 text-xl font-bold">Payment successful</h1>
          <p className="mt-2 text-sm opacity-75">
            Order <span className="font-mono font-semibold">{state.result.invoiceNumber}</span>{" "}
            is confirmed — {formatPrice(state.result.amount)} paid.
          </p>
          <Link href="/account" className="sf-btn mt-6 inline-flex">
            View your orders
          </Link>
        </div>
      ) : null}

      {state.kind === "result" && !state.result.paid ? (
        <div className="sf-card p-8">
          <p className="text-3xl">⚠️</p>
          <h1 className="mt-2 text-xl font-bold">Payment not completed</h1>
          <p className="mt-2 text-sm opacity-75">{state.result.message}</p>
          <Link href="/orders/track" className="sf-btn mt-6 inline-flex">
            Track your order
          </Link>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="sf-card p-8">
          <p className="text-3xl">⚠️</p>
          <h1 className="mt-2 text-xl font-bold">Payment status</h1>
          <p className="mt-2 text-sm opacity-75">{state.message}</p>
          <Link href="/orders/track" className="sf-btn mt-6 inline-flex">
            Track your order
          </Link>
        </div>
      ) : null}
    </div>
  );
}
