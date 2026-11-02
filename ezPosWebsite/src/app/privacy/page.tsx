import { LegalPage } from "@/components/legal/legal-page";
import { publicMetadata } from "@/lib/seo";

export const metadata = publicMetadata(
  "/privacy",
  "Privacy Policy",
  "What data ezPos collects, why, and how your business information is protected.",
);

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="October 31, 2026"
      intro="This policy explains what information ezPos collects, what we do with it, and the choices you have. It applies to this website and the ezPos point of sale service."
      sections={[
        {
          heading: "Information we collect",
          paragraphs: [
            "Account information: when you register, we collect your name, email address, phone number (optional), and password (stored only as a secure hash).",
            "Business data: everything you enter while using the service — products, sales, purchases, customers, suppliers, expenses, and reports. This data belongs to your business.",
            "Technical data: login sessions (IP address and browser user agent, kept with session records for security), and basic request logs needed to operate and protect the service.",
            "Support data: messages you send us through the contact page or support channels.",
          ],
        },
        {
          heading: "How we use information",
          paragraphs: [
            "To provide the service: storing and processing your business data so the POS works for you and your team, scoped strictly to your business account.",
            "To secure accounts: authentication, session management, rate limiting, and abuse prevention.",
            "To communicate with you: transactional email about your account, subscription, billing, and support requests. We do not send marketing email without your consent.",
            "To operate the business: aggregate, de-identified statistics about service usage. We do not sell your data, and we do not use your business data to advertise to anyone.",
          ],
        },
        {
          heading: "Cookies",
          paragraphs: [
            "We use a small number of strictly necessary cookies: an HttpOnly session-refresh cookie that keeps you signed in securely. We do not use advertising or cross-site tracking cookies.",
          ],
        },
        {
          heading: "Data sharing",
          paragraphs: [
            "We share data only with service providers that help us operate the service — for example, hosting providers, email delivery providers, and payment gateways — and only the data each provider needs to do its job.",
            "We may disclose information if required by law, or to protect the security and rights of the service and its users.",
          ],
        },
        {
          heading: "Data security",
          paragraphs: [
            "Passwords are stored as salted hashes and never in plain text. Access tokens are short-lived; refresh tokens are stored hashed and revoked on sign-out. Data access between businesses is isolated at the application and database level.",
            "No system is perfectly secure, and we treat the protection of your data as an ongoing responsibility, including limiting internal access to what operations require.",
          ],
        },
        {
          heading: "Data retention and deletion",
          paragraphs: [
            "Your business data is retained while your account is active. After an account or subscription ends, data remains retrievable for a reasonable grace period and is then deleted, with notice where we have your contact details.",
            "Support records are kept as long as needed to handle your requests and for service quality.",
          ],
        },
        {
          heading: "Your choices",
          paragraphs: [
            "You can access and correct your account information in your account settings, and request an export of your business data or deletion of your account by contacting us — we will provide it in a machine-readable format.",
            "If you have questions about this policy or how your data is handled, contact us through the contact page.",
          ],
        },
      ]}
    />
  );
}
