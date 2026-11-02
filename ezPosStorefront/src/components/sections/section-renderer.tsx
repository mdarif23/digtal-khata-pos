import Link from "next/link";
import type { StorefrontProduct, TenantConfig } from "@/lib/backend";
import type { StorefrontSection } from "@/lib/sections-schema";
import { getSkin } from "@/lib/theme";
import { ProductCard } from "../product-card";

/**
 * Section engine: renders a configured homepage section from its typed
 * props. Data (products/categories) is fetched by the page and passed in —
 * the engine itself is presentational.
 */

export interface SectionData {
  productsById: Map<number, StorefrontProduct>;
  newestProducts: StorefrontProduct[];
  categories: Array<{ id: number; name: string }>;
  brands: Array<{ id: number; name: string }>;
}

export function SectionRenderer({
  section,
  data,
  tenant,
}: {
  section: StorefrontSection;
  data: SectionData;
  tenant: TenantConfig;
}) {
  if (!section.enabled) return null;
  const skin = getSkin(tenant.storefront.themeId);

  switch (section.type) {
    case "announcement": {
      const text = String(section.props.text ?? "");
      if (!text) return null;
      const style = {
        ...(section.props.backgroundColor
          ? { background: String(section.props.backgroundColor) }
          : {}),
        ...(section.props.textColor ? { color: String(section.props.textColor) } : {}),
      };
      const link = typeof section.props.linkUrl === "string" ? section.props.linkUrl : null;
      return (
        <div className="text-center text-sm font-medium" style={style}>
          <div
            className="mx-auto px-4 py-2"
            style={{ maxWidth: "var(--sf-container)" }}
          >
            {link ? (
              link.startsWith("/") ? (
                <Link href={link}>{text}</Link>
              ) : (
                <a href={link} target="_blank" rel="noopener noreferrer nofollow">
                  {text}
                </a>
              )
            ) : (
              text
            )}
          </div>
        </div>
      );
    }

    case "hero": {
      const heading = String(section.props.heading ?? "");
      const subheading = typeof section.props.subheading === "string" ? section.props.subheading : "";
      const image = typeof section.props.imageUrl === "string" ? section.props.imageUrl : "";
      const overlay = Number(section.props.overlayOpacity ?? 0);
      const align = String(section.props.align ?? "left");
      const ctaLabel = typeof section.props.ctaLabel === "string" ? section.props.ctaLabel : "";
      const ctaHref = typeof section.props.ctaHref === "string" ? section.props.ctaHref : "/products";
      return (
        <section
          className={`relative overflow-hidden bg-slate-100 ${skin.heroClass.includes("bg-slate-900") ? skin.heroClass : ""}`}
        >
          {image ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image} alt="" className="absolute inset-0 h-full w-full object-cover" />
              {overlay > 0 ? (
                <div
                  className="absolute inset-0 bg-black"
                  style={{ opacity: overlay / 100 }}
                  aria-hidden="true"
                />
              ) : null}
            </>
          ) : null}
          <div
            className={`relative mx-auto px-4 py-20 sm:py-28 ${
              align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left"
            } ${image || skin.heroClass.includes("text-white") ? "text-white" : ""}`}
            style={{ maxWidth: "var(--sf-container)" }}
          >
            <h1 className={`text-3xl font-bold sm:text-5xl ${skin.headingClass}`}>
              {heading}
            </h1>
            {subheading ? (
              <p className="mt-3 max-w-xl text-base opacity-90 sm:text-lg"
                 style={align === "center" ? { marginInline: "auto" } : align === "right" ? { marginLeft: "auto" } : {}}>
                {subheading}
              </p>
            ) : null}
            {ctaLabel ? (
              <Link href={ctaHref} className="sf-btn mt-6 text-base">
                {ctaLabel}
              </Link>
            ) : null}
          </div>
        </section>
      );
    }

    case "featured-categories": {
      const heading = String(section.props.heading ?? "Shop by category");
      const ids = Array.isArray(section.props.categoryIds)
        ? (section.props.categoryIds as number[])
        : [];
      const categories = ids.length
        ? ids
            .map((id) => data.categories.find((c) => c.id === id))
            .filter((c): c is { id: number; name: string } => Boolean(c))
        : data.categories.slice(0, 6);
      if (categories.length === 0) return null;
      return (
        <SectionWrap heading={heading} skinClass={skin.headingClass}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {categories.map((category) => (
              <Link
                key={category.id}
                href={`/products?categoryId=${category.id}`}
                className="sf-card flex items-center justify-center p-6 text-center text-sm font-semibold hover:border-[var(--sf-primary)]"
              >
                {category.name}
              </Link>
            ))}
          </div>
        </SectionWrap>
      );
    }

    case "featured-products": {
      const heading = String(section.props.heading ?? "Featured products");
      const ids = Array.isArray(section.props.productIds)
        ? (section.props.productIds as number[])
        : [];
      const products = ids
        .map((id) => data.productsById.get(id))
        .filter((p): p is StorefrontProduct => Boolean(p));
      if (products.length === 0) return null;
      return (
        <SectionWrap heading={heading} skinClass={skin.headingClass}>
          <ProductGrid products={products} cardClass={skin.cardClass} />
        </SectionWrap>
      );
    }

    case "best-sellers":
    case "new-arrivals": {
      const heading = String(
        section.props.heading ??
          (section.type === "best-sellers" ? "Best sellers" : "New arrivals"),
      );
      const limit = Math.min(12, Math.max(1, Number(section.props.limit ?? 8)));
      // Best-seller ranking arrives with storefront analytics (stage 6);
      // until then this section shows the newest products, clearly ordered.
      const products = data.newestProducts.slice(0, limit);
      if (products.length === 0) return null;
      return (
        <SectionWrap heading={heading} skinClass={skin.headingClass}>
          <ProductGrid products={products} cardClass={skin.cardClass} />
        </SectionWrap>
      );
    }

    case "promo-banners": {
      const banners = Array.isArray(section.props.banners)
        ? (section.props.banners as Array<Record<string, unknown>>)
        : [];
      const visible = banners.slice(0, 4);
      if (visible.length === 0) return null;
      return (
        <SectionWrap heading={String(section.props.heading ?? "")} skinClass={skin.headingClass}>
          <div className={`grid gap-4 ${visible.length > 1 ? "sm:grid-cols-2" : ""}`}>
            {visible.map((banner, index) => {
              const image = typeof banner.imageUrl === "string" ? banner.imageUrl : "";
              const ctaLabel = typeof banner.ctaLabel === "string" ? banner.ctaLabel : "";
              const ctaHref = typeof banner.ctaHref === "string" ? banner.ctaHref : "/products";
              return (
                <div key={index} className="sf-card relative overflow-hidden bg-slate-100">
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={image} alt="" className="h-48 w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="h-48 w-full bg-[color-mix(in_srgb,var(--sf-primary)_15%,white)]" />
                  )}
                  <div className="p-4">
                    {banner.heading ? (
                      <p className="text-lg font-bold">{String(banner.heading)}</p>
                    ) : null}
                    {banner.subheading ? (
                      <p className="mt-1 text-sm opacity-75">{String(banner.subheading)}</p>
                    ) : null}
                    {ctaLabel ? (
                      <Link href={ctaHref} className="sf-btn-outline mt-3">
                        {ctaLabel}
                      </Link>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </SectionWrap>
      );
    }

    case "brands": {
      const heading = String(section.props.heading ?? "Our brands");
      const ids = Array.isArray(section.props.brandIds)
        ? (section.props.brandIds as number[])
        : [];
      const brandList = ids.length
        ? ids
            .map((id) => data.brands.find((b) => b.id === id))
            .filter((b): b is { id: number; name: string } => Boolean(b))
        : data.brands.slice(0, 10);
      if (brandList.length === 0) return null;
      return (
        <SectionWrap heading={heading} skinClass={skin.headingClass}>
          <div className="flex flex-wrap gap-3">
            {brandList.map((brand) => (
              <Link
                key={brand.id}
                href={`/products?brandId=${brand.id}`}
                className="sf-card px-5 py-3 text-sm font-semibold hover:border-[var(--sf-primary)]"
              >
                {brand.name}
              </Link>
            ))}
          </div>
        </SectionWrap>
      );
    }

    case "testimonials": {
      const items = Array.isArray(section.props.items)
        ? (section.props.items as Array<Record<string, unknown>>)
        : [];
      if (items.length === 0) return null;
      return (
        <SectionWrap heading={String(section.props.heading ?? "What customers say")} skinClass={skin.headingClass}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item, index) => (
              <figure key={index} className="sf-card p-5">
                <blockquote className="text-sm opacity-85">“{String(item.quote ?? "")}”</blockquote>
                <figcaption className="mt-3 text-sm font-semibold">
                  {String(item.authorName ?? "")}
                  {item.authorTitle ? (
                    <span className="ml-1 font-normal opacity-60">
                      · {String(item.authorTitle)}
                    </span>
                  ) : null}
                </figcaption>
              </figure>
            ))}
          </div>
        </SectionWrap>
      );
    }

    case "newsletter": {
      const heading = String(section.props.heading ?? "Join our newsletter");
      const subheading = typeof section.props.subheading === "string" ? section.props.subheading : "";
      const buttonLabel = String(section.props.buttonLabel ?? "Subscribe");
      const email = tenant.storefront.contact?.email;
      // Email capture needs a consented storage backend; until then the
      // section links to the store's contact email — nothing is faked.
      return (
        <SectionWrap heading={heading} skinClass={skin.headingClass}>
          <div className="sf-card p-6 text-center">
            {subheading ? <p className="text-sm opacity-75">{subheading}</p> : null}
            {email ? (
              <a href={`mailto:${email}?subject=Newsletter signup`} className="sf-btn mt-4">
                {buttonLabel}
              </a>
            ) : (
              <p className="mt-3 text-sm opacity-60">
                Contact us to hear about new arrivals and offers.
              </p>
            )}
          </div>
        </SectionWrap>
      );
    }

    default:
      return null;
  }
}

function SectionWrap({
  heading,
  skinClass,
  children,
}: {
  heading: string;
  skinClass: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto px-4 py-10" style={{ maxWidth: "var(--sf-container)" }}>
      {heading ? (
        <h2 className={`mb-5 text-2xl ${skinClass}`}>{heading}</h2>
      ) : null}
      {children}
    </section>
  );
}

export function ProductGrid({
  products,
  cardClass,
}: {
  products: StorefrontProduct[];
  cardClass: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((product) => (
        <div key={product.id} className={cardClass}>
          <ProductCard product={product} />
        </div>
      ))}
    </div>
  );
}

export type { TenantConfig };
