import { Clock, Mail, MessageSquareText } from "lucide-react";
import { Container } from "@/components/ui/container";
import { ContactForm } from "@/components/forms/contact-form";
import { publicMetadata } from "@/lib/seo";

export const metadata = publicMetadata(
  "/contact",
  "Contact us",
  "Questions about ezPos, pricing, or your shop's setup? Send us a message — we reply by email.",
);

const highlights = [
  {
    icon: MessageSquareText,
    title: "Sales and product questions",
    description:
      "Not sure whether ezPos fits your shop? Tell us what you sell and how many outlets you run — we will answer honestly.",
  },
  {
    icon: Clock,
    title: "Response time",
    description:
      "We aim to reply within two business days. Urgent account issues are prioritized.",
  },
  {
    icon: Mail,
    title: "We reply by email",
    description:
      "Every message submitted here creates a support ticket so nothing gets lost. You will hear from us at the address you provide.",
  },
] as const;

export default function ContactPage() {
  return (
    <section className="py-16 sm:py-24">
      <Container>
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">
              Contact
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
              Talk to us
            </h1>
            <p className="mt-4 text-base leading-7 text-slate-600">
              Whether you are comparing POS options, stuck during setup, or a
              customer with a billing question — send us a message and a real
              person will read it.
            </p>
            <div className="mt-10 space-y-6">
              {highlights.map((item) => (
                <div key={item.title} className="flex gap-4">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                    <item.icon className="size-5" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">
                      {item.title}
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      {item.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <ContactForm />
          </div>
        </div>
      </Container>
    </section>
  );
}
