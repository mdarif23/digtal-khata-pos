"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Clock, XCircle } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { verifyPayment } from "@/lib/api/portal";

type State =
  | { kind: "working" }
  | { kind: "verified"; already: boolean }
  | { kind: "pending"; reason?: string }
  | { kind: "failed"; message: string };

function PaymentSuccessInner() {
  const searchParams = useSearchParams();
  const [state, setState] = useState<State>({ kind: "working" });
  const [attempts, setAttempts] = useState(0);

  const paymentId = Number(searchParams.get("paymentId"));
  const businessId = Number(searchParams.get("businessId"));
  // The gateway appends its own params (val_id, tran_id, status).
  const valId = searchParams.get("val_id") ?? "";

  useEffect(() => {
    if (!Number.isInteger(paymentId) || paymentId <= 0 || !Number.isInteger(businessId)) {
      void (async () => {
        await Promise.resolve();
        setState({
          kind: "failed",
          message: "This link is missing its payment reference.",
        });
      })();
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await verifyPayment(businessId, paymentId, valId);
      if (cancelled) return;
      if (result.status === 0) {
        setState({ kind: "failed", message: result.message });
        return;
      }
      const outcome = result.data;
      if (outcome?.verified) {
        setState({ kind: "verified", already: outcome.alreadyVerified });
      } else if (!valId) {
        // No val_id yet — the gateway IPN may still be in flight.
        setState({ kind: "pending" });
      } else {
        setState({ kind: "pending", reason: outcome?.reason });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paymentId, businessId, valId, attempts]);

  if (state.kind === "working") {
    return (
      <p className="py-4 text-center text-sm text-slate-500" role="status">
        Checking your payment…
      </p>
    );
  }

  if (state.kind === "verified") {
    return (
      <div className="flex flex-col items-center py-4 text-center">
        <CheckCircle2 className="size-10 text-green-600" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-semibold text-slate-900">
          Payment confirmed
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          {state.already
            ? "This payment was already verified."
            : "Your payment was verified with the gateway and your subscription is active."}
        </p>
        <Button className="mt-6 w-full" onClick={() => window.location.assign("/account")}>
          Go to your account
        </Button>
      </div>
    );
  }

  if (state.kind === "pending") {
    return (
      <div className="flex flex-col items-center py-4 text-center">
        <Clock className="size-10 text-amber-500" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-semibold text-slate-900">
          Payment processing
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          The gateway has not confirmed this payment yet. Confirmation usually
          arrives within a minute — we will update your billing page as soon
          as it does.
        </p>
        {state.reason ? (
          <div className="mt-3 w-full text-left">
            <Alert tone="warning" title="Gateway note">
              {state.reason}
            </Alert>
          </div>
        ) : null}
        <Button
          variant="outline"
          className="mt-6 w-full"
          onClick={() => {
            setState({ kind: "working" });
            setAttempts((n) => n + 1);
          }}
        >
          Check again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center py-4 text-center">
      <XCircle className="size-10 text-red-500" aria-hidden="true" />
      <h1 className="mt-3 text-lg font-semibold text-slate-900">
        Payment not confirmed
      </h1>
      <p className="mt-2 text-sm text-slate-600">{state.message}</p>
      <Link
        href="/account/billing"
        className="mt-6 w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
      >
        Back to billing
      </Link>
    </div>
  );
}

export function PaymentSuccessContent() {
  return (
    <Suspense fallback={null}>
      <PaymentSuccessInner />
    </Suspense>
  );
}
