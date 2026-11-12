import type { Metadata } from "next";
import { Suspense } from "react";
import { PaymentOutcomePage } from "@/components/payment/payment-outcome";

export const metadata: Metadata = {
  title: "Payment canceled",
  description: "Your ezPos payment was canceled.",
  robots: { index: false },
};

export default function PaymentCanceledPage() {
  return (
    <Suspense>
      <PaymentOutcomePage outcome="canceled" />
    </Suspense>
  );
}
