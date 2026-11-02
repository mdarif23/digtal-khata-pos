/**
 * Pure helpers for the Online Store editors — no React, no fetch, fully
 * unit-testable. Shapes mirror the backend theme contract
 * (ezPosBackend/src/modules/storefronts/themeConfig.schema.ts).
 */

export interface StorefrontSection {
  id: string;
  type: string;
  enabled: boolean;
  props: Record<string, unknown>;
}

export interface StorefrontConfig {
  tokens: Record<string, string>;
  sections: StorefrontSection[];
  navigation?: {
    header: Array<{ label: string; href: string }>;
    footer: Array<{ label: string; href: string }>;
  };
}

/** Human labels for the section types the backend schema accepts. */
export const SECTION_TYPE_LABELS: Record<string, string> = {
  announcement: "Announcement bar",
  hero: "Hero banner",
  "featured-categories": "Featured categories",
  "featured-products": "Featured products",
  "best-sellers": "Best sellers",
  "new-arrivals": "New arrivals",
  "promo-banners": "Promotional banners",
  brands: "Brand strip",
  testimonials: "Testimonials",
  newsletter: "Newsletter",
};

/** Types the customer can add from the editor; order = gallery order. */
export const ADDABLE_SECTION_TYPES = [
  "hero",
  "announcement",
  "featured-categories",
  "featured-products",
  "best-sellers",
  "new-arrivals",
  "promo-banners",
  "brands",
  "testimonials",
  "newsletter",
] as const;

export type AddableSectionType = (typeof ADDABLE_SECTION_TYPES)[number];

let sectionCounter = 0;

/** A minimal valid section of the given type (schema-safe defaults). */
export function createSection(type: AddableSectionType): StorefrontSection {
  sectionCounter += 1;
  const id = `${type}-${Date.now()}-${sectionCounter}`;
  switch (type) {
    case "hero":
      return {
        id,
        type,
        enabled: true,
        props: { heading: "New banner", align: "left", overlayOpacity: 0 },
      };
    case "announcement":
      return { id, type, enabled: true, props: { text: "Announce something" } };
    case "featured-categories":
      return {
        id,
        type,
        enabled: true,
        props: { heading: "Shop by category", categoryIds: [] },
      };
    case "featured-products":
      return {
        id,
        type,
        enabled: true,
        props: { heading: "Featured products", productIds: [] },
      };
    case "best-sellers":
    case "new-arrivals":
      return { id, type, enabled: true, props: { heading: "Products", limit: 8 } };
    case "promo-banners":
      return {
        id,
        type,
        enabled: true,
        props: { heading: "Offers", banners: [{ heading: "Special offer" }] },
      };
    case "brands":
      return { id, type, enabled: true, props: { heading: "Our brands", brandIds: [] } };
    case "testimonials":
      return {
        id,
        type,
        enabled: true,
        props: {
          heading: "What customers say",
          items: [{ quote: "Great shop!", authorName: "Happy customer" }],
        },
      };
    case "newsletter":
      return {
        id,
        type,
        enabled: true,
        props: { heading: "Newsletter", buttonLabel: "Subscribe" },
      };
  }
}

function parseConfig(config: unknown): StorefrontConfig {
  const raw = (config ?? {}) as Record<string, unknown>;
  return {
    tokens: (raw.tokens ?? {}) as Record<string, string>,
    sections: Array.isArray(raw.sections)
      ? (raw.sections as StorefrontSection[])
      : [],
  };
}

export function toggleSection(config: unknown, sectionId: string): StorefrontConfig {
  const next = parseConfig(config);
  return {
    ...next,
    sections: next.sections.map((section) =>
      section.id === sectionId
        ? { ...section, enabled: !section.enabled }
        : section,
    ),
  };
}

/** Moves a section one position up (-1) or down (+1). */
export function moveSection(
  config: unknown,
  sectionId: string,
  direction: -1 | 1,
): StorefrontConfig {
  const next = parseConfig(config);
  const index = next.sections.findIndex((s) => s.id === sectionId);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= next.sections.length) return next;
  const sections = [...next.sections];
  const [moved] = sections.splice(index, 1);
  if (!moved) return next;
  sections.splice(target, 0, moved);
  return { ...next, sections };
}

export function removeSection(config: unknown, sectionId: string): StorefrontConfig {
  const next = parseConfig(config);
  return {
    ...next,
    sections: next.sections.filter((s) => s.id !== sectionId),
  };
}

export function updateSectionProps(
  config: unknown,
  sectionId: string,
  props: Record<string, unknown>,
): StorefrontConfig {
  const next = parseConfig(config);
  return {
    ...next,
    sections: next.sections.map((section) =>
      section.id === sectionId
        ? { ...section, props: { ...section.props, ...props } }
        : section,
    ),
  };
}

export const TOKEN_FIELDS: Array<{
  key: string;
  label: string;
  kind: "color" | "select";
  options?: Array<{ value: string; label: string }>;
}> = [
  { key: "primaryColor", label: "Primary color", kind: "color" },
  { key: "secondaryColor", label: "Secondary color", kind: "color" },
  { key: "backgroundColor", label: "Background", kind: "color" },
  { key: "textColor", label: "Text color", kind: "color" },
  {
    key: "fontHeading",
    label: "Heading font",
    kind: "select",
    options: [
      { value: "system", label: "System" },
      { value: "inter", label: "Inter" },
      { value: "poppins", label: "Poppins" },
      { value: "roboto", label: "Roboto" },
      { value: "playfair", label: "Playfair" },
      { value: "lora", label: "Lora" },
    ],
  },
  {
    key: "fontBody",
    label: "Body font",
    kind: "select",
    options: [
      { value: "system", label: "System" },
      { value: "inter", label: "Inter" },
      { value: "poppins", label: "Poppins" },
      { value: "roboto", label: "Roboto" },
      { value: "playfair", label: "Playfair" },
      { value: "lora", label: "Lora" },
    ],
  },
  {
    key: "radius",
    label: "Corner radius",
    kind: "select",
    options: [
      { value: "none", label: "Square" },
      { value: "sm", label: "Small" },
      { value: "md", label: "Medium" },
      { value: "lg", label: "Large" },
    ],
  },
  {
    key: "buttonStyle",
    label: "Button style",
    kind: "select",
    options: [
      { value: "solid", label: "Solid" },
      { value: "outline", label: "Outline" },
      { value: "pill", label: "Pill" },
    ],
  },
  {
    key: "productCardStyle",
    label: "Product card",
    kind: "select",
    options: [
      { value: "minimal", label: "Minimal" },
      { value: "bordered", label: "Bordered" },
      { value: "elevated", label: "Elevated" },
    ],
  },
  {
    key: "headerLayout",
    label: "Header layout",
    kind: "select",
    options: [
      { value: "classic", label: "Classic" },
      { value: "centered", label: "Centered" },
      { value: "minimal", label: "Minimal" },
    ],
  },
];

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  preview: "Preview",
  published: "Published",
  suspended: "Suspended",
  archived: "Archived",
};

/** Subdomain form UX: quick client-side sanity before hitting the API. */
export function looksLikeSubdomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(value) && value.length >= 3;
}

/** Page slug sanity mirroring the backend validation. */
export function looksLikePageSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
