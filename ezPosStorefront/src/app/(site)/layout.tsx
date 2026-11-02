import type { Metadata } from "next";
import { getTenant } from "@/lib/tenant";
import { tokensToStyle } from "@/lib/theme";
import { CartProvider } from "@/components/cart-context";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";

/**
 * Tenant shell: injects the storefront's design tokens, wraps every page in
 * header/footer + cart context, and generates per-tenant SEO metadata.
 * Unknown hosts never reach this layout (the proxy rewrites to /parked).
 */
export async function generateMetadata(): Promise<Metadata> {
  const tenant = await getTenant();
  if (!tenant) return { title: "Store", robots: { index: false, follow: false } };
  const seo = tenant.config.storefront.seo;
  const indexing = tenant.config.storefront.flags.searchIndexingEnabled;
  return {
    title: {
      default: seo?.title || tenant.config.storefront.name,
      template: `%s · ${seo?.title || tenant.config.storefront.name}`,
    },
    description: seo?.description || `Shop online at ${tenant.config.storefront.name}.`,
    openGraph: {
      title: seo?.title || tenant.config.storefront.name,
      description: seo?.description || `Shop online at ${tenant.config.storefront.name}.`,
      type: "website",
      siteName: tenant.config.storefront.name,
    },
    robots: indexing && tenant.config.source === "published"
      ? { index: true, follow: true }
      : { index: false, follow: false },
  };
}

export default async function SiteLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const tenant = await getTenant();
  if (!tenant) {
    // Defensive: the proxy parks unknown hosts; an offline-but-resolved
    // tenant still shows the store name with an offline notice.
    return (
      <main className="flex min-h-screen items-center justify-center p-6 text-center">
        <p className="text-sm text-slate-500">This store is not available right now.</p>
      </main>
    );
  }

  const tokens = (tenant.config.storefront.config.tokens ?? {}) as Record<string, string>;

  return (
    <CartProvider storefrontId={tenant.config.storefront.id}>
      <div style={tokensToStyle(tokens)} className="flex min-h-screen flex-col bg-[var(--sf-bg)] text-[var(--sf-text)]">
        {tenant.config.source === "preview" ? (
          <div className="bg-amber-400 px-4 py-1.5 text-center text-xs font-semibold text-amber-950">
            Preview mode — you are viewing unpublished changes
          </div>
        ) : null}
        <Header tenant={tenant.config} />
        <main className="flex-1">{children}</main>
        <Footer tenant={tenant.config} />
      </div>
    </CartProvider>
  );
}
