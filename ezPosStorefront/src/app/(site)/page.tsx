import { getTenant } from "@/lib/tenant";
import { fetchCatalog, fetchProduct } from "@/lib/backend";
import { SectionRenderer, type SectionData } from "@/components/sections/section-renderer";
import type { StorefrontSection } from "@/lib/sections-schema";


/**
 * Storefront homepage: renders the tenant's configured sections top-to-bottom.
 * All data is fetched server-side (SSR) for SEO and fast first paint.
 */
// Client-rendered per tenant — excluded from prerender.
export const instant = false;

export default async function HomePage() {
  const tenant = await getTenant();
  if (!tenant) return null;
  const storefrontId = tenant.config.storefront.id;

  const config = tenant.config.storefront.config as {
    sections?: StorefrontSection[];
  };
  const sections = (config.sections ?? []).filter((section) => section.enabled);

  const [catalog] = await Promise.all([
    fetchCatalog({ storefrontId, page: 1 }),
    // Warm nothing else; section-specific products are fetched below.
  ]);

  const productsById = new Map<number, Awaited<ReturnType<typeof fetchProduct>>>();
  const sectionData: SectionData = {
    productsById: new Map(),
    newestProducts: catalog?.products ?? [],
    categories: catalog?.categories ?? [],
    brands: catalog?.brands ?? [],
  };

  // Featured sections reference specific product ids — fetch just those.
  const featuredIds = new Set<number>();
  for (const section of sections) {
    if (section.type === "featured-products" && Array.isArray(section.props.productIds)) {
      for (const id of section.props.productIds as number[]) featuredIds.add(Number(id));
    }
  }
  await Promise.all(
    [...featuredIds].map(async (id) => {
      const product = await fetchProduct(storefrontId, id);
      if (product) {
        sectionData.productsById.set(id, product);
        productsById.set(id, product);
      }
    }),
  );
  void productsById;

  if (sections.length === 0) {
    return (
      <div
        className="mx-auto px-4 py-24 text-center"
        style={{ maxWidth: "var(--sf-container)" }}
      >
        <h1 className="text-3xl font-bold">{tenant.config.storefront.name}</h1>
        <p className="mt-3 text-sm opacity-70">This store is being set up. Check back soon.</p>
      </div>
    );
  }

  return (
    <>
      {sections.map((section) => (
        <SectionRenderer
          key={section.id}
          section={section}
          data={sectionData}
          tenant={tenant.config}
        />
      ))}
    </>
  );
}
