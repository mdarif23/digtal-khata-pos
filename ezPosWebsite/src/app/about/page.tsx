import { Check } from "lucide-react";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/marketing/section-heading";
import { CtaBand } from "@/components/marketing/cta-band";
import { publicMetadata } from "@/lib/seo";

export const metadata = publicMetadata(
  "/about",
  "About us",
  "Why ezPos exists: to give small and medium retailers in Bangladesh the tools that used to be reserved for large chains — accurate stock, clear accounts, and honest reports.",
);

const principles = [
  {
    title: "The records must match the shelf",
    description:
      "A POS you cannot trust is worse than a paper khata. Every stock movement — purchases, sales, refunds, adjustments — is recorded and auditable, so the numbers you see are the numbers on your shelf.",
  },
  {
    title: "Built for the counter, not the conference room",
    description:
      "The billing screen is designed for speed during rush hour: search, sell, done. Depth lives where you need it — reports, ledgers, and inventory — not in your way at the register.",
  },
  {
    title: "Simple enough to run alone, strong enough for a team",
    description:
      "One person can run ezPos on day one. As you grow, user roles and permissions, multiple locations, and per-location stock come with you.",
  },
  {
    title: "Honest numbers",
    description:
      "Profit reports account for refunds and expenses. Dues are tracked for customers and suppliers alike. If a report can mislead you, we consider that a bug.",
  },
] as const;

export default function AboutPage() {
  return (
    <>
      <section className="py-16 sm:py-24">
        <Container className="max-w-3xl">
          <SectionHeading
            eyebrow="About ezPos"
            title="The shop software we wished existed for every small retailer"
            description="ezPos started from a simple observation: shops across Bangladesh still run on paper khatas and mental math, while large chains enjoy precise stock counts, supplier ledgers, and daily profit reports. We are closing that gap."
          />
          <div className="mt-10 space-y-6 text-base leading-8 text-slate-600">
            <p>
              ezPos is a web-based point of sale built for small and medium
              retailers. It brings counter billing, inventory with variants,
              batches, and serial numbers, purchasing with supplier ledgers,
              customer dues, expenses, and clear reports into one application
              that runs in your browser — nothing to install, nothing to
              maintain.
            </p>
            <p>
              The product is actively developed and used by real shops. We
              release improvements continuously, and the roadmap is driven by
              what store owners actually ask for: faster billing, fewer stock
              surprises, and reports they can act on the same day.
            </p>
            <p>
              Today, ezPos is in controlled rollout: you can create an account,
              set up your shop, and start a free trial right away, while online
              subscription payments are being finalized for launch.
            </p>
          </div>
        </Container>
      </section>

      <section
        aria-labelledby="principles-heading"
        className="border-t border-slate-100 bg-slate-50 py-16 sm:py-24"
      >
        <Container>
          <SectionHeading
            id="principles-heading"
            eyebrow="What we believe"
            title="Principles that shape the product"
          />
          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            {principles.map((principle) => (
              <div
                key={principle.title}
                className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <Check
                    className="mt-1 size-5 shrink-0 text-indigo-600"
                    aria-hidden="true"
                  />
                  <div>
                    <h3 className="font-semibold text-slate-900">
                      {principle.title}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {principle.description}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <CtaBand />
    </>
  );
}
