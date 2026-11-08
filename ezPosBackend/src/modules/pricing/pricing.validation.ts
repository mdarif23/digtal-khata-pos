import { z } from "zod";

/**
 * Zod schemas for the pricing module (Phase 1: settings + preview). Patterns
 * follow uom.validation.ts / finance schemas: coerce ids, explicit enums,
 * cross-field refinements mirroring the DB CHECKs (margin < 100, fixed ⇔
 * no percentage).
 */

export const pricingMethodSchema = z.enum(["fixed", "markup", "margin"]);
export const roundingIncrementSchema = z.enum(["none", "0.01", "1", "5", "10"]);
export const roundingDirectionSchema = z.enum(["nearest", "up", "down"]);

/** Full, strict settings object (validated AFTER merging with the current row). */
export const pricingSettingsStrictSchema = z
  .object({
    defaultMethod: pricingMethodSchema,
    defaultPercentage: z.number().min(0).max(100).nullable(),
    roundingIncrement: roundingIncrementSchema,
    roundingDirection: roundingDirectionSchema,
    autoUpdateEnabled: z.boolean(),
    autoUpdateFixedPrices: z.boolean(),
    minMarginPercent: z.number().min(0).max(100).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.defaultMethod === "fixed") {
      if (value.defaultPercentage !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["defaultPercentage"],
          message: "Fixed pricing does not take a percentage.",
        });
      }
      return;
    }
    if (value.defaultPercentage === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultPercentage"],
        message: "Markup/margin pricing requires a percentage.",
      });
      return;
    }
    if (value.defaultMethod === "margin" && value.defaultPercentage >= 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultPercentage"],
        message: "Margin percentage must be below 100%.",
      });
    }
  });

/** Partial PUT payload — merged with the existing row (or defaults) first. */
export const pricingSettingsUpdateSchema = z.object({
  defaultMethod: pricingMethodSchema.optional(),
  defaultPercentage: z.number().min(0).max(100).nullable().optional(),
  roundingIncrement: roundingIncrementSchema.optional(),
  roundingDirection: roundingDirectionSchema.optional(),
  autoUpdateEnabled: z.boolean().optional(),
  autoUpdateFixedPrices: z.boolean().optional(),
  minMarginPercent: z.number().min(0).max(100).nullable().optional(),
});

export type PricingSettingsUpdate = z.infer<typeof pricingSettingsUpdateSchema>;

export const pricingPreviewSchema = z
  .object({
    variantIds: z
      .array(z.coerce.number().int().positive())
      .min(1)
      .max(500),
    // Optional what-if override of the effective configuration.
    method: pricingMethodSchema.optional(),
    percentage: z.number().min(0).max(100).nullable().optional(),
    fixedPrice: z.number().min(0).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.method === undefined) return;
    if (value.method === "fixed") {
      if (value.fixedPrice == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fixedPrice"],
          message: "A fixed-price preview requires fixedPrice.",
        });
      }
      return;
    }
    if (value.percentage == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["percentage"],
        message: "A markup/margin preview requires percentage.",
      });
      return;
    }
    if (value.method === "margin" && value.percentage >= 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["percentage"],
        message: "Margin percentage must be below 100%.",
      });
    }
  });

export type PricingPreviewInput = z.infer<typeof pricingPreviewSchema>;
