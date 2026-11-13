import { z } from "zod";

export const createTransferSchema = z.object({
  fromLocationId: z.number().int().positive(),
  toLocationId: z.number().int().positive(),
  notes: z.string().trim().max(1000).optional(),
  items: z
    .array(
      z.object({
        variantId: z.number().int().positive(),
        quantity: z.number().int().positive("Quantity must be at least 1"),
      }),
    )
    .min(1, "Add at least one item"),
});

export const receiveTransferSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.number().int().positive(),
        quantity: z.number().int().min(0),
      }),
    )
    .optional(),
  /** Phase 4: shortfall reasons keyed by item id (discrepancy recording). */
  reasons: z.record(z.string(), z.string().max(500)).optional(),
  /**
   * Phase 4: force the transfer to 'received' despite shortfalls — every
   * outstanding unit becomes an explicit discrepancy row (never silent).
   */
  forceComplete: z.boolean().optional(),
});

export type CreateTransferInput = z.infer<typeof createTransferSchema>;
export type ReceiveTransferInput = z.infer<typeof receiveTransferSchema>;
