import type { Metadata } from "next";
import { Suspense } from "react";
import "@fontsource-variable/inter";
import "./globals.css";
import { SiteHeader } from "@/components/layout/site-header";
import { SiteFooter } from "@/components/layout/site-footer";
import { AuthProvider } from "@/components/providers/auth-provider";
import { JsonLd } from "@/components/seo/json-ld";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "ezPos — Point of sale, inventory and reports for retail",
    template: "%s · ezPos",
  },
  description:
    "ezPos is a web-based point of sale for small and medium retailers: fast counter billing, precise inventory with variants and serials, purchase tracking with supplier ledgers, and reports that show where your money is.",
  openGraph: {
    siteName: "ezPos",
    type: "website",
    url: "/",
    title: "ezPos — Point of sale, inventory and reports for retail",
    description:
      "Fast counter billing, precise inventory, purchasing with supplier ledgers, and clear reports — one web app for your whole shop.",
  },
};

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "ezPos",
  url: siteUrl,
  description:
    "Web-based point of sale for small and medium retailers: counter billing, inventory, purchasing, and reports.",
};

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "ezPos",
  url: siteUrl,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col bg-white font-sans text-slate-900 antialiased">
        <JsonLd data={organizationJsonLd} />
        <JsonLd data={websiteJsonLd} />
        <AuthProvider>
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-indigo-600 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
          >
            Skip to content
          </a>
          {/* The header reads usePathname(); dynamic routes prerender their
              shell, so URL data must sit behind a Suspense boundary. */}
          <Suspense fallback={null}>
            <SiteHeader />
          </Suspense>
          <main id="main-content" className="flex-1">
            {children}
          </main>
          <SiteFooter />
        </AuthProvider>
      </body>
    </html>
  );
}
