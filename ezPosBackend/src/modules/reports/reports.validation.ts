import { z } from "zod";

export const dateRangeSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  // WP-006: 60d/90d/365d mirror the dashboard's shared windows so the
  // channel-mix card (and any report surface) can match the dashboard's
  // selected range instead of silently falling back to this_month.
  period: z
    .enum([
      "today",
      "yesterday",
      "7d",
      "30d",
      "60d",
      "90d",
      "365d",
      "this_month",
      "last_month",
      "this_year",
      "custom",
    ])
    .optional()
    .default("this_month"),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(50),
  customerId: z.coerce.number().int().optional(),
  supplierId: z.coerce.number().int().optional(),
  categoryId: z.coerce.number().int().optional(),
  brandId: z.coerce.number().int().optional(),
  paymentMethod: z.string().optional(),
  paymentStatus: z.enum(["paid", "partial", "unpaid"]).optional(),
  search: z.string().optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type DateRangeQuery = z.infer<typeof dateRangeSchema>;

