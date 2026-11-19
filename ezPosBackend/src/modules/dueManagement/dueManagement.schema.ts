import { z } from "zod";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const dateString = z
  .string()
  .regex(DATE_PATTERN, "Expected date format YYYY-MM-DD.")
  // D3-004: the regex admits impossible calendar dates ("2026-02-30"),
  // which then blew up as a 500 at the Postgres insert. Validate against
  // the real calendar.
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "That date does not exist on the calendar.");

export const dueSummaryQuerySchema = z.object({
  overdueDays: z.coerce.number().int().min(1).max(365).default(30),
});

export const dueRowQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z
    .enum(["all", "unpaid", "partial", "paid", "overdue"])
    .default("all"),
  customerId: z.coerce.number().int().positive().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  overdueDays: z.coerce.number().int().min(1).max(365).default(30),
});

export const ledgerQuerySchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
});

export const idParamSchema = z.coerce.number().int().positive();

export const customerPaymentSchema = z
  .object({
    saleId: z.coerce.number().int().positive(),
    amount: z.coerce
      .number()
      .positive("Payment amount must be greater than zero.")
      .max(10_000_000, "Payment amount is unreasonably large."),
    paymentMethod: z.enum(["cash", "bangla_qr", "card"]),
    reference: z.string().trim().max(100).optional().nullable(),
    tendered: z.coerce.number().min(0).optional().nullable(),
    notes: z.string().trim().max(500).optional().nullable(),
    paymentDate: dateString.optional().nullable(),
  })
  .superRefine((payload, ctx) => {
    if (
      (payload.paymentMethod === "card" ||
        payload.paymentMethod === "bangla_qr") &&
      (payload.reference ?? "").trim().length < 6
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reference"],
        message:
          "Card and QR payments require a transaction reference of at least 6 characters.",
      });
    }
    if (
      payload.paymentMethod === "cash" &&
      payload.tendered !== undefined &&
      payload.tendered !== null &&
      payload.tendered + 0.001 < payload.amount
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["tendered"],
        message: "Cash tendered cannot be less than the payment amount.",
      });
    }
  });

export const supplierPaymentSchema = z.object({
  purchaseId: z.coerce.number().int().positive(),
  amount: z.coerce
    .number()
    .positive("Payment amount must be greater than zero.")
    .max(10_000_000, "Payment amount is unreasonably large."),
  method: z.enum(["cash", "bank_transfer", "cheque", "card", "other"]),
  notes: z.string().trim().max(500).optional().nullable(),
  paymentDate: dateString.optional().nullable(),
});

export type DueSummaryQuery = z.infer<typeof dueSummaryQuerySchema>;
export type DueRowQuery = z.infer<typeof dueRowQuerySchema>;
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;
export type CustomerPaymentInput = z.infer<typeof customerPaymentSchema>;
export type SupplierPaymentInput = z.infer<typeof supplierPaymentSchema>;
