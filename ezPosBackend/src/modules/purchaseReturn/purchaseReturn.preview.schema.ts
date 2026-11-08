import { z } from "zod";

/**
 * Return-preview input (Phase 2): the quantities the user is considering.
 * serialIds is accepted for the Phase 5 explicit serial-selection flow;
 * until then serials are auto-selected and the field carries no weight.
 */
export const purchaseReturnPreviewSchema = z.object({
  changedItems: z
    .array(
      z.object({
        purchaseItemId: z.number().int().positive(),
        quantity: z.number().int().positive(),
        // Same shape as the committing return (Phase 5). Serials do not
        // affect the money (batch-cost based) — accepted for symmetry.
        serialIds: z.array(z.number().int().positive()).max(500).optional(),
      }),
    )
    .min(1, "Select at least one item to preview."),
});

export type PurchaseReturnPreviewInput = z.infer<
  typeof purchaseReturnPreviewSchema
>;
