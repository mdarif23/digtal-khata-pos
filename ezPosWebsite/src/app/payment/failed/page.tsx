import type { Metadata } from "next";
import { Suspense } from "react";
import { PaymentOutcomePage } from "@/components/payment/payment-outcome";

export const metadata: Metadata = {
  title: "Payment failed",
  description: "Your ezPos payment did not go through.",
  robots: { index: false },
};

export default function PaymentFailedPage() {
  return (
    <Suspense>
      <PaymentOutcomePage outcome="failed" />
    </Suspense>
  );
}
