import { z } from "zod";

/**
 * Backend-authoritative schema for storefront theme configuration.
 *
 * This is the shared contract between the portal editor (writes draft_config),
 * publish snapshots, and the ezPosStorefront renderer (consumes published
 * configs). Customers can only express structured values here — never code.
 * Each theme in themes.catalog.ts builds on these primitives; the renderer's
 * theme registry must tolerate unknown extra keys so new themes can extend
 * props without breaking older snapshots.
 */

const MAX_SECTIONS = 20;

/** http(s) URL or an app-relative path like "/products/42". */
const urlOrPath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      value.startsWith("/") ||
      /^https?:\/\/[^\s]+$/i.test(value),
    "Must be an https:// URL or a path starting with /.",
  );

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex color like #7c3aed.");

export const storefrontTokensSchema = z.object({
  primaryColor: hexColor.default("#16a34a"),
  secondaryColor: hexColor.default("#0f172a"),
  backgroundColor: hexColor.default("#ffffff"),
  textColor: hexColor.default("#0f172a"),
  fontHeading: z
    .enum(["system", "inter", "poppins", "roboto", "playfair", "lora"])
    .default("inter"),
  fontBody: z
    .enum(["system", "inter", "poppins", "roboto", "playfair", "lora"])
    .default("inter"),
  radius: z.enum(["none", "sm", "md", "lg"]).default("md"),
  containerWidth: z.enum(["narrow", "normal", "wide"]).default("normal"),
  buttonStyle: z.enum(["solid", "outline", "pill"]).default("solid"),
  productCardStyle: z.enum(["minimal", "bordered", "elevated"]).default("bordered"),
  headerLayout: z.enum(["classic", "centered", "minimal"]).default("classic"),
  footerLayout: z.enum(["columns", "simple"]).default("columns"),
});

const baseSectionShape = {
  id: z.string().trim().min(1).max(50),
  enabled: z.boolean().default(true),
};

const announcementSchema = z.object({
  ...baseSectionShape,
  type: z.literal("announcement"),
  props: z.object({
    text: z.string().trim().min(1).max(200),
    linkUrl: urlOrPath.optional(),
    backgroundColor: hexColor.optional(),
    textColor: hexColor.optional(),
  }),
});

const heroSchema = z.object({
  ...baseSectionShape,
  type: z.literal("hero"),
  props: z.object({
    heading: z.string().trim().min(1).max(120),
    subheading: z.string().trim().max(240).optional(),
    imageUrl: urlOrPath.optional(),
    ctaLabel: z.string().trim().max(40).optional(),
    ctaHref: urlOrPath.optional(),
    align: z.enum(["left", "center", "right"]).default("left"),
    overlayOpacity: z.number().int().min(0).max(100).default(0),
  }),
});

const featuredCategoriesSchema = z.object({
  ...baseSectionShape,
  type: z.literal("featured-categories"),
  props: z.object({
    heading: z.string().trim().max(80).optional(),
    categoryIds: z.array(z.number().int().positive()).max(12).default([]),
  }),
});

const featuredProductsSchema = z.object({
  ...baseSectionShape,
  type: z.literal("featured-products"),
  props: z.object({
    heading: z.string().trim().max(80).optional(),
    productIds: z.array(z.number().int().positive()).max(12).default([]),
  }),
});

const productListSchema = z.object({
  ...baseSectionShape,
  type: z.enum(["best-sellers", "new-arrivals"]),
  props: z.object({
    heading: z.string().trim().max(80).optional(),
    limit: z.number().int().min(1).max(12).default(8),
  }),
});

const promoBannersSchema = z.object({
  ...baseSectionShape,
  type: z.literal("promo-banners"),
  props: z.object({
    heading: z.string().trim().max(80).optional(),
    banners: z
      .array(
        z.object({
          imageUrl: urlOrPath.optional(),
          heading: z.string().trim().max(80).optional(),
          subheading: z.string().trim().max(160).optional(),
          ctaLabel: z.string().trim().max(40).optional(),
          ctaHref: urlOrPath.optional(),
        }),
      )
      .min(1)
      .max(4),
  }),
});

const brandsSchema = z.object({
  ...baseSectionShape,
  type: z.literal("brands"),
  props: z.object({
    heading: z.string().trim().max(80).optional(),
    brandIds: z.array(z.number().int().positive()).max(12).default([]),
  }),
});

const testimonialsSchema = z.object({
  ...baseSectionShape,
  type: z.literal("testimonials"),
  props: z.object({
    heading: z.string().trim().max(80).optional(),
    items: z
      .array(
        z.object({
          quote: z.string().trim().min(1).max(400),
          authorName: z.string().trim().min(1).max(80),
          authorTitle: z.string().trim().max(80).optional(),
          avatarUrl: urlOrPath.optional(),
        }),
      )
      .min(1)
      .max(9),
  }),
});

const newsletterSchema = z.object({
  ...baseSectionShape,
  type: z.literal("newsletter"),
  props: z.object({
    heading: z.string().trim().max(80).optional(),
    subheading: z.string().trim().max(160).optional(),
    buttonLabel: z.string().trim().max(40).optional(),
  }),
});

export const storefrontSectionSchema = z.discriminatedUnion("type", [
  announcementSchema,
  heroSchema,
  featuredCategoriesSchema,
  featuredProductsSchema,
  productListSchema,
  promoBannersSchema,
  brandsSchema,
  testimonialsSchema,
  newsletterSchema,
]);

/**
 * Storefront navigation links. href is an app path (/products, /pages/about)
 * or an absolute https URL; arbitrary JavaScript is impossible by schema.
 */
const navLinkSchema = z.object({
  label: z.string().trim().min(1).max(60),
  href: urlOrPath,
});

export const storefrontNavigationSchema = z
  .object({
    header: z.array(navLinkSchema).max(8).default([]),
    footer: z.array(navLinkSchema).max(12).default([]),
  })
  .prefault({});

export const storefrontThemeConfigSchema = z
  .object({
    tokens: storefrontTokensSchema.prefault({}),
    sections: z.array(storefrontSectionSchema).max(MAX_SECTIONS).default([]),
    navigation: storefrontNavigationSchema.optional(),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const section of config.sections) {
      if (seen.has(section.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate section id "${section.id}".`,
          path: ["sections"],
        });
        return;
      }
      seen.add(section.id);
    }
  });

export type StorefrontThemeConfig = z.infer<typeof storefrontThemeConfigSchema>;
export type StorefrontSection = z.infer<typeof storefrontSectionSchema>;
export type StorefrontTokens = z.infer<typeof storefrontTokensSchema>;
