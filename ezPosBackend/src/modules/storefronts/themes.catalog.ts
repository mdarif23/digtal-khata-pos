import type { StorefrontSection, StorefrontTokens } from "./themeConfig.schema.js";

/**
 * Backend catalog of launch themes. The ezPosStorefront renderer has its own
 * registry with implementations keyed by the SAME ids; this catalog is what
 * the backend validates themeId against, serves to the portal, and uses for
 * default configs when a storefront is created.
 *
 * `premium: true` themes require the plan feature `premiumThemes`.
 */
export interface ThemeCatalogEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  premium: boolean;
  defaultTokens: StorefrontTokens;
  defaultSections: StorefrontSection[];
}

function section(
  partial: StorefrontSection,
): StorefrontSection {
  return partial;
}

const baseTokens: StorefrontTokens = {
  primaryColor: "#16a34a",
  secondaryColor: "#0f172a",
  backgroundColor: "#ffffff",
  textColor: "#0f172a",
  fontHeading: "inter",
  fontBody: "inter",
  radius: "md",
  containerWidth: "normal",
  buttonStyle: "solid",
  productCardStyle: "bordered",
  headerLayout: "classic",
  footerLayout: "columns",
};

export const THEMES: ThemeCatalogEntry[] = [
  {
    id: "aura-fashion",
    name: "Aura",
    category: "fashion",
    description:
      "Editorial fashion storefront with a full-bleed hero, serif headings and a lookbook feel.",
    premium: false,
    defaultTokens: {
      ...baseTokens,
      primaryColor: "#111827",
      secondaryColor: "#9f1239",
      fontHeading: "playfair",
      fontBody: "lora",
      radius: "none",
      productCardStyle: "minimal",
      headerLayout: "centered",
    },
    defaultSections: [
      section({
        id: "announcement-1",
        type: "announcement",
        enabled: true,
        props: { text: "Free delivery on orders over ৳2,000" },
      }),
      section({
        id: "hero-1",
        type: "hero",
        enabled: true,
        props: {
          heading: "The New Season Edit",
          subheading: "Hand-picked pieces for your everyday wardrobe.",
          ctaLabel: "Shop now",
          ctaHref: "/products",
          align: "center",
          overlayOpacity: 30,
        },
      }),
      section({
        id: "featured-categories-1",
        type: "featured-categories",
        enabled: true,
        props: { heading: "Shop by category", categoryIds: [] },
      }),
      section({
        id: "new-arrivals-1",
        type: "new-arrivals",
        enabled: true,
        props: { heading: "New arrivals", limit: 8 },
      }),
      section({
        id: "newsletter-1",
        type: "newsletter",
        enabled: true,
        props: {
          heading: "Join the list",
          subheading: "Early access to drops and member-only offers.",
          buttonLabel: "Subscribe",
        },
      }),
    ],
  },
  {
    id: "volt-electronics",
    name: "Volt",
    category: "electronics",
    description:
      "Spec-forward electronics storefront with a dark hero, brand strip and grid-dense product cards.",
    premium: false,
    defaultTokens: {
      ...baseTokens,
      primaryColor: "#2563eb",
      secondaryColor: "#0f172a",
      fontHeading: "poppins",
      fontBody: "inter",
      radius: "sm",
      productCardStyle: "elevated",
      buttonStyle: "solid",
    },
    defaultSections: [
      section({
        id: "hero-1",
        type: "hero",
        enabled: true,
        props: {
          heading: "Tech that keeps up with you",
          subheading: "Genuine products, warranty and fast delivery.",
          ctaLabel: "Browse products",
          ctaHref: "/products",
          align: "left",
          overlayOpacity: 0,
        },
      }),
      section({
        id: "brands-1",
        type: "brands",
        enabled: true,
        props: { heading: "Top brands", brandIds: [] },
      }),
      section({
        id: "best-sellers-1",
        type: "best-sellers",
        enabled: true,
        props: { heading: "Best sellers", limit: 8 },
      }),
      section({
        id: "promo-banners-1",
        type: "promo-banners",
        enabled: true,
        props: {
          heading: "Deals of the week",
          banners: [
            {
              heading: "Gadget fest",
              subheading: "Up to 25% off accessories",
              ctaLabel: "See deals",
              ctaHref: "/products",
            },
          ],
        },
      }),
      section({
        id: "newsletter-1",
        type: "newsletter",
        enabled: true,
        props: { heading: "Never miss a drop", buttonLabel: "Notify me" },
      }),
    ],
  },
  {
    id: "freshmart-grocery",
    name: "FreshMart",
    category: "grocery",
    description:
      "Bright grocery/supermarket storefront with category tiles and quick re-order friendly listings.",
    premium: false,
    defaultTokens: {
      ...baseTokens,
      primaryColor: "#16a34a",
      secondaryColor: "#166534",
      fontHeading: "poppins",
      fontBody: "inter",
      radius: "lg",
      productCardStyle: "bordered",
      containerWidth: "wide",
    },
    defaultSections: [
      section({
        id: "announcement-1",
        type: "announcement",
        enabled: true,
        props: { text: "Fresh groceries delivered to your door" },
      }),
      section({
        id: "hero-1",
        type: "hero",
        enabled: true,
        props: {
          heading: "Your daily essentials",
          subheading: "Vegetables, pantry staples and more — delivered fresh.",
          ctaLabel: "Start shopping",
          ctaHref: "/products",
          align: "left",
          overlayOpacity: 0,
        },
      }),
      section({
        id: "featured-categories-1",
        type: "featured-categories",
        enabled: true,
        props: { heading: "Shop by aisle", categoryIds: [] },
      }),
      section({
        id: "best-sellers-1",
        type: "best-sellers",
        enabled: true,
        props: { heading: "Popular this week", limit: 12 },
      }),
    ],
  },
  {
    id: "cornerstone-general",
    name: "Cornerstone",
    category: "general",
    description:
      "Clean, neutral general-retail storefront that fits any catalog — the safest default.",
    premium: false,
    defaultTokens: baseTokens,
    defaultSections: [
      section({
        id: "hero-1",
        type: "hero",
        enabled: true,
        props: {
          heading: "Welcome to our store",
          subheading: "Quality products, fair prices, quick delivery.",
          ctaLabel: "Shop now",
          ctaHref: "/products",
          align: "center",
          overlayOpacity: 0,
        },
      }),
      section({
        id: "featured-products-1",
        type: "featured-products",
        enabled: true,
        props: { heading: "Featured products", productIds: [] },
      }),
      section({
        id: "new-arrivals-1",
        type: "new-arrivals",
        enabled: true,
        props: { heading: "Just arrived", limit: 8 },
      }),
      section({
        id: "newsletter-1",
        type: "newsletter",
        enabled: true,
        props: { heading: "Stay in touch", buttonLabel: "Subscribe" },
      }),
    ],
  },
];

export function getTheme(themeId: string): ThemeCatalogEntry | undefined {
  return THEMES.find((theme) => theme.id === themeId);
}

export function isThemeId(themeId: string): boolean {
  return THEMES.some((theme) => theme.id === themeId);
}
