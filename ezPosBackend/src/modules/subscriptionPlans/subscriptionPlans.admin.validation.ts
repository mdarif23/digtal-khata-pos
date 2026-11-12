import { z } from "zod";

const planLimitsSchema = z
  .object({
    maxUsers: z.number().int().min(1).max(100000).optional(),
    maxLocations: z.number().int().min(1).max(10000).optional(),
    maxProducts: z.number().int().min(1).max(1000000).optional(),
    maxConnectedStores: z.number().int().min(1).max(1000).optional(),
    maxWebhookEndpoints: z.number().int().min(1).max(1000).optional(),
    maxStorefronts: z.number().int().min(1).max(1000).optional(),
    maxCustomDomains: z.number().int().min(1).max(1000).optional(),
    maxMediaStorageMb: z.number().int().min(1).max(1000000).optional(),
  })
  .optional();

const planFeaturesSchema = z
  .object({
    multiLocation: z.boolean().optional(),
    advancedReports: z.boolean().optional(),
    exports: z.boolean().optional(),
    purchaseManagement: z.boolean().optional(),
    storefrontApi: z.boolean().optional(),
    woocommerceIntegration: z.boolean().optional(),
    customStorefront: z.boolean().optional(),
    multipleOnlineStores: z.boolean().optional(),
    advancedWebhooks: z.boolean().optional(),
    hostedStorefront: z.boolean().optional(),
    storefrontCustomDomains: z.boolean().optional(),
    premiumThemes: z.boolean().optional(),
    storefrontAnalytics: z.boolean().optional(),
  })
  .optional();

export const createPlanSchema = z.object({
  name: z.string().trim().min(2, "Enter a plan name").max(100),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits, and dashes")
    .max(50)
    .optional(),
  description: z.string().trim().max(500).optional(),
  interval: z.enum(["monthly", "yearly"]),
  price: z.number().min(0).max(99999999),
  currency: z.string().trim().length(3).optional(),
  limits: planLimitsSchema,
  features: planFeaturesSchema,
  trialDays: z.number().int().min(0).max(365).nullish(),
  isPopular: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  supportLevel: z.string().trim().max(30).nullish(),
  isActive: z.boolean().optional(),
});

export type CreatePlanInput = z.infer<typeof createPlanSchema>;

export const updatePlanSchema = createPlanSchema.partial();
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
