import { z } from "zod";

export const landedCostExpenseSchema = z.object({
  expenseType: z.enum([
    "shipping",
    "loading",
    "customs",
    "transportation",
    "insurance",
    "handling",
    "other",
  ]),
  amount: z.coerce.number().positive("Expense amount must be positive."),
  description: z.string().max(255).nullish(),
  taxAmount: z.coerce.number().min(0).default(0),
  taxTreatment: z
    .enum(["none", "recoverable", "non_recoverable"])
    .default("none"),
  isCapitalizable: z.boolean().default(true),
  vendorId: z.coerce.number().int().nullish(),
  referenceNumber: z.string().max(100).nullish(),
  expenseDate: z.string().date().nullish(),
  settlementType: z
    .enum(["expense_payment", "supplier_payable", "cash", "unpaid"])
    .default("unpaid"),
  /** expenses.id when settlementType = expense_payment (server-verified). */
  settlementReferenceId: z.coerce.number().int().nullish(),
});

export const landedCostPreviewSchema = z.object({
  method: z.enum(["quantity", "value", "weight", "manual"]),
  expenses: z.array(landedCostExpenseSchema).min(1).max(100),
  manualAllocations: z
    .array(
      z.object({
        purchaseItemId: z.coerce.number().int().positive(),
        amount: z.coerce.number().min(0),
      }),
    )
    .max(200)
    .optional(),
});

export type LandedCostPreviewInput = z.infer<typeof landedCostPreviewSchema>;
export type LandedCostExpenseSchema = z.infer<typeof landedCostExpenseSchema>;
