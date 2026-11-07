import { z } from "zod";

/**
 * Purchase-list query (Phase 5): server-side pagination, filtering and
 * sorting for the aggregated list endpoint. Numbers arrive as query
 * strings — coerced and bounded here; invalid values are rejected with a
 * 400 (parseOrThrow in the controller), never silently clamped.
 */
export const purchaseListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
  receivingStatus: z
    .enum(["ordered", "partially_received", "received"])
    .optional(),
  returnStatus: z.enum(["Returned", "Partially returned"]).optional(),
  // The list's derived cancellation flag (Phase 3) as a filter dimension.
  fullyCancelled: z.enum(["true", "false"]).optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  sortBy: z
    .enum(["purchaseDate", "totalAmount", "dueAmount", "purchaseOrderNumber"])
    .default("purchaseDate"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type PurchaseListQuery = z.infer<typeof purchaseListQuerySchema>;
