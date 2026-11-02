import type { Metadata } from "next";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/marketing/section-heading";
import { FaqItem } from "@/components/marketing/faq-item";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Answers to common questions about ezPos: what it is, what it costs, how your data is handled, and what is coming next.",
};

const faqs = [
  {
    question: "What is ezPos?",
    answer:
      "ezPos is a web-based point of sale for small and medium retailers. Billing, inventory, purchasing, expenses, and reports all run in your browser — nothing to install, and your data lives in one place.",
  },
  {
    question: "Is ezPos ready to use today?",
    answer:
      "Yes — you can create an account, set up your shop, and start a free trial right now. The core sales, inventory, and purchasing modules are built and in daily use. Online subscription payments are the last piece being added before commercial launch.",
  },
  {
    question: "Do I need to install anything?",
    answer:
      "No. ezPos runs in a modern browser on the computer at your counter. There is no separate installer to maintain.",
  },
  {
    question: "Can ezPos manage more than one outlet?",
    answer:
      "Stock can be tracked per location today, so goods in a godown or second shelf area are counted separately. Multi-outlet shops with teams and consolidated views are on the roadmap as accounts and roles roll out.",
  },
  {
    question: "What does ezPos cost?",
    answer:
      "Current plans and prices are shown on the pricing page. Online billing is not open yet, so nothing is charged today, and exact pricing will be confirmed at launch.",
  },
  {
    question: "Is my business data safe?",
    answer:
      "ezPos is designed around separate business accounts with role-based access for team members, so each person only sees what their role allows. Full security documentation will be published when accounts open.",
  },
  {
    question: "Will there be a mobile app?",
    answer:
      "ezPos is web-first: the application runs in the browser and this website works on phones today. A phone-friendly layout for the POS itself is on the roadmap.",
  },
  {
    question: "Can developers integrate with ezPos?",
    answer:
      "Yes — a public API is planned so developers and businesses can connect their own applications to ezPos. Details will be published at launch.",
  },
] as const;

export default function FaqPage() {
  return (
    <section className="py-16 sm:py-24">
      <Container>
        <SectionHeading
          eyebrow="FAQ"
          title="Frequently asked questions"
          description="Everything shop owners usually ask before switching from a paper khata to ezPos."
        />
        <div className="mx-auto mt-12 max-w-3xl space-y-4">
          {faqs.map((faq) => (
            <FaqItem key={faq.question} question={faq.question}>
              {faq.answer}
            </FaqItem>
          ))}
        </div>
      </Container>
    </section>
  );
}
