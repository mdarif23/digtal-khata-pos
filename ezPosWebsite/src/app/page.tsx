import Link from "next/link";
import {
  BarChart3,
  Check,
  MapPin,
  Package,
  ReceiptText,
  ShieldCheck,
  Truck,
  Users,
  Wallet,
} from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/marketing/section-heading";
import { FeatureCard } from "@/components/marketing/feature-card";
import { PosPreview } from "@/components/marketing/pos-preview";
import {
  InventoryVisual,
  PurchasingVisual,
  ReportsVisual,
  SalesVisual,
} from "@/components/marketing/section-visuals";
import { FaqItem } from "@/components/marketing/faq-item";
import { CtaBand } from "@/components/marketing/cta-band";
import { getSubscriptionPlans } from "@/lib/api/subscription-plans";
import { describeLimit, formatPrice } from "@/lib/format";

const overviewFeatures = [
  {
    icon: ReceiptText,
    title: "Fast counter billing",
    description:
      "Ring up sales in seconds with product search, variant selection, and multiple payment records. Refunds are tracked against the original sale.",
  },
  {
    icon: Package,
    title: "Inventory that adds up",
    description:
      "Know exact stock with batch tracking, serial numbers, low-stock flags, and audited adjustments for damage, loss, and recounts.",
  },
  {
    icon: Truck,
    title: "Purchasing and suppliers",
    description:
      "Create purchase orders, receive stock in part or full, handle returns, and keep a running supplier ledger with balances.",
  },
  {
    icon: Users,
    title: "Customers and suppliers",
    description:
      "Keep contact records for customers and suppliers so dues, history, and details are always one search away.",
  },
  {
    icon: Wallet,
    title: "Expense tracking",
    description:
      "Record day-to-day expenses under categories so your reports reflect real profit, not just sales.",
  },
  {
    icon: BarChart3,
    title: "Reports and insights",
    description:
      "Filter sales, purchase, and profit reports by period, category, brand, customer, or payment status.",
  },
  {
    icon: MapPin,
    title: "Multi-store management",
    description:
      "Run several outlets from one account — separate stock per location, inter-location transfers, and side-by-side comparison reports.",
  },
  {
    icon: ShieldCheck,
    title: "User roles and permissions",
    description:
      "Give each staff member their own login with exactly the access they need, from counter-only cashiers to store managers.",
  },
] as const;

const deepDives = [
  {
    id: "sales",
    eyebrow: "Point of sale",
    title: "Ring up sales in seconds",
    description:
      "The counter screen is built for speed: search products, pick variants, split payments across cash, card, and mobile banking — all on one bill.",
    bullets: [
      "Product search and variant selection without leaving the bill",
      "Mixed payment records — cash, card, and mobile banking together",
      "Refunds recorded against the original sale",
      "Complete sales history with filters",
    ],
    Visual: SalesVisual,
  },
  {
    id: "inventory",
    eyebrow: "Inventory",
    title: "Stock you can trust",
    description:
      "Every item movement is recorded — purchases in, sales out, adjustments in between — so your shelf count and your records finally agree.",
    bullets: [
      "Variants, batches, and serial numbers tracked per product",
      "Adjustments with reasons: damage, loss, expiry, recounts",
      "Low-stock flags before the shelf empties",
      "Stock kept per location",
    ],
    Visual: InventoryVisual,
  },
  {
    id: "purchasing",
    eyebrow: "Purchasing",
    title: "Buying without paperwork",
    description:
      "Raise purchase orders, record what actually arrived, and return what did not. Supplier ledgers keep your dues clear.",
    bullets: [
      "Purchase orders with partial or full receiving",
      "Purchase returns when deliveries fall short",
      "Payment records against each purchase",
      "A running supplier ledger — what you owe, on one screen",
    ],
    Visual: PurchasingVisual,
  },
  {
    id: "reports",
    eyebrow: "Reports",
    title: "Reports that answer questions",
    description:
      "A dashboard for today at a glance, and reports you can slice by period, product, customer, or payment status.",
    bullets: [
      "Today at a glance on the dashboard",
      "Sales, purchase, and profit reports",
      "Periods from today to custom date ranges",
      "Slice by category, brand, customer, supplier, or payment status",
    ],
    Visual: ReportsVisual,
  },
] as const;

const teaserFaqs = [
  {
    question: "What is ezPos?",
    answer:
      "ezPos is a web-based point of sale for small and medium retailers. Billing, inventory, purchasing, expenses, and reports run in your browser — nothing to install.",
  },
  {
    question: "What does ezPos cost?",
    answer:
      "Current plans and prices are shown on the pricing page. Online billing is not open yet, so nothing is charged today.",
  },
  {
    question: "Is my business data safe?",
    answer:
      "ezPos is designed around separate business accounts with role-based access for your team. Full security documentation will be published at launch.",
  },
] as const;

export default async function HomePage() {
  const plansResult = await getSubscriptionPlans();
  const teaserPlans =
    plansResult.status === "ok"
      ? plansResult.plans.filter((plan) => plan.interval === "monthly")
      : [];

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 -z-10 h-96 bg-gradient-to-b from-indigo-50 via-white to-white"
        />
        <Container className="grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
              Point of sale · Inventory · Reports
            </p>
            <h1 className="mt-5 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl sm:leading-tight">
              Billing, stock, and reports — one POS for your whole shop
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-8 text-slate-600">
              ezPos is a web-based point of sale for small and medium retailers:
              fast counter billing, precise inventory with variants and serials,
              purchase tracking with supplier ledgers, and reports that show
              where your money is.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <ButtonLink href="/sign-up" size="lg">
                Start free trial
              </ButtonLink>
              <ButtonLink href="/pricing" size="lg" variant="outline">
                View pricing
              </ButtonLink>
            </div>
            <p className="mt-4 text-sm text-slate-500">
              Every account starts with a free trial — no charge during the
              trial, cancel anytime.
            </p>
          </div>
          <PosPreview />
        </Container>
      </section>

      {/* Feature overview */}
      <section
        aria-labelledby="features-overview-heading"
        className="border-t border-slate-100 bg-slate-50 py-16 sm:py-24"
      >
        <Container>
          <SectionHeading
            id="features-overview-heading"
            eyebrow="Everything in one place"
            title="Everything you need at the counter"
            description="From the first sale of the day to the month-end report, ezPos covers the daily work of running a retail business."
          />
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {overviewFeatures.map((feature) => (
              <FeatureCard key={feature.title} {...feature} />
            ))}
          </div>
        </Container>
      </section>

      {/* Deep dives */}
      <section aria-label="Product walkthrough" className="py-16 sm:py-24">
        <Container className="space-y-20 sm:space-y-28">
          {deepDives.map(({ id, eyebrow, title, description, bullets, Visual }, index) => (
            <div
              key={id}
              className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16"
            >
              <div className={index % 2 === 1 ? "lg:order-2" : undefined}>
                <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">
                  {eyebrow}
                </p>
                <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
                  {title}
                </h2>
                <p className="mt-4 text-base leading-7 text-slate-600">
                  {description}
                </p>
                <ul className="mt-6 space-y-3">
                  {bullets.map((bullet) => (
                    <li key={bullet} className="flex gap-3 text-sm text-slate-700">
                      <Check
                        className="mt-0.5 size-4.5 shrink-0 text-indigo-600"
                        aria-hidden="true"
                      />
                      {bullet}
                    </li>
                  ))}
                </ul>
              </div>
              <div className={index % 2 === 1 ? "lg:order-1" : undefined}>
                <Visual />
              </div>
            </div>
          ))}
        </Container>
      </section>

      {/* Pricing teaser */}
      <section
        aria-labelledby="pricing-teaser-heading"
        className="border-t border-slate-100 bg-slate-50 py-16 sm:py-24"
      >
        <Container>
          <SectionHeading
            id="pricing-teaser-heading"
            eyebrow="Pricing"
            title="Simple plans for every shop"
            description="Every plan includes the full POS — billing, inventory, purchasing, and reports. Online payment opens soon."
          />
          {teaserPlans.length > 0 ? (
            <div className="mx-auto mt-12 grid max-w-4xl gap-6 sm:grid-cols-3">
              {teaserPlans.map((plan) => {
                const limits = plan.limits;
                const summary = limits
                  ? [
                      limits.maxUsers !== undefined
                        ? describeLimit(limits.maxUsers, "users")
                        : null,
                      limits.maxLocations !== undefined
                        ? describeLimit(limits.maxLocations, "locations")
                        : null,
                      limits.maxProducts !== undefined
                        ? describeLimit(limits.maxProducts, "products")
                        : null,
                    ].filter(Boolean)
                  : [];
                return (
                  <div
                    key={plan.id}
                    className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm"
                  >
                    <h3 className="text-sm font-semibold text-slate-900">
                      {plan.name}
                    </h3>
                    <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
                      {formatPrice(plan.price, plan.currency)}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">per month</p>
                    {summary.length > 0 ? (
                      <p className="mt-3 text-xs leading-5 text-slate-500">
                        {summary.join(" · ")}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mx-auto mt-12 max-w-xl text-center text-sm text-slate-500">
              Plans are being finalized. See the{" "}
              <Link href="/pricing" className="font-medium text-indigo-700 hover:underline">
                pricing page
              </Link>{" "}
              for the latest availability.
            </p>
          )}
          <div className="mt-10 text-center">
            <ButtonLink href="/pricing" variant="outline">
              See full pricing
            </ButtonLink>
          </div>
        </Container>
      </section>

      {/* FAQ teaser */}
      <section
        aria-labelledby="faq-teaser-heading"
        className="py-16 sm:py-24"
      >
        <Container>
          <SectionHeading
            id="faq-teaser-heading"
            eyebrow="FAQ"
            title="Questions, answered"
          />
          <div className="mx-auto mt-10 max-w-3xl space-y-4">
            {teaserFaqs.map((faq) => (
              <FaqItem key={faq.question} question={faq.question}>
                {faq.answer}
              </FaqItem>
            ))}
          </div>
          <p className="mt-8 text-center text-sm text-slate-600">
            More questions?{" "}
            <Link href="/faq" className="font-medium text-indigo-700 hover:underline">
              Read the full FAQ
            </Link>
          </p>
        </Container>
      </section>

      <CtaBand />
    </>
  );
}
