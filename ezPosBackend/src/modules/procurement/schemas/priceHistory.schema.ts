import { z } from "zod";

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

export const priceOverviewQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(100).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});
export type PriceOverviewQuery = z.infer<typeof priceOverviewQuerySchema>;

export const priceHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  supplierId: z.coerce.number().int().positive().optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});
export type PriceHistoryQuery = z.infer<typeof priceHistoryQuerySchema>;

export const variantIdParamSchema = z.object({
  variantId: z.coerce.number().int().positive(),
});
