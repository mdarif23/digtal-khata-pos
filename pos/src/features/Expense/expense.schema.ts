import z from "zod";

export const expenseSchema = z
  .object({
    title: z.string().trim().min(1, "Enter an expense title").max(255),
    expenseDate: z.string().min(1, "Choose an expense date"),
    amount: z.number().finite().positive("Amount must be greater than zero"),
    categoryId: z
      .string()
      .transform((value) => (value === "none" ? null : Number(value)))
      .pipe(z.number().int().positive().nullable()),
    paymentMethod: z.enum(["Cash", "Mobile", "Card"]),
    payee: z
      .string()
      .trim()
      .max(150, "Payee is too long")
      .transform((value) => value || null),
    referenceNo: z
      .string()
      .trim()
      .max(100, "Reference number is too long")
      .transform((value) => value || null),
    note: z
      .string()
      .trim()
      .transform((value) => value || null),
    /** How the expense is settled at creation (edit mode ignores this). */
    settlement: z.enum(["full", "partial", "unpaid"]),
    /** Required when settlement = "partial" — the amount settled now. */
    initialPaymentAmount: z.number().finite().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.settlement !== "partial") return;
    const partial = data.initialPaymentAmount;
    if (partial === undefined || Number.isNaN(partial) || partial <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["initialPaymentAmount"],
        message: "Enter the amount settled now",
      });
      return;
    }
    if (partial >= data.amount) {
      ctx.addIssue({
        code: "custom",
        path: ["initialPaymentAmount"],
        message:
          "A partial payment must be less than the total — choose “Paid in full” instead",
      });
    }
  });

export type ExpenseFormInput = z.input<typeof expenseSchema>;
export type ExpenseFormOutput = z.output<typeof expenseSchema>;
