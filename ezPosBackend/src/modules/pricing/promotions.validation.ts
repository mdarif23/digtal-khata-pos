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
    startsAt: Date | string | null;
    endsAt: Date | string | null;
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
// I3-6: date-only 'YYYY-MM-DD' boundaries arrive as STRINGS and are
// interpreted on the business calendar by the service (00:00:00 for starts,
// 23:59:59.999 for ends). Full ISO timestamps keep working unchanged.
const dateOnlyPattern = /^d{4}-d{2}-d{2}$/;
const dateBoundField = z
  .union([z.string().regex(dateOnlyPattern), z.coerce.date()])
  .nullable();

/**
 * H3-1: the engine silently SKIPS promotions whose rule doesn't match the
 * kind's contract — a merchant could ship an "active" buy_x_get_y that
 * never discounts anything. Each kind's rule is validated at write time.
 */
function refineRuleForKind(
  value: {
    promoKind?: string | undefined;
    rule?: Record<string, unknown> | null | undefined;
    categoryId?: number | null | undefined;
    productId?: number | null | undefined;
    variantId?: number | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const kind = value.promoKind;
  if (!kind || kind === "discount") return;
  const rule = (value.rule ?? {}) as Record<string, unknown>;
  const num = (key: string): number | null =>
    typeof rule[key] === "number" && Number.isFinite(rule[key])
      ? (rule[key] as number)
      : null;
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (kind === "bundle") {
    // The component list IS the scope — category/product/variant scope on a
    // bundle would silently mean nothing, so it is rejected outright.
    if (
      value.categoryId != null ||
      value.productId != null ||
      value.variantId != null
    ) {
      issue(
        "categoryId",
        "A bundle's components define its scope — leave category/product/variant empty.",
      );
    }
    const price = num("bundlePrice");
    const percent = num("discountPercent");
    if (price == null && percent == null) {
      issue(
        "rule",
        "A bundle needs exactly one of bundlePrice (special package price) or discountPercent.",
      );
    }
    if (price != null && percent != null) {
      issue(
        "rule",
        "Set either bundlePrice or discountPercent for a bundle — not both.",
      );
    }
    if (percent != null && percent > 100) {
      issue("rule", "Bundle discount percent cannot exceed 100%.");
    }
    const maxApps = num("maxApplications");
    if (maxApps != null && maxApps < 1) {
      issue("rule", "maxApplications must be at least 1 when provided.");
    }
    return;
  }
  if (kind === "bogo") {
    if ((num("buyQty") ?? 1) < 1 || (num("getQty") ?? 1) < 1) {
      issue("rule", "BOGO needs buy and free quantities of at least 1.");
    }
  } else if (kind === "buy_x_get_y") {
    const buyTarget = num("buyVariantId") ?? num("buyProductId");
    const getTarget = num("getVariantId") ?? num("getProductId");
    if (buyTarget == null) {
      issue("rule", "Buy X get Y needs a product or variant to buy.");
    }
    if (getTarget == null) {
      issue("rule", "Buy X get Y needs a product or variant to give free.");
    }
    if ((num("buyQty") ?? 0) < 1 || (num("getQty") ?? 0) < 1) {
      issue("rule", "Buy X get Y needs buy and free quantities of at least 1.");
    }
  } else if (kind === "mix_match") {
    const percent = num("discountPercent") ?? 0;
    if ((num("comboSize") ?? 0) < 2) {
      issue("rule", "Mix & match needs a combo size of at least 2 units.");
    }
    if (percent <= 0 || percent > 100) {
      issue("rule", "Mix & match discount must be between 1% and 100%.");
    }
  } else if (kind === "quantity_tier") {
    const tiers = Array.isArray(rule.tiers) ? rule.tiers : [];
    if (tiers.length === 0) {
      issue("rule", "Quantity tier promotions need at least one tier.");
    }
  }
}

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
    // ---- Phase 3 (Feature 8) ----
    promoKind: z
      .enum(["discount", "bogo", "buy_x_get_y", "mix_match", "quantity_tier", "bundle"])
      .default("discount"),
    rule: z.record(z.string(), z.unknown()).nullable().optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    locationId: z.coerce.number().int().positive().nullable().optional(),
    usageLimit: z.number().int().min(1).nullable().optional(),
    perCustomerLimit: z.number().int().min(1).nullable().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    isActive: z.boolean(),
  })
  .superRefine(refinePromotionShape)
  .superRefine(refineRuleForKind);

export const promotionCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    ...scopeFields,
    discountType: z.enum(["percentage", "fixed"]),
    discountValue: z.number().min(0),
    startsAt: dateBoundField.optional(),
    endsAt: dateBoundField.optional(),
    minQuantity: z.number().int().min(1).nullable().optional(),
    minOrderValue: z.number().min(0).optional(),
    maxDiscountAmount: z.number().min(0).nullable().optional(),
    canStackWithGroupDiscount: z.boolean().optional(),
    canStackWithCoupons: z.boolean().optional(),
    promoKind: z
      .enum(["discount", "bogo", "buy_x_get_y", "mix_match", "quantity_tier", "bundle"])
      .optional(),
    rule: z.record(z.string(), z.unknown()).nullable().optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    locationId: z.coerce.number().int().positive().nullable().optional(),
    usageLimit: z.number().int().min(1).nullable().optional(),
    perCustomerLimit: z.number().int().min(1).nullable().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    isActive: z.boolean().optional(),
    /** Group eligibility: absent/empty = every customer (incl. walk-ins). */
    groupIds: z.array(z.coerce.number().int().positive()).max(100).optional(),
    /** Bundle components (bundle kind only): the exact package contents. */
    components: z
      .array(
        z.object({
          variantId: z.coerce.number().int().positive(),
          quantity: z.coerce.number().positive().max(1_000_000),
        }),
      )
      .max(100)
      .optional(),
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
  )
  .superRefine((value, ctx) => refineRuleForKind(value, ctx));

export type PromotionCreate = z.infer<typeof promotionCreateSchema>;

export const promotionUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    ...scopeFields,
    discountType: z.enum(["percentage", "fixed"]).optional(),
    discountValue: z.number().min(0).optional(),
    startsAt: dateBoundField.optional(),
    endsAt: dateBoundField.optional(),
    minQuantity: z.number().int().min(1).nullable().optional(),
    minOrderValue: z.number().min(0).optional(),
    maxDiscountAmount: z.number().min(0).nullable().optional(),
    canStackWithGroupDiscount: z.boolean().optional(),
    canStackWithCoupons: z.boolean().optional(),
    promoKind: z
      .enum(["discount", "bogo", "buy_x_get_y", "mix_match", "quantity_tier", "bundle"])
      .optional(),
    rule: z.record(z.string(), z.unknown()).nullable().optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    locationId: z.coerce.number().int().positive().nullable().optional(),
    usageLimit: z.number().int().min(1).nullable().optional(),
    perCustomerLimit: z.number().int().min(1).nullable().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    isActive: z.boolean().optional(),
    /** Present (even empty) = replace the eligibility list. */
    groupIds: z.array(z.coerce.number().int().positive()).max(100).optional(),
    /** Present (bundle kind) = replace the component list wholesale. */
    components: z
      .array(
        z.object({
          variantId: z.coerce.number().int().positive(),
          quantity: z.coerce.number().positive().max(1_000_000),
        }),
      )
      .max(100)
      .optional(),
  })
  .refine(
    (value) =>
      Object.keys(value).length > 0 &&
      Object.values(value).some((v) => v !== undefined),
    "Nothing to update.",
  );

export type PromotionUpdate = z.infer<typeof promotionUpdateSchema>;
