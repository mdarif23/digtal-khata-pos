import { z } from "zod";

/**
 * Zod schemas for customer groups and group pricing (Phase 4). Shapes mirror
 * the DB CHECKs (scope XOR-or-all-null, percentage cap, date order) from
 * migration 0063.
 */

export const createGroupSchema = z.object({
  name: z.string().trim().min(1, "Group name is required").max(80),
  description: z.string().trim().max(300).nullable().optional(),
  isDefault: z.boolean().optional(),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export const updateGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((v) => v !== undefined),
    "Nothing to update.",
  );

export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

export const assignMembersSchema = z.object({
  customerIds: z
    .array(z.coerce.number().int().positive())
    .min(1)
    .max(500),
});

export type AssignMembersInput = z.infer<typeof assignMembersSchema>;

const scopeFields = {
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  productId: z.coerce.number().int().positive().nullable().optional(),
  variantId: z.coerce.number().int().positive().nullable().optional(),
};

export const groupPricingStrictSchema = z
  .object({
    categoryId: z.coerce.number().int().positive().nullable(),
    productId: z.coerce.number().int().positive().nullable(),
    variantId: z.coerce.number().int().positive().nullable(),
    discountType: z.enum(["percentage", "fixed"]),
    discountValue: z.number().min(0),
    minPurchaseAmount: z.number().min(0),
    minQuantity: z.coerce.number().int().positive().nullable(),
    maxDiscountAmount: z.number().min(0).nullable(),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    stacksWithPromotions: z.boolean(),
    isActive: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const setCount = [value.categoryId, value.productId, value.variantId].filter(
      (s) => s != null,
    ).length;
    if (setCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categoryId"],
        message:
          "Group pricing belongs to exactly one scope (category, product or variant) or the whole cart.",
      });
    }
    if (value.discountType === "percentage" && value.discountValue > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discountValue"],
        message: "Percentage discounts cannot exceed 100.",
      });
    }
    if (value.validFrom && value.validTo && value.validFrom > value.validTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validFrom"],
        message: "validFrom must not be after validTo.",
      });
    }
  });

export const groupPricingCreateSchema = z
  .object({
    ...scopeFields,
    discountType: z.enum(["percentage", "fixed"]),
    discountValue: z.number().min(0),
    minPurchaseAmount: z.number().min(0).optional(),
    minQuantity: z.coerce.number().int().positive().nullable().optional(),
    maxDiscountAmount: z.number().min(0).nullable().optional(),
    validFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    validTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    stacksWithPromotions: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.discountType === "percentage" && value.discountValue > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discountValue"],
        message: "Percentage discounts cannot exceed 100.",
      });
    }
    if (value.validFrom && value.validTo && value.validFrom > value.validTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validFrom"],
        message: "validFrom must not be after validTo.",
      });
    }
  });

export type GroupPricingCreate = z.infer<typeof groupPricingCreateSchema>;

export const groupPricingUpdateSchema = z
  .object({
    ...scopeFields,
    discountType: z.enum(["percentage", "fixed"]).optional(),
    discountValue: z.number().min(0).optional(),
    minPurchaseAmount: z.number().min(0).optional(),
    minQuantity: z.coerce.number().int().positive().nullable().optional(),
    maxDiscountAmount: z.number().min(0).nullable().optional(),
    validFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    validTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    stacksWithPromotions: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((v) => v !== undefined),
    "Nothing to update.",
  );

export type GroupPricingUpdate = z.infer<typeof groupPricingUpdateSchema>;
