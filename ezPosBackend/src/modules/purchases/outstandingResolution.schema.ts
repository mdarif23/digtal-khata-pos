import { z } from "zod";

export const RESOLUTION_OPTIONS = [
  "receive_later",
  "cancel",
  "backordered",
] as const;

/**
 * Short-receiving resolution (Phase 3): what happens to the outstanding
 * quantity of a line.
 * - receive_later: another receiving session is expected (default state,
 *   recorded explicitly).
 * - backordered: the outstanding quantity stays owed by the supplier.
 * - cancel: the outstanding quantity is written off — excluded from
 *   outstanding, reduces the payable by the line's unit value.
 */
export const resolveOutstandingSchema = z.object({
  items: z
    .array(
      z.object({
        purchaseItemId: z.number().int().positive(),
        quantity: z.number().positive(),
        resolution: z.enum(RESOLUTION_OPTIONS),
        reason: z.string().max(300).optional(),
      }),
    )
    .min(1, "Select at least one item to resolve."),
});

export type ResolveOutstandingInput = z.infer<typeof resolveOutstandingSchema>;

/**
 * Rejection resolution (Phase 4): records how the supplier settles
 * rejected goods. RECORDING ONLY — no supplier credit or payment is ever
 * created automatically; the actual financial workflow (e.g. a purchase
 * return, or a deduction agreed with the supplier) is executed separately.
 */
export const resolveDiscrepancySchema = z.object({
  resolution: z.enum(["supplier_credit", "replacement"]),
  reason: z.string().max(300).optional(),
});

export type ResolveDiscrepancyInput = z.infer<typeof resolveDiscrepancySchema>;
