import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Terms and Conditions",
  description:
    "The terms that govern your use of the ezPos point of sale service and website.",
};

const UPDATED = "October 31, 2026";

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms and Conditions"
      updated={UPDATED}
      intro="These terms govern your use of the ezPos website, the ezPos point of sale application, and any related services operated by the ezPos team. By creating an account or using the service, you agree to these terms."
      sections={[
        {
          heading: "The service",
          paragraphs: [
            "ezPos is a web-based point of sale service for retail businesses. It includes counter billing, inventory management, purchasing and supplier ledgers, customer and due management, expense tracking, reporting, and related features, accessed through your web browser.",
            "The service is provided to businesses. Each account belongs to one business, and the person who creates the account is its owner and is responsible for how the account is used by everyone they invite.",
          ],
        },
        {
          heading: "Accounts and security",
          paragraphs: [
            "You must provide accurate information when registering, keep your password confidential, and notify us immediately of any unauthorized access to your account.",
            "You are responsible for the activity that happens in your account, including the actions of team members you invite with roles and permissions you configure.",
          ],
        },
        {
          heading: "Trials, subscriptions and billing",
          paragraphs: [
            "New accounts start with a free trial of the features in effect at the time of registration. The duration of the trial is shown when you sign up.",
            "Paid subscription plans are offered on monthly and yearly terms, with the features, usage limits, and prices described on the pricing page. Prices are stated in Bangladeshi Taka (BDT) unless stated otherwise and may include applicable taxes where required by law.",
            "Subscriptions renew for successive periods unless cancelled before the renewal date. If a payment fails, you will be notified and given a grace period to complete payment before the subscription is suspended.",
            "Downgrades, upgrades, cancellations, and refunds follow the process described in our Refund Policy, which forms part of these terms.",
          ],
        },
        {
          heading: "Acceptable use",
          paragraphs: [
            "You agree not to use the service for unlawful activity, not to attempt to access other customers' data, not to probe or disrupt the service's infrastructure, and not to resell access to the service without written permission.",
            "We may suspend or terminate accounts that violate these terms, with notice where practical.",
          ],
        },
        {
          heading: "Your data",
          paragraphs: [
            "You retain all rights to the business data you enter into ezPos — your products, sales, customers, suppliers, and reports. We use it only to provide the service to you, as described in our Privacy Policy.",
            "You may export or request deletion of your business data. If your subscription ends, we will make your data available for retrieval for a reasonable period before deletion, and we will notify you beforehand where we have your contact details.",
          ],
        },
        {
          heading: "Availability and changes",
          paragraphs: [
            "We work to keep the service available and correct, but the service is provided on an as-is basis without warranties of any kind to the extent permitted by law. We are not liable for indirect or consequential losses arising from unavailability, to the extent permitted by law.",
            "We may change the features of the service and these terms. Material changes to the terms will be communicated before they take effect, and continued use after that constitutes acceptance.",
          ],
        },
        {
          heading: "Governing law",
          paragraphs: [
            "These terms are governed by the laws of Bangladesh, and disputes will be resolved in the courts of Bangladesh.",
            "Questions about these terms can be sent through the contact page.",
          ],
        },
      ]}
    />
  );
}
