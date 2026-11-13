import z from "zod";
export const PAYMENT_ROW_METHODS = [
  "cash",
  "bangla_qr",
  "card",
  "due",
  "store_credit",
  "loyalty_points",
  "gift_card",
] as const;

export const paymentSchema = z.object({
  method: z.enum(PAYMENT_ROW_METHODS),
  amount: z.number().nonnegative().optional(),
  tendered: z.number().nonnegative().optional(),
  reference: z.string().trim().optional(),
});

// 1. Define what a single cart item should look like when sent to the DB
const cartItemPayloadSchema = z
  .object({
    variantId: z.number().int().positive("Variant ID is required"),
    // Quantity in the ENTERED selling unit (base when uomConversionId is
    // absent). UOM lines may be fractional at the entered level (1.5 Box);
    // the server converts to whole base units authoritatively. Sold-by-weight
    // lines are fractional too — capped at 3 decimals (scale precision,
    // round-trip compare so legal decimals like 1.005 are not rejected).
    quantity: z
      .number()
      .positive("Quantity must be at least 1")
      .refine(
        (v) => Math.round(v * 1000) / 1000 === v,
        "Quantity supports up to 3 decimals.",
      ),
    unitPrice: z.number().nonnegative("Unit price cannot be negative"),
    discount: z
      .object({
        type: z.enum(["percentage", "fixed"]),
        value: z.number().min(0),
      })
      .nullable(),
    serialNumbers: z.array(z.string().trim().min(1)).optional(),
    // UOM (migration 0062): the selling unit for this line. The server
    // resolves the authoritative factor/price — client values advisory.
    uomConversionId: z.number().int().positive().nullish(),
    // POS price override (Phase 6, migration 0063): replaces the DB selling
    // price FOR THIS LINE ONLY (never the variant row). The unit price is in
    // the ENTERED selling unit. Gated by pricing.price_override; the line is
    // still checked against the minimum floors and needs a reason when it
    // lands below one.
    priceOverride: z
      .object({
        unitPrice: z.number().min(0),
        reason: z.string().trim().max(300).optional(),
      })
      .nullish(),
  })
  .superRefine((data, ctx) => {
    // Phase 4 (Feature 10): fractional quantities are allowed here and the
    // SERVICE enforces the per-variant rule (identity lines must be whole
    // UNLESS the variant is sold by weight — sold_by_weight). UOM lines
    // still convert to whole base units in the service (INTEGER stock
    // invariant for allocated packaging).
    if (!Number.isFinite(data.quantity) || data.quantity <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantity"],
        message: "Quantity must be a positive number.",
      });
    }
  });

// 2. Define the full Payload schema
export const createSalePayloadSchema = z.object({
  saleDate: z.coerce.date(),
  customerId: z.number().nullable(),
  payments: z.array(paymentSchema).min(1, "Select a payment method"),
  discount: z
    .object({
      type: z.enum(["percentage", "fixed"]),
      value: z.number().min(0),
    })
    .nullable(),
  vatPercent: z.number().nullable(),

  // Coupon code (server-validated; discount applied by the backend).
  couponCode: z.string().trim().min(1).max(60).optional(),

  // Client-generated key (UUID) that makes checkout retries idempotent:
  // resubmitting the same key returns the original sale instead of
  // creating a duplicate. Scoped per business at the database level.
  idempotencyKey: z.string().trim().min(8).max(120).optional(),

  // Mandatory when a line lands below its minimum floor and the caller holds
  // pricing.below_minimum_override (Phase 6): the approval reason recorded on
  // the affected sale lines and in the audit log.
  belowMinimumReason: z.string().trim().max(300).optional(),

  // Phase 1: one-time manager approval token (from POST /api/manager-approval/
  // verify) required when pos_settings.approval_required gates the operation
  // (below-minimum pricing today; refund requests carry their own field).
  approvalToken: z.string().max(120).optional(),

  // Phase 5 (Feature 13): the SALESPERSON on this invoice (nullable =
  // unattributed; defaults to cashier for reporting fallback).
  salespersonUserId: z.number().int().positive().nullable().optional(),

  // ✅ Add the items array here!
  items: z.array(cartItemPayloadSchema).min(1, "Cart cannot be empty"),
});

export const updateAvailableSerialSchema = z.object({
  currentSerial: z.string().trim().min(1).max(100),
  serialNumber: z.string().trim().min(1).max(100),
});

export const saleRefundRequestSchema = z.object({
  reason: z.enum([
    "customer_request",
    "wrong_item",
    "damaged",
    "quality_issue",
    "other",
  ]),
  notes: z.string().trim().max(500).optional(),
  disposition: z.enum(["restock", "inspection", "damaged"]),
  /**
   * Per-line partial returns (UOM Phase 5, migration 0062): quantities are
   * BASE units (e.g. 3 pcs out of a Box-of-12 line). Absent = the full
   * remaining quantity of every listed line (legacy behavior). The engine
   * validates against received − previously returned. Fractional amounts
   * (0.25 kg of a sold-by-weight line) are legal — the engine caps them at
   * 3 decimals and the remaining-quantity math guards the rest.
   */
  quantities: z
    .array(
      z.object({
        saleItemId: z.number().int().positive(),
        quantity: z.number().positive().refine(
          (v) => Math.round(v * 1000) === v * 1000,
          "Quantity supports up to 3 decimals.",
        ),
      }),
    )
    .max(200)
    .optional(),
  /**
   * Restock selection for PARTIAL returns of serial-tracked lines: exactly
   * `quantity` serial ids per line; full-line returns keep the blanket
   * all-serials-of-the-line behavior.
   */
  serialIds: z
    .array(
      z.object({
        saleItemId: z.number().int().positive(),
        serialIds: z.array(z.number().int().positive()).max(500),
      }),
    )
    .max(200)
    .optional(),
  /**
   * How the money goes back. 'cash' = counter/drawer payout;
   * 'original_payment' = provider refund to the original instrument
   * (requires a captured payment intent for the sale and a provider with
   * refund support — the payout fires after the ledger commits and is
   * retryable; provider_refund_id stays NULL until it succeeds).
   */
  refundMethod: z.enum(["cash", "original_payment", "store_credit"]).optional(),
  /**
   * Phase 1: one-time manager approval token, required when
   * pos_settings.approval_required.sale_refund is on. Consumed inside the
   * refund transaction.
   */
  approvalToken: z.string().max(120).optional(),
});

// 3. Export the TypeScript type for your payload
export type CreateSalePayload = z.infer<typeof createSalePayloadSchema>;
export type SaleRefundRequest = z.infer<typeof saleRefundRequestSchema>;
