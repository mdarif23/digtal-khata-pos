import { z } from "zod";

export const createPurchaseReturnSchema = z.object({
  orderId: z.number().int().positive(),
  reason: z.string().max(300).optional(),
  changedItems: z
    .array(
      z.object({
        purchaseItemId: z.number().int().positive(),
        quantity: z.number().int().positive(),
        // Phase 5: explicit serial selection for serial-tracked lines.
        // Absent = the documented auto-pick fallback (first in-stock
        // serials by id). Every provided id is re-validated server-side.
        serialIds: z.array(z.number().int().positive()).max(500).optional(),
      }),
    )
    .min(1, "Select at least one item to return."),
});

export type CreatePurchaseReturnInput = z.infer<
  typeof createPurchaseReturnSchema
>;
