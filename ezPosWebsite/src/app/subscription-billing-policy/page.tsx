import { LegalPage } from "@/components/legal/legal-page";
import { publicMetadata } from "@/lib/seo";

export const metadata = publicMetadata(
  "/subscription-billing-policy",
  "Subscription and Billing Policy",
  "How ezPos subscriptions are billed: plan changes, proration, renewals, failed payments, and suspensions.",
);

export default function SubscriptionBillingPolicyPage() {
  return (
    <LegalPage
      title="Subscription and Billing Policy"
      updated="November 2, 2026"
      intro="This policy explains how billing works for ezPos subscriptions: billing periods, plan changes, renewals, and what happens when a payment fails. It forms part of our Terms and Conditions and Refund Policy."
      sections={[
        {
          heading: "Billing periods",
          paragraphs: [
            "Subscriptions are billed monthly or yearly, starting on the day you subscribe. Your invoice shows the exact period covered. The renewal date is always visible in your account under Account → Subscription.",
          ],
        },
        {
          heading: "Plan changes",
          paragraphs: [
            "Upgrades take effect immediately. You are charged the prorated difference for the remainder of the current period, and the new plan's features unlock right away.",
            "Downgrades are scheduled for the end of the current period: you keep the higher plan's features until the period you paid for ends, then move to the lower plan. Downgraded time is not credited, and the change is visible in your subscription history before it takes effect.",
            "While on a free trial, switching plans is free and does not start billing — the trial continues as-is.",
          ],
        },
        {
          heading: "Renewals",
          paragraphs: [
            "Subscriptions renew automatically at the end of each period unless you cancel. An invoice is issued for the new period, and a renewal reminder is emailed a few days before.",
            "Renewing an order manually (Account → Subscription → Renew now) issues the same invoice and extends your period — useful after a failed payment.",
          ],
        },
        {
          heading: "Failed payments and suspension",
          paragraphs: [
            "If a renewal payment fails, your account enters a short grace period during which everything still works. We retry and email you. If the grace period lapses without payment, the subscription is suspended and the account becomes read-only — your data is never deleted.",
            "Signing in and paying from the billing page reactivates a suspended account immediately; no support contact is needed.",
          ],
        },
        {
          heading: "Cancellation",
          paragraphs: [
            "You can cancel at period end (keep access until the period you paid for) or immediately (read-only right away) from Account → Subscription. Cancelling stops all future invoices. See the Refund Policy for refund terms.",
          ],
        },
        {
          heading: "Price changes",
          paragraphs: [
            "If plan prices change, existing subscriptions keep their current price until the end of their paid period; renewal notices will show any new price before it is charged.",
          ],
        },
        {
          heading: "Questions",
          paragraphs: [
            "Billing questions can be raised through Account → Support or the contact page — include your invoice number for the fastest answer.",
          ],
        },
      ]}
    />
  );
}
