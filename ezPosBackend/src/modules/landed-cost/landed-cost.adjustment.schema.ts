import { z } from "zod";

/**
 * Expense adjustment (Phase 7): move an estimated landed-cost expense to
 * its actual invoice amount. The difference flows through the allocation
 * delta (inventory vs COGS split) with a full audit trail.
 */
export const adjustExpenseSchema = z.object({
  expenseId: z.number().int().positive(),
  newAmount: z.number().positive("The adjusted amount must be positive."),
  reason: z.string().max(300).optional(),
});

export type AdjustExpenseInput = z.infer<typeof adjustExpenseSchema>;
