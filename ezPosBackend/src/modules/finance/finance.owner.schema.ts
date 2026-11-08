import { z } from "zod";

/**
 * Owner finance (Stage 4) request schemas — owner profiles, capital
 * transactions, profit calculation and allocation.
 */

const money = z
  .number()
  .positive()
  .refine((value) => Number.isFinite(value), "Must be a finite number")
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.01,
    "At most 2 decimal places",
  );

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

// --- Owner profiles -----------------------------------------------------------

export const createOwnerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  userId: z.coerce.number().int().positive().nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().email().max(255).nullish(),
  ownershipPercent: z
    .number()
    .min(0)
    .max(100)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.01)
    .nullish(),
  notes: z.string().trim().max(500).nullish(),
});
export type CreateOwnerInput = z.infer<typeof createOwnerSchema>;

export const updateOwnerSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().email().max(255).nullish(),
  ownershipPercent: z
    .number()
    .min(0)
    .max(100)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.01)
    .nullish(),
  notes: z.string().trim().max(500).nullish(),
  isActive: z.boolean().optional(),
});
export type UpdateOwnerInput = z.infer<typeof updateOwnerSchema>;

// --- Capital transactions ------------------------------------------------------

export const capitalTransactionSchema = z.object({
  ownerProfileId: z.coerce.number().int().positive(),
  type: z.enum(["investment", "withdrawal", "distribution"]),
  amount: money,
  txnDate: isoDate.optional(),
  paymentAccountId: z.coerce.number().int().positive().nullish(),
  method: z.string().trim().max(30).nullish(),
  sourceOfFunds: z.string().trim().max(120).nullish(),
  reference: z.string().trim().max(100).nullish(),
  description: z.string().trim().max(500).nullish(),
  attachmentUrl: z.string().trim().max(500).nullish(),
  clientUuid: z.string().uuid().nullish(),
});
export type CapitalTransactionInput = z.infer<typeof capitalTransactionSchema>;

export const capitalListQuerySchema = z.object({
  type: z.enum(["investment", "withdrawal", "distribution"]).optional(),
  owner_id: z.coerce.number().int().positive().optional(),
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});
export type CapitalListQuery = z.infer<typeof capitalListQuerySchema>;

// --- Profit calculation & allocation ---------------------------------------------

export const profitRangeQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
});
export type ProfitRangeQuery = z.infer<typeof profitRangeQuerySchema>;

export const allocationLineSchema = z
  .object({
    category: z.enum([
      "reinvestment",
      "owner_distribution",
      "emergency_reserve",
      "expansion",
      "debt_repayment",
      "other",
    ]),
    basisType: z.enum(["percent", "fixed"]),
    /** Percent of distributable (0-100) when basisType is percent. */
    basisValue: z.number().min(0).max(100).nullish(),
    /** Fixed amount when basisType is fixed. */
    amount: money.nullish(),
  })
  .refine(
    (line) =>
      line.basisType === "percent"
        ? line.basisValue != null
        : line.amount != null && line.amount > 0,
    "Percent lines need basisValue; fixed lines need a positive amount",
  );
export type AllocationLinePayload = z.infer<typeof allocationLineSchema>;

export const createAllocationSchema = z
  .object({
    periodStart: isoDate,
    periodEnd: isoDate,
    periodLabel: z.string().trim().max(60).nullish(),
    lines: z.array(allocationLineSchema).min(1),
  })
  .refine((input) => input.periodEnd >= input.periodStart, "Invalid period range");
export type CreateAllocationInput = z.infer<typeof createAllocationSchema>;

export const reverseAllocationSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type ReverseAllocationInput = z.infer<typeof reverseAllocationSchema>;

export const realizeAllocationSchema = z.object({
  ownerProfileId: z.coerce.number().int().positive(),
  amount: money.nullish(),
  paymentAccountId: z.coerce.number().int().positive().nullish(),
  method: z.string().trim().max(30).nullish(),
  reference: z.string().trim().max(100).nullish(),
  txnDate: isoDate.optional(),
});
export type RealizeAllocationInput = z.infer<typeof realizeAllocationSchema>;
