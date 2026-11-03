import { z } from "zod";

export const reorderDashboardQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(100).optional(),
  status: z
    .enum(["all", "attention", "out_of_stock", "low_stock", "needs_reorder", "healthy"])
    .optional(),
  // Restrict to one supplier's attention products (Phase 5: "add more
  // needed products from this supplier" when below the minimum).
  supplierId: z.coerce.number().int().positive().optional(),
});
export type ReorderDashboardQuery = z.infer<typeof reorderDashboardQuerySchema>;
