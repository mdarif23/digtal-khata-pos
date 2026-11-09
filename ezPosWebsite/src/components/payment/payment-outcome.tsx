"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Container } from "@/components/ui/container";
import { reportPaymentOutcome } from "@/lib/api/portal";

/**
 * Best-effort outcome reporting: the gateway redirected here with the
 * payment id — tell the backend this payment failed so it is not left
 * pending if the IPN is lost. Fire-and-forget; the page stays informational
 * either way (the user may not have a live session on this device).
 */
function ReportOutcome({ outcome }: { outcome: "failed" | "canceled" }) {
  const params = useSearchParams();
  useEffect(() => {
    const paymentId = Number(params.get("paymentId"));
    const businessId = Number(params.get("businessId"));
    if (paymentId > 0 && businessId > 0) {
      void reportPaymentOutcome(businessId, paymentId, outcome).catch(
        () => undefined,
      );
    }
  }, [params, outcome]);
  return null;
}

export function PaymentOutcomePage({ outcome }: { outcome: "failed" | "canceled" }) {
  const title = outcome === "failed" ? "Payment failed" : "Payment canceled";
  const description =
    outcome === "failed"
      ? "Your ezPos payment did not go through."
      : "Your ezPos payment was canceled — nothing was charged.";
  return (
    <Container className="py-16">
      <ReportOutcome outcome={outcome} />
      <div className="mx-auto max-w-xl space-y-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
          {title}
        </h1>
        <Alert tone="warning" title={title}>
          {description} If you were charged or believe this is an error, contact
          support with your invoice number before retrying.
        </Alert>
        <div className="flex justify-center gap-3">
          <Link
            href="/account/billing"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Back to billing
          </Link>
          <Link
            href="/account/support"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Contact support
          </Link>
        </div>
      </div>
    </Container>
  );
}
