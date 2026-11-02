import type { Metadata } from "next";
import {
  BarChart3,
  Check,
  Package,
  ReceiptText,
  Truck,
  Users,
  Wallet,
} from "lucide-react";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/marketing/section-heading";
import { CtaBand } from "@/components/marketing/cta-band";

export const metadata: Metadata = {
  title: "Features",
  description:
    "Counter billing, product and inventory management with variants, batches and serials, purchasing with supplier ledgers, customer and expense tracking, and flexible reports — everything ezPos does today.",
};

const featureGroups = [
  {
    icon: ReceiptText,
    title: "Counter sales and billing",
    description:
      "A counter screen built for speed, with a full record of every sale.",
    bullets: [
      "Quick product search and SKU-style codes",
      "Variant selection at the time of sale",
      "Multiple payment records per sale — cash, card, mobile banking",
      "Refunds tracked against the original sale",
      "Sales history with search, filters, and sorting",
    ],
  },
  {
    icon: Package,
    title: "Products and inventory",
    description:
      "From the shelf to the ledger, stock stays connected to reality.",
    bullets: [
      "Products with brands, categories, and units",
      "Variants with types, options, and values",
      "Batch tracking and serial number tracking",
      "Stock adjustments with reasons — recounts, damage, expiry, loss",
      "Low-stock visibility and stock per location",
    ],
  },
  {
    icon: Truck,
    title: "Purchasing and suppliers",
    description: "Buy confidently and keep supplier dues under control.",
    bullets: [
      "Purchase orders for your suppliers",
      "Partial or full receiving against each order",
      "Purchase returns for short or wrong deliveries",
      "Payment records against purchases",
      "Running supplier ledger balances",
    ],
  },
  {
    icon: Users,
    title: "Customers and contacts",
    description: "Your relationships, kept in order.",
    bullets: [
      "Customer records with contact details",
      "Supplier records alongside purchases",
      "Sales and purchase history filterable by customer or supplier",
    ],
  },
  {
    icon: Wallet,
    title: "Expenses",
    description: "Operating costs that show up in your real profit.",
    bullets: [
      "Expense entries under categories",
      "Expense reports included with your period reports",
    ],
  },
  {
    icon: BarChart3,
    title: "Reports and insights",
    description: "Numbers you can act on, from today to the whole year.",
    bullets: [
      "Dashboard with the current picture at a glance",
      "Sales, purchase, and profit reports",
      "Periods from today, this month, to custom date ranges",
      "Slice by category, brand, customer, supplier, or payment status",
      "Sorting and pagination for large histories",
    ],
  },
] as const;

const roadmap = [
  "Multi-user accounts with roles and permissions",
  "Business subscriptions and billing",
  "Public API for developers and integrations",
] as const;

export default function FeaturesPage() {
  return (
    <>
      <section className="border-b border-slate-100 bg-slate-50 py-16 sm:py-20">
        <Container>
          <SectionHeading
            align="left"
            className="max-w-3xl"
            eyebrow="Features"
            title="Built around the daily work of a shop"
            description="Every module in ezPos exists because a counter needs it: billing, stock, purchasing, expenses, and reporting. Here is what the product does today."
          />
        </Container>
      </section>

      <section aria-label="Feature list" className="py-16 sm:py-24">
        <Container>
          <div className="grid gap-10 lg:grid-cols-2">
            {featureGroups.map((group) => (
              <article
                key={group.title}
                className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm"
              >
                <span className="flex size-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                  <group.icon className="size-5" aria-hidden="true" />
                </span>
                <h2 className="mt-4 text-xl font-semibold text-slate-900">
                  {group.title}
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {group.description}
                </p>
                <ul className="mt-5 space-y-2.5 border-t border-slate-100 pt-5">
                  {group.bullets.map((bullet) => (
                    <li key={bullet} className="flex gap-3 text-sm text-slate-700">
                      <Check
                        className="mt-0.5 size-4 shrink-0 text-indigo-600"
                        aria-hidden="true"
                      />
                      {bullet}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          <div className="mt-16 rounded-2xl border border-dashed border-indigo-300 bg-indigo-50/50 p-8">
            <h2 className="text-lg font-semibold text-slate-900">
              On the roadmap
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              These are planned, in progress, and not available yet:
            </p>
            <ul className="mt-4 flex flex-wrap gap-2.5">
              {roadmap.map((item) => (
                <li
                  key={item}
                  className="rounded-full border border-indigo-200 bg-white px-3.5 py-1.5 text-sm text-indigo-800"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </Container>
      </section>

      <CtaBand
        title="See it for yourself"
        description="The product pages give the full picture — pricing shows the direction we are heading."
      />
    </>
  );
}
