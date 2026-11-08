import z from "zod";

export const EXPENSE_PAYMENT_METHODS = ["Cash", "Mobile", "Card"] as const;
export const EXPENSE_PAYMENT_STATUSES = ["unpaid", "partial", "paid"] as const;
export const EXPENSE_CHANNELS = ["woocommerce", "custom_storefront"] as const;
export const EXPENSE_SORT_FIELDS = [
  "expense_date",
  "amount",
  "title",
  "payment_status",
  "created_at",
] as const;

export const expenseWriteSchema = z.object({
  title: z.string().trim().min(1).max(255),
  expense_date: z.iso.date(),
  amount: z.number().finite().positive(),
  category_id: z.number().int().positive().nullable(),
  payment_method: z.enum(EXPENSE_PAYMENT_METHODS),
  /** Optional vendor/person the expense was paid to. */
  payee: z.string().trim().max(150).nullable().optional(),
  reference_no: z.string().trim().max(100).nullable().optional(),
  note: z.string().trim().nullable().optional(),
  /** Online-channel attribution (profitability): NULL = shared across channels. */
  channel: z.enum(EXPENSE_CHANNELS).nullable().optional(),
  /** Optional order link for order-specific expenses (estimated op. profit). */
  sale_id: z.number().int().positive().nullable().optional(),
  /**
   * Settlement recorded together with the expense. Defaults to a full
   * settlement with the expense's own method and date (legacy behaviour:
   * recording an expense = paid in full). Phase 2 exposes partial/unpaid
   * creation through this object.
   */
  initial_payment: z
    .object({
      amount: z.number().finite().positive(),
      payment_date: z.iso.date().optional(),
      reference_no: z.string().trim().max(100).nullable().optional(),
      note: z.string().trim().nullable().optional(),
      /** Open register session to tie the cash movement to (D3). */
      register_session_id: z.number().int().positive().nullable().optional(),
    })
    .nullable()
    .optional(),
  /** Record the expense as a pure due — no settlement row at creation. */
  record_as: z.literal("unpaid").optional(),
});

export type ExpenseWriteInput = z.infer<typeof expenseWriteSchema>;

/** "none" = uncategorized filter. */
export const categoryIdFilterSchema = z.union([
  z.coerce.number().int().positive(),
  z.literal("none"),
]);

export const expenseListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().max(255).optional(),
    category_id: categoryIdFilterSchema.optional(),
    payment_status: z.enum(EXPENSE_PAYMENT_STATUSES).optional(),
    payment_method: z.enum(EXPENSE_PAYMENT_METHODS).optional(),
    channel: z.enum(EXPENSE_CHANNELS).optional(),
    date_from: z.iso.date().optional(),
    date_to: z.iso.date().optional(),
    sort: z.enum(EXPENSE_SORT_FIELDS).default("expense_date"),
    sort_dir: z.enum(["asc", "desc"]).default("desc"),
  })
  .refine(
    (q) => !q.date_from || !q.date_to || q.date_from <= q.date_to,
    { message: "date_from must be on or before date_to", path: ["date_from"] },
  );

export type ExpenseListQuery = z.infer<typeof expenseListQuerySchema> & {
  /** Server-verified optional location scope (resolveOptionalLocationParam). */
  locationId?: number | undefined;
};

export const expenseAnalyticsQuerySchema = z
  .object({
    date_from: z.iso.date().optional(),
    date_to: z.iso.date().optional(),
    granularity: z.enum(["day", "week", "month"]).default("month"),
  })
  .refine(
    (q) => !q.date_from || !q.date_to || q.date_from <= q.date_to,
    { message: "date_from must be on or before date_to", path: ["date_from"] },
  );

export type ExpenseAnalyticsQuery = z.infer<typeof expenseAnalyticsQuerySchema>;

export const expenseVoidSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/** Settlement payment recorded against an existing expense. */
export const expensePaymentCreateSchema = z.object({
  amount: z.number().finite().positive(),
  payment_method: z.enum(EXPENSE_PAYMENT_METHODS),
  payment_date: z.iso.date().optional(),
  reference_no: z.string().trim().max(100).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  /** Tie a Cash payment to an open register session (drawer deduction). */
  register_session_id: z.number().int().positive().nullable().optional(),
  /** Client-generated idempotency key for retried submissions. */
  client_uuid: z.string().uuid().nullable().optional(),
});

export type ExpensePaymentCreateInput = z.infer<
  typeof expensePaymentCreateSchema
>;

export const expensePaymentIdSchema = z.coerce.number().int().positive();

// ---------------------------------------------------------------------------
// Attachments (Phase 4) — presigned-PUT flow; PDFs + images only.
// ---------------------------------------------------------------------------

export const attachmentContentTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const attachmentPresignSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.enum(attachmentContentTypes),
  sizeBytes: z.number().int().positive(),
});

export const attachmentRegisterSchema = z.object({
  objectKey: z.string().trim().min(1).max(300),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.enum(attachmentContentTypes),
  bytes: z.number().int().positive(),
});

export const attachmentIdSchema = z.coerce.number().int().positive();

export type AttachmentPresignInput = z.infer<typeof attachmentPresignSchema>;
export type AttachmentRegisterInput = z.infer<typeof attachmentRegisterSchema>;

// ---------------------------------------------------------------------------
// Recurring templates + budgets (Phase 6)
// ---------------------------------------------------------------------------

export const expenseTemplateWriteSchema = z.object({
  title: z.string().trim().min(1).max(255),
  amount: z.number().finite().positive(),
  category_id: z.number().int().positive().nullable(),
  payment_method: z.enum(EXPENSE_PAYMENT_METHODS),
  payee: z.string().trim().max(150).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  /** Owning outlet; NULL = the business default at generation time is NOT used —
   * templates record against this outlet explicitly. */
  location_id: z.number().int().positive().nullable().optional(),
  channel: z.enum(EXPENSE_CHANNELS).nullable().optional(),
  frequency: z.enum(["weekly", "monthly", "yearly"]),
  start_date: z.iso.date(),
  end_date: z.iso.date().nullable().optional(),
  is_active: z.boolean().nullable().optional(),
});

export type ExpenseTemplateWriteInput = z.infer<
  typeof expenseTemplateWriteSchema
>;

export const expenseTemplateIdSchema = z.coerce.number().int().positive();

export const expenseBudgetWriteSchema = z.object({
  category_id: z.number().int().positive().nullable(),
  location_id: z.number().int().positive().nullable().optional(),
  /** First day of the budgeted period (YYYY-MM-01). */
  month: z.iso.date(),
  amount: z.number().finite().positive(),
  /** monthly (default, legacy behavior) | quarterly | yearly. */
  period_type: z.enum(["monthly", "quarterly", "yearly"]).optional(),
  /** Utilization % that triggers a budget_alert (1-100). */
  warning_threshold_percent: z.number().min(1).max(100).optional(),
});

export type ExpenseBudgetWriteInput = z.infer<typeof expenseBudgetWriteSchema>;

export const expenseBudgetIdSchema = z.coerce.number().int().positive();

export const expenseBudgetListQuerySchema = z.object({
  month: z.iso.date().optional(),
});

export const expenseCategorySchema = z.object({
  categoryName: z.string().trim().min(1).max(100),
  description: z.string().trim().max(255).nullable().optional(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color such as #2563eb")
    .nullable()
    .optional(),
  icon: z.string().trim().max(50).nullable().optional(),
});

export const expenseCategoryIdSchema = z.coerce.number().int().positive();

export type ExpenseCategoryWriteInput = z.infer<typeof expenseCategorySchema>;

export const expenseIdSchema = z.coerce.number().int().positive();

/** Hard ceiling for the CSV export endpoint (rows). */
export const EXPENSE_EXPORT_LIMIT = 5000;
