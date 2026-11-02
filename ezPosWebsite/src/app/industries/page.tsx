import type { Metadata } from "next";
import {
  CookingPot,
  Laptop,
  Mail,
  PackageSearch,
  Shirt,
  Sparkles,
  Store,
  Warehouse,
} from "lucide-react";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/marketing/section-heading";
import { CtaBand } from "@/components/marketing/cta-band";

export const metadata: Metadata = {
  title: "Industries and use cases",
  description:
    "How retail shops of every kind use ezPos: clothing with sizes, electronics with serial numbers, groceries with expiry dates, hardware stores, and multi-outlet businesses.",
};

const industries = [
  {
    icon: Shirt,
    title: "Clothing and footwear",
    description:
      "Track every color and size as its own variant with its own stock and price. Search a variant in seconds at the counter, and see which sizes actually move.",
    points: [
      "Variant-level stock and pricing",
      "Variant images for quick visual picking",
      "Size-wise sales reports",
    ],
  },
  {
    icon: Laptop,
    title: "Electronics and appliances",
    description:
      "Serial numbers follow each unit from purchase to sale, so warranty claims and service returns are traceable without a separate register.",
    points: [
      "Serial number tracking per unit",
      "Purchase-linked stock arrival",
      "Refunds recorded against the original sale",
    ],
  },
  {
    icon: CookingPot,
    title: "Grocery and mini markets",
    description:
      "Batch numbers and expiry dates keep perishable stock honest. See what expires soon before it becomes a loss on the shelf.",
    points: [
      "Batch tracking with expiry dates",
      "Low-stock flags before shelves empty",
      "Shrinkage and damage adjustments with reasons",
    ],
  },
  {
    icon: Sparkles,
    title: "Cosmetics and personal care",
    description:
      "Many small SKUs, frequent new arrivals, and brands that matter — ezPos keeps catalog, brand, and stock management quick to maintain.",
    points: [
      "Fast product catalog with categories and brands",
      "Quick barcode search at the counter",
      "Stock counts per location",
    ],
  },
  {
    icon: Warehouse,
    title: "Hardware and building materials",
    description:
      "Bulk items, partial deliveries, and supplier dues are normal here. Purchase orders, receiving, and a running supplier ledger keep it all straight.",
    points: [
      "Purchase orders with partial receiving",
      "Supplier ledger with balances",
      "Unit-based products and conversions",
    ],
  },
  {
    icon: Store,
    title: "Multi-outlet retail",
    description:
      "Run several shops from one account: separate stock per location, staff assigned to their own outlets, and reports you can compare side by side.",
    points: [
      "Separate stock and pricing per location",
      "Inter-location stock transfers",
      "Location comparison reports",
    ],
  },
] as const;

export default function IndustriesPage() {
  return (
    <>
      <section className="py-16 sm:py-24">
        <Container>
          <SectionHeading
            eyebrow="Industries"
            title="Built for the way your shop actually works"
            description="ezPos is a general retail POS, but the details — variants, serials, batches, ledgers — are what make it fit specific trades. Here is how different shops use it."
          />
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {industries.map((industry) => (
              <div
                key={industry.title}
                className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
              >
                <span className="flex size-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                  <industry.icon className="size-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 font-semibold text-slate-900">
                  {industry.title}
                </h3>
                <p className="mt-2 flex-1 text-sm leading-6 text-slate-600">
                  {industry.description}
                </p>
                <ul className="mt-4 space-y-2 border-t border-slate-100 pt-4">
                  {industry.points.map((point) => (
                    <li
                      key={point}
                      className="text-xs font-medium text-slate-500"
                    >
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section
        aria-labelledby="not-listed-heading"
        className="border-t border-slate-100 bg-slate-50 py-16"
      >
        <Container className="max-w-2xl text-center">
          <PackageSearch
            className="mx-auto size-8 text-indigo-600"
            aria-hidden="true"
          />
          <h2
            id="not-listed-heading"
            className="mt-4 text-2xl font-semibold tracking-tight text-slate-900"
          >
            Don&apos;t see your trade?
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            If your shop sells things and takes money at a counter, ezPos is
            probably a fit. Tell us what you sell — we will give you a straight
            answer, including when we are not the right tool.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <a
              href="/contact"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-400 hover:bg-slate-50"
            >
              <Mail className="size-4" aria-hidden="true" />
              Ask about your shop
            </a>
          </div>
        </Container>
      </section>

      <CtaBand />
    </>
  );
}
