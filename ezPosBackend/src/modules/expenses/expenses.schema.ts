import z from "zod";

export const expenseWriteSchema = z.object({
  title: z.string().trim().min(1).max(255),
  expense_date: z.iso.date(),
  amount: z.number().finite().positive(),
  category_id: z.number().int().positive().nullable(),
  payment_method: z.enum(["Cash", "Mobile", "Card"]),
  reference_no: z.string().trim().max(100).nullable().optional(),
  note: z.string().trim().nullable().optional(),
  /** Online-channel attribution (profitability): NULL = shared across channels. */
  channel: z.enum(["woocommerce", "custom_storefront"]).nullable().optional(),
  /** Optional order link for order-specific expenses (estimated op. profit). */
  sale_id: z.number().int().positive().nullable().optional(),
});

export type ExpenseWriteInput = z.infer<typeof expenseWriteSchema>;

export const expenseCategorySchema = z.object({
  categoryName: z.string().trim().min(1).max(100),
});

export const expenseIdSchema = z.coerce.number().int().positive();
