import { LegalPage } from "@/components/legal/legal-page";
import { publicMetadata } from "@/lib/seo";

export const metadata = publicMetadata(
  "/cookie-policy",
  "Cookie Policy",
  "How ezPos uses cookies and similar technologies.",
);

export default function CookiePolicyPage() {
  return (
    <LegalPage
      title="Cookie Policy"
      updated="November 2, 2026"
      intro="This policy explains how ezPos uses cookies and similar technologies. It forms part of our Privacy Policy."
      sections={[
        {
          heading: "What cookies are",
          paragraphs: [
            "Cookies are small text files a website stores in your browser. They are widely used to keep websites working and to remember information between visits.",
          ],
        },
        {
          heading: "Cookies we use",
          paragraphs: [
            "ezPos uses a strictly necessary session cookie to keep you signed in. It is set by the backend, is HttpOnly (JavaScript on your device cannot read it), is scoped to the authentication paths, and is deleted when you sign out or when the session expires.",
            "If you use the single sign-on flow between this website and the ezPos point-of-sale application, the same session cookie authorizes both — it is never shared with third parties.",
          ],
        },
        {
          heading: "What we do not use",
          paragraphs: [
            "We do not use advertising cookies, cross-site tracking pixels, or third-party analytics cookies. If that ever changes, this policy and the cookie notice you see on first visit will be updated before it happens.",
          ],
        },
        {
          heading: "Managing cookies",
          paragraphs: [
            "You can delete or block cookies in your browser settings. Because our only cookie is strictly necessary for signing in, blocking it means you will not be able to stay signed in — the rest of the public website remains fully usable.",
          ],
        },
        {
          heading: "Questions",
          paragraphs: [
            "Questions about this policy can be sent through the contact page.",
          ],
        },
      ]}
    />
  );
}
