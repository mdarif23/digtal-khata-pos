import { z } from "zod";

/**
 * Zod schemas for promotional campaigns (Bundle & Combo Phase 4). Mirrors
 * the DB CHECKs on promotion_campaigns: date order (starts_at <= ends_at).
 * Date-only 'YYYY-MM-DD' boundaries are interpreted on the BUSINESS
 * calendar by the service (the promotions I3-6 pattern).
 */

const timestampField = z.coerce.date().nullable();

function refineCampaignShape(
  value: {
    startsAt?: Date | string | null | undefined;
    endsAt?: Date | string | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.startsAt && value.endsAt && value.startsAt > value.endsAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endsAt"],
      message: "startsAt must be before endsAt.",
    });
  }
}

export const campaignCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable().optional(),
    startsAt: timestampField.nullable().optional(),
    endsAt: timestampField.nullable().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    locationId: z.coerce.number().int().positive().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine(refineCampaignShape);

export const campaignUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    startsAt: timestampField.nullable().optional(),
    endsAt: timestampField.nullable().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    locationId: z.coerce.number().int().positive().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine(refineCampaignShape)
  .refine(
    (value) =>
      Object.keys(value).length > 0 &&
      Object.values(value).some((v) => v !== undefined),
    "Nothing to update.",
  );

export type CampaignCreate = z.infer<typeof campaignCreateSchema>;
export type CampaignUpdate = z.infer<typeof campaignUpdateSchema>;
