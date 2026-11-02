/**
 * Client-side mirror of the backend theme-config section schema
 * (ezPosBackend/src/modules/storefronts/themeConfig.schema.ts). The backend
 * validates on every write and at publish; the renderer only needs the
 * shape for typed rendering and tolerates unknown extra keys.
 */

export interface StorefrontSection {
  id: string;
  type:
    | "announcement"
    | "hero"
    | "featured-categories"
    | "featured-products"
    | "best-sellers"
    | "new-arrivals"
    | "promo-banners"
    | "brands"
    | "testimonials"
    | "newsletter"
    | (string & {});
  enabled: boolean;
  props: Record<string, unknown>;
}

export interface StorefrontConfigShape {
  tokens?: Record<string, string>;
  sections?: StorefrontSection[];
  navigation?: {
    header?: Array<{ label: string; href: string }>;
    footer?: Array<{ label: string; href: string }>;
  };
}
