import { z } from "zod";

/**
 * Finance & Growth (Stage 3 foundation) request schemas. Money arrives as
 * JS numbers with 2dp precision, validated non-negative; the service layer
 * converts to integer poisha before anything touches the ledger.
 */

const money = z
  .number()
  .nonnegative()
  .refine((value) => Number.isFinite(value), "Must be a finite number")
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.01,
    "At most 2 decimal places",
  );

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

// --- Chart of accounts ------------------------------------------------------

export const createAccountSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9-]+$/, "Letters, digits and dashes only"),
  name: z.string().trim().min(1).max(120),
  type: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
  parentId: z.coerce.number().int().positive().nullish(),
  description: z.string().trim().max(255).nullish(),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(255).nullish(),
  parentId: z.coerce.number().int().positive().nullish(),
});
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

// --- Payment accounts -------------------------------------------------------

export const createPaymentAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(["cash", "bank", "mfs"]),
  provider: z.string().trim().max(30).nullish(),
  glAccountId: z.coerce.number().int().positive(),
  isDefault: z.boolean().default(false),
  notes: z.string().trim().max(255).nullish(),
});
export type CreatePaymentAccountInput = z.infer<typeof createPaymentAccountSchema>;

export const updatePaymentAccountSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  provider: z.string().trim().max(30).nullish(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().trim().max(255).nullish(),
});
export type UpdatePaymentAccountInput = z.infer<typeof updatePaymentAccountSchema>;

// --- Activation (opening balances) -------------------------------------------

export const activationAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(["cash", "bank", "mfs"]),
  provider: z.string().trim().max(30).nullish(),
  /** Opening balance ≥ 0 — overdrawn accounts cannot be opened. */
  openingBalance: money,
});
export type ActivationAccountInput = z.infer<typeof activationAccountSchema>;

export const activateFinanceSchema = z.object({
  /** Accounts to create with their opening balances (cash auto-created). */
  accounts: z.array(activationAccountSchema).default([]),
  inventoryValue: money.default(0),
  receivablesTotal: money.default(0),
  vatInputTotal: money.default(0),
  payablesTotal: money.default(0),
  vatPayableTotal: money.default(0),
  loansPayableTotal: money.default(0),
  ownerCapital: money.default(0),
  entryDate: isoDate.optional(),
  memo: z.string().trim().max(500).nullish(),
});
export type ActivateFinanceInput = z.infer<typeof activateFinanceSchema>;

// --- Journal entries ----------------------------------------------------------

export const journalLineSchema = z
  .object({
    accountCode: z.string().trim().min(1).max(20).optional(),
    accountId: z.coerce.number().int().positive().optional(),
    debit: money.optional(),
    credit: money.optional(),
    locationId: z.coerce.number().int().positive().nullish(),
    description: z.string().trim().max(255).nullish(),
  })
  .refine(
    (line) => line.accountCode != null || line.accountId != null,
    "Each line needs an account",
  )
  .refine(
    (line) => (line.debit ?? 0) > 0 !== (line.credit ?? 0) > 0,
    "Each line needs exactly one of debit or credit greater than zero",
  );
export type JournalLinePayload = z.infer<typeof journalLineSchema>;

export const createJournalEntrySchema = z
  .object({
    entryDate: isoDate.optional(),
    memo: z.string().trim().max(500).nullish(),
    lines: z.array(journalLineSchema).min(2),
    /** Manual entries may be saved as drafts; POST /:id/post finalizes. */
    status: z.enum(["draft", "posted"]).default("draft"),
  })
  .refine(
    (entry) =>
      entry.status === "draft" ||
      entry.lines.reduce((sum, l) => sum + (l.debit ?? 0), 0) ===
        entry.lines.reduce((sum, l) => sum + (l.credit ?? 0), 0),
    "Debits and credits must balance",
  );
export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;

export const updateDraftEntrySchema = z.object({
  entryDate: isoDate.optional(),
  memo: z.string().trim().max(500).nullish(),
  lines: z.array(journalLineSchema).min(2),
});
export type UpdateDraftEntryInput = z.infer<typeof updateDraftEntrySchema>;

export const reverseEntrySchema = z.object({
  reason: z.string().trim().min(3).max(500),
  entryDate: isoDate.optional(),
});
export type ReverseEntryInput = z.infer<typeof reverseEntrySchema>;

export const listEntriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["draft", "posted", "reversed"]).optional(),
  source_type: z.string().trim().max(40).optional(),
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(["entry_date", "entry_no", "created_at"]).default("entry_date"),
  sort_dir: z.enum(["asc", "desc"]).default("desc"),
});
export type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>;

export const balancesQuerySchema = z.object({
  from_date: isoDate.optional(),
  to_date: isoDate.optional(),
});
