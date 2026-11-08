import { z } from "zod";

/**
 * Zod schemas for auto-applied promotions (Phase 5, approved design §13.6).
 * Mirrors the DB CHECKs on pricing_promotions: scope XOR-or-all-NULL,
 * percentage ≤ 100, date order (starts_at ≤ ends_at).
 */

const scopeFields = {
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  productId: z.coerce.number().int().positive().nullable().optional(),
  variantId: z.coerce.number().int().positive().nullable().optional(),
};

function refinePromotionShape(
  value: {
    categoryId: number | null;
    productId: number | null;
    variantId: number | null;
    discountType: "percentage" | "fixed";
    discountValue: number;
    startsAt: Date | null;
    endsAt: Date | null;
  },
  ctx: z.RefinementCtx,
): void {
  const scopes = [value.categoryId, value.productId, value.variantId];
  const setCount = scopes.filter((s) => s != null).length;
  if (setCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["categoryId"],
      message:
        "A promotion belongs to exactly one scope (category, product or variant) or the whole business.",
    });
  }
  if (value.discountType === "percentage" && value.discountValue > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["discountValue"],
      message: "Percentage discounts cannot exceed 100%.",
    });
  }
  if (value.startsAt && value.endsAt && value.startsAt > value.endsAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endsAt"],
      message: "startsAt must be before endsAt.",
    });
  }
}

const timestampField = z.coerce.date().nullable();

/** Full, strict promotion object (validated AFTER merging with the row). */
export const promotionStrictSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    categoryId: z.coerce.number().int().positive().nullable(),
    productId: z.coerce.number().int().positive().nullable(),
    variantId: z.coerce.number().int().positive().nullable(),
    discountType: z.enum(["percentage", "fixed"]),
    discountValue: z.number().min(0),
    startsAt: timestampField,
    endsAt: timestampField,
    minQuantity: z.number().int().min(1).nullable(),
    minOrderValue: z.number().min(0),
    maxDiscountAmount: z.number().min(0).nullable(),
    canStackWithGroupDiscount: z.boolean(),
    canStackWithCoupons: z.boolean(),
    isActive: z.boolean(),
  })
  .superRefine(refinePromotionShape);

export const promotionCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    ...scopeFields,
    discountType: z.enum(["percentage", "fixed"]),
    discountValue: z.number().min(0),
    startsAt: timestampField.optional(),
    endsAt: timestampField.optional(),
    minQuantity: z.number().int().min(1).nullable().optional(),
    minOrderValue: z.number().min(0).optional(),
    maxDiscountAmount: z.number().min(0).nullable().optional(),
    canStackWithGroupDiscount: z.boolean().optional(),
    canStackWithCoupons: z.boolean().optional(),
    isActive: z.boolean().optional(),
    /** Group eligibility: absent/empty = every customer (incl. walk-ins). */
    groupIds: z.array(z.coerce.number().int().positive()).max(100).optional(),
  })
  .superRefine((value, ctx) =>
    refinePromotionShape(
      {
        categoryId: value.categoryId ?? null,
        productId: value.productId ?? null,
        variantId: value.variantId ?? null,
        discountType: value.discountType,
        discountValue: value.discountValue,
        startsAt: value.startsAt ?? null,
        endsAt: value.endsAt ?? null,
      },
      ctx,
    ),
  );

export type PromotionCreate = z.infer<typeof promotionCreateSchema>;

export const promotionUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    ...scopeFields,
    discountType: z.enum(["percentage", "fixed"]).optional(),
    discountValue: z.number().min(0).optional(),
    startsAt: timestampField.optional(),
    endsAt: timestampField.optional(),
    minQuantity: z.number().int().min(1).nullable().optional(),
    minOrderValue: z.number().min(0).optional(),
    maxDiscountAmount: z.number().min(0).nullable().optional(),
    canStackWithGroupDiscount: z.boolean().optional(),
    canStackWithCoupons: z.boolean().optional(),
    isActive: z.boolean().optional(),
    /** Present (even empty) = replace the eligibility list. */
    groupIds: z.array(z.coerce.number().int().positive()).max(100).optional(),
  })
  .refine(
    (value) =>
      Object.keys(value).length > 0 &&
      Object.values(value).some((v) => v !== undefined),
    "Nothing to update.",
  );

export type PromotionUpdate = z.infer<typeof promotionUpdateSchema>;
