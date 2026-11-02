import type { Metadata } from "next";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/marketing/section-heading";
import { Alert } from "@/components/ui/alert";
import { PricingPlans } from "@/components/pricing/pricing-plans";
import { CtaBand } from "@/components/marketing/cta-band";
import { getSubscriptionPlans } from "@/lib/api/subscription-plans";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "ezPos subscription plans for retail shops — monthly and yearly options with user, location, and product limits.",
};

export default async function PricingPage() {
  const result = await getSubscriptionPlans();

  return (
    <>
      <section className="border-b border-slate-100 bg-slate-50 py-16 sm:py-20">
        <Container>
          <SectionHeading
            eyebrow="Pricing"
            title="Simple plans for every shop"
            description="Start small and grow. Every plan includes the full POS — billing, inventory, purchasing, and reports."
          />
        </Container>
      </section>

      <section aria-label="Subscription plans" className="py-16 sm:py-24">
        <Container>
          {result.status === "ok" ? (
            result.plans.length > 0 ? (
              <PricingPlans plans={result.plans} />
            ) : (
              <p
                role="status"
                className="mx-auto mt-4 max-w-xl rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500"
              >
                Our plans are being finalized. No public plans are available
                right now — check back soon.
              </p>
            )
          ) : (
            <Alert
              tone="warning"
              title="Pricing is temporarily unavailable"
              className="mx-auto max-w-xl"
            >
              We couldn&apos;t load the current plans from our servers. Please
              try again in a few minutes — this page updates automatically.
            </Alert>
          )}
          <p className="mt-10 text-center text-sm text-slate-500">
            Online payment is not available yet. When billing opens, you will
            be able to activate a plan from your account dashboard.
          </p>
        </Container>
      </section>

      <CtaBand
        title="Start with the POS that grows with you"
        description="Create your account when registration opens — until then, explore the features and see the direction."
      />
    </>
  );
}
