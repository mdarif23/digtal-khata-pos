import { z } from "zod";

/** Request validation for the hosted-storefront portal module. */

export const createStorefrontSchema = z.object({
  name: z.string().trim().min(2, "Enter a store name").max(100),
  themeId: z.string().trim().min(1).max(50),
  subdomain: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(63)
    .regex(
      /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/,
      "Use only lowercase letters, numbers and hyphens.",
    )
    .optional(),
});

const seoSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
    description: z.string().trim().max(300).optional(),
    ogImageMediaId: z.number().int().positive().optional(),
  })
  .nullable();

const contactSchema = z
  .object({
    phone: z.string().trim().max(20).optional(),
    email: z.string().trim().email().max(255).optional(),
    address: z.string().trim().max(500).optional(),
    social: z
      .object({
        facebook: z.string().trim().max(200).optional(),
        instagram: z.string().trim().max(200).optional(),
        whatsapp: z.string().trim().max(200).optional(),
      })
      .optional(),
  })
  .nullable();

export const updateStorefrontSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    themeId: z.string().trim().min(1).max(50).optional(),
    seo: seoSchema.optional(),
    contact: contactSchema.optional(),
    storePickupEnabled: z.boolean().optional(),
    analyticsEnabled: z.boolean().optional(),
    searchIndexingEnabled: z.boolean().optional(),
    shopperAccountsEnabled: z.boolean().optional(),
  })
  .strict();

/** draftConfig is validated against the theme schema in the service. */
export const updateDraftConfigSchema = z.object({
  draftConfig: z.unknown(),
});

export const changeSubdomainSchema = z.object({
  subdomain: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(63)
    .regex(
      /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/,
      "Use only lowercase letters, numbers and hyphens.",
    ),
});

export const addDomainSchema = z.object({
  domain: z.string().trim().min(4).max(253),
});

// ---------------------------------------------------------------------------
// Content pages
// ---------------------------------------------------------------------------

export const pageSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(100)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Slug may contain lowercase letters, numbers and hyphens.",
  );

const pageText = (max: number) => z.string().trim().min(1).max(max);

export const pageBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), text: pageText(120), level: z.number().int().min(1).max(4).default(2) }),
  z.object({ type: z.literal("paragraph"), text: pageText(2000) }),
  z.object({ type: z.literal("image"), url: pageText(500), alt: z.string().trim().max(200).optional() }),
  z.object({
    type: z.literal("faq"),
    items: z
      .array(z.object({ question: pageText(200), answer: pageText(1000) }))
      .min(1)
      .max(20),
  }),
  z.object({ type: z.literal("contact") }),
]);

export const createPageSchema = z.object({
  slug: pageSlugSchema,
  title: z.string().trim().min(1).max(200),
  blocks: z.array(pageBlockSchema).max(100).default([]),
  seoTitle: z.string().trim().max(200).optional(),
  seoDescription: z.string().trim().max(300).optional(),
  isPublished: z.boolean().default(true),
});

export const updatePageSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    blocks: z.array(pageBlockSchema).max(100).optional(),
    seoTitle: z.string().trim().max(200).nullable().optional(),
    seoDescription: z.string().trim().max(300).nullable().optional(),
    isPublished: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Product visibility
// ---------------------------------------------------------------------------

export const upsertVisibilitySchema = z.object({
  published: z.boolean().optional(),
  featured: z.boolean().optional(),
  seoTitle: z.string().trim().max(200).nullable().optional(),
  seoDescription: z.string().trim().max(300).nullable().optional(),
  websiteImageUrls: z.array(pageText(500)).max(10).optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

// ---------------------------------------------------------------------------
// Delivery zones
// ---------------------------------------------------------------------------

export const createZoneSchema = z.object({
  name: z.string().trim().min(1).max(100),
  areas: z.array(pageText(100)).min(1).max(50),
  rate: z.number().min(0).max(1_000_000),
  freeThreshold: z.number().min(0).max(1_000_000).optional(),
  estimatedDaysMin: z.number().int().min(0).max(60).optional(),
  estimatedDaysMax: z.number().int().min(0).max(60).optional(),
});

export const updateZoneSchema = createZoneSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict();

// ---------------------------------------------------------------------------
// Payment methods (config only — capture lands in the payments stage)
// ---------------------------------------------------------------------------

export const paymentMethodEnum = z.enum(["cod", "sslcommerz"]);

export const updatePaymentMethodsSchema = z.object({
  methods: z
    .array(
      z.object({
        method: paymentMethodEnum,
        enabled: z.boolean(),
        label: z.string().trim().max(100).optional(),
      }),
    )
    .max(2),
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const presignMediaSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(3).max(100),
  sizeBytes: z.number().int().min(1),
});

export const registerMediaSchema = z.object({
  objectKey: z.string().trim().min(10).max(300),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(3).max(100),
  bytes: z.number().int().min(1),
  width: z.number().int().min(1).max(20000).optional(),
  height: z.number().int().min(1).max(20000).optional(),
});
