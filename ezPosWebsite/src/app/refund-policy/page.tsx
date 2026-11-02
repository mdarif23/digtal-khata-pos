import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Refund Policy",
  description:
    "How cancellations, downgrades, and refunds work for ezPos subscriptions.",
};

export default function RefundPolicyPage() {
  return (
    <LegalPage
      title="Refund Policy"
      updated="October 31, 2026"
      intro="This policy explains how cancellations, downgrades, and refunds work for ezPos subscriptions. It forms part of our Terms and Conditions."
      sections={[
        {
          heading: "Cancelling a subscription",
          paragraphs: [
            "You can cancel a paid subscription at any time from your account settings. Cancelling stops the next renewal; you keep full access until the end of the period you have already paid for.",
            "We do not charge cancellation fees.",
          ],
        },
        {
          heading: "Refunds",
          paragraphs: [
            "Monthly plans: if you cancel within 7 days of a payment and have not used the service meaningfully in that period, contact us and we will refund that payment in full. After that, the paid period runs to its end and does not renew.",
            "Yearly plans: the same 7-day full-refund window applies after each renewal payment. After the window, a yearly plan can be cancelled with the remaining period kept active until its end.",
            "Approved refunds are returned through the original payment method. Depending on the payment provider, it can take 5–10 business days for the amount to appear.",
          ],
        },
        {
          heading: "Failed and duplicate payments",
          paragraphs: [
            "If a payment was charged twice or charged after your subscription was already cancelled, contact us — we will verify it against our payment records and refund the excess in full.",
            "If a payment fails, we will retry and notify you. You will have a grace period to complete payment before the subscription is suspended; no refund is involved in a failed payment.",
          ],
        },
        {
          heading: "Trials",
          paragraphs: [
            "Free trials carry no charge and no payment information up front, so there is nothing to refund. If you subscribe at the end of a trial, the normal refund terms above apply to that first payment.",
          ],
        },
        {
          heading: "How to request a refund",
          paragraphs: [
            "Send a request through the contact page with the email address on the account and the approximate date of the payment. We review requests within two business days and confirm the outcome by email.",
            "Refunds are decided by the terms on this page — they are not discretionary — except where consumer-protection law requires otherwise.",
          ],
        },
      ]}
    />
  );
}
