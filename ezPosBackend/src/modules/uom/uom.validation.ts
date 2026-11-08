import { z } from "zod";

/**
 * UOM configuration + resolution contracts. Conversion factors and prices
 * submitted by clients are ALWAYS re-resolved server-side for transactions;
 * these schemas only gate configuration management and preview endpoints.
 */

const positiveFactor = z.coerce
  .number()
  .positive("Conversion factor must be greater than zero")
  .max(1_000_000_000);

export const createConversionSchema = z.object({
  variantId: z.coerce.number().int().positive().nullish(),
  unitId: z.coerce.number().int().positive(),
  conversionFactor: positiveFactor,
  isPurchaseEnabled: z.coerce.boolean().optional(),
  isSaleEnabled: z.coerce.boolean().optional(),
  isDefaultPurchase: z.coerce.boolean().optional(),
  isDefaultSale: z.coerce.boolean().optional(),
  salePrice: z.coerce.number().min(0).nullish(),
  purchasePrice: z.coerce.number().min(0).nullish(),
});

export const updateConversionSchema = z.object({
  conversionFactor: positiveFactor.optional(),
  isPurchaseEnabled: z.coerce.boolean().optional(),
  isSaleEnabled: z.coerce.boolean().optional(),
  isDefaultPurchase: z.coerce.boolean().optional(),
  isDefaultSale: z.coerce.boolean().optional(),
  salePrice: z.coerce.number().min(0).nullish(),
  purchasePrice: z.coerce.number().min(0).nullish(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const resolveUomItemSchema = z.object({
  variantId: z.coerce.number().int().positive(),
  uomConversionId: z.coerce.number().int().positive().nullish(),
  enteredQuantity: z.coerce.number().positive(),
  enteredUnitPrice: z.coerce.number().min(0).nullish(),
});

export const resolveUomSchema = z.object({
  items: z.array(resolveUomItemSchema).min(1).max(500),
  /** Enforce whole base quantities (stock-affecting previews). */
  wholeBase: z.coerce.boolean().optional(),
});

export type CreateConversionInput = z.infer<typeof createConversionSchema>;
export type UpdateConversionInput = z.infer<typeof updateConversionSchema>;
export type ResolveUomInput = z.infer<typeof resolveUomSchema>;
