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

// ---------------------------------------------------------------------------
// Rules (Phase 2) — scope XOR-or-all-NULL and method consistency mirror the
// DB CHECKs (pricing_rules_scope_check / pricing_rules_method_check).
// ---------------------------------------------------------------------------

const scopeFields = {
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  productId: z.coerce.number().int().positive().nullable().optional(),
  variantId: z.coerce.number().int().positive().nullable().optional(),
};

function refineRuleShape(
  value: {
    categoryId: number | null;
    productId: number | null;
    variantId: number | null;
    method: "fixed" | "markup" | "margin";
    percentage: number | null;
    fixedPrice: number | null;
  },
  ctx: z.RefinementCtx,
): void {
  const scopes = [value.categoryId, value.productId, value.variantId];
  const setCount = scopes.filter((s) => s != null).length;
  if (setCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["categoryId"],
      message: "A rule belongs to exactly one scope (category, product or variant) or the whole business.",
    });
  }
  if (value.method === "fixed") {
    if (value.fixedPrice == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixedPrice"],
        message: "Fixed rules require fixedPrice.",
      });
    }
    if (value.percentage != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["percentage"],
        message: "Fixed rules do not take a percentage.",
      });
    }
    return;
  }
  if (value.fixedPrice != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fixedPrice"],
      message: "Percentage rules do not take a fixedPrice.",
    });
  }
  if (value.percentage == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["percentage"],
      message: "Markup/margin rules require a percentage.",
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
}

/** Full, strict rule object (validated AFTER merging with the current row). */
export const pricingRuleStrictSchema = z
  .object({
    categoryId: z.coerce.number().int().positive().nullable(),
    productId: z.coerce.number().int().positive().nullable(),
    variantId: z.coerce.number().int().positive().nullable(),
    method: pricingMethodSchema,
    percentage: z.number().min(0).max(100).nullable(),
    fixedPrice: z.number().min(0).nullable(),
    isActive: z.boolean(),
  })
  .superRefine(refineRuleShape);

export const pricingRuleCreateSchema = z
  .object({
    ...scopeFields,
    method: pricingMethodSchema,
    percentage: z.number().min(0).max(100).nullable().optional(),
    fixedPrice: z.number().min(0).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((value, ctx) =>
    refineRuleShape(
      {
        categoryId: value.categoryId ?? null,
        productId: value.productId ?? null,
        variantId: value.variantId ?? null,
        method: value.method,
        percentage: value.percentage ?? null,
        fixedPrice: value.fixedPrice ?? null,
      },
      ctx,
    ),
  );

export type PricingRuleCreate = z.infer<typeof pricingRuleCreateSchema>;

export const pricingRuleUpdateSchema = z
  .object({
    ...scopeFields,
    method: pricingMethodSchema.optional(),
    percentage: z.number().min(0).max(100).nullable().optional(),
    fixedPrice: z.number().min(0).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (value) =>
      Object.keys(value).length > 0 &&
      Object.values(value).some((v) => v !== undefined),
    "Nothing to update.",
  );

export type PricingRuleUpdate = z.infer<typeof pricingRuleUpdateSchema>;

// ---------------------------------------------------------------------------
// Materialize + history (Phase 2)
// ---------------------------------------------------------------------------

export const applyPriceSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export const priceHistoryQuerySchema = z.object({
  variantId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
