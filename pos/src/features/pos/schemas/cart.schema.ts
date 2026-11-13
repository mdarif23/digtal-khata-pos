import { z } from "zod";

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

export const cartSchema = z
  .object({
    saleDate: z.date({ message: "Sale date is required" }),
    customerId: z.number().nullable(),
    /** Phase 5 (Feature 13): salesperson attribution (null = cashier fallback). */
    salespersonUserId: z.number().nullable().optional(),
    payments: z.array(paymentSchema).min(1, "Select a payment method"),
    discount: z
      .object({
        type: z.enum(["percentage", "fixed"]),
        value: z.number().min(0),
      })
      .nullable(),
    vatPercent: z.number().nullable(),
    // Coupon entry (Module 6): optional so the resolver keeps the value the
    // CouponInput writes — without it zod strips the field and createSale
    // never sees the code even though the quote preview showed it.
    couponCode: z.string().trim().max(60).optional(),
  })
  .superRefine((data, ctx) => {
    data.payments.forEach((p, i) => {
      const amount = p.amount ?? 0;

      if (
        (p.method === "bangla_qr" || p.method === "card") &&
        amount > 0 &&
        (p.reference ?? "").length < 6
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["payments", i, "reference"],
          message: "Transaction ID must be at least 6 characters",
        });
      }

      if (p.method === "due" && amount > 0 && data.customerId == null) {
        ctx.addIssue({
          code: "custom",
          path: ["payments", i, "amount"],
          message: "Select a customer for due payments",
        });
      }
    });
  });

export type CartSchemaType = z.infer<typeof cartSchema>;
export type PaymentSchemaType = z.infer<typeof paymentSchema>;
// 1. Define what a single cart item should look like when sent to the DB
const cartItemPayloadSchema = z.object({
  variantId: z.number().int().positive("Variant ID is required"),
  // Quantity in the SELECTED sell unit (2 = two boxes; 0.5 = half a kg on a
  // sold-by-weight variant). Fractional amounts are legal up to 3 decimals —
  // scale scans and the weight quantity input only produce them for
  // sold-by-weight lines, and the server re-enforces the per-variant rule
  // (identity lines must be whole UNLESS the variant is sold by weight).
  quantity: z
    .number()
    .positive("Quantity must be at least 1")
    .refine(
      // Round-trip compare — a plain `Math.round(v*1000) === v*1000` falsely
      // rejects legal decimals like 1.005 (float representation).
      (v) => Math.round(v * 1000) / 1000 === v,
      "Quantity supports up to 3 decimals.",
    ),
  // Advisory per-selected-unit price — the server re-resolves trusted prices.
  unitPrice: z.number().nonnegative("Unit price cannot be negative"),
  discount: z
    .object({
      type: z.enum(["percentage", "fixed"]),
      value: z.number().min(0),
    })
    .nullable(),
  serialNumbers: z.array(z.string().trim().min(1)).optional(),
  // Packaging-unit selling: null = base unit line.
  uomConversionId: z.number().int().positive().nullable().optional(),
  // Phase 6: permission-gated price override (unit price in the selected
  // sell unit). The server re-checks the permission and the minimum floors.
  priceOverride: z
    .object({
      unitPrice: z.number().min(0),
      reason: z.string().trim().max(300).optional(),
    })
    .nullish(),
});

// 2. Define the full Payload schema
export const createSalePayloadSchema = z.object({
  saleDate: z.date(),
  customerId: z.number().nullable(),
  /** Phase 5 (Feature 13): the attributed salesperson (null = cashier fallback). */
  salespersonUserId: z.number().nullable().optional(),
  payments: z.array(paymentSchema).min(1, "Select a payment method"),
  discount: z
    .object({
      type: z.enum(["percentage", "fixed"]),
      value: z.number().min(0),
    })
    .nullable(),
  vatPercent: z.number().nullable(),
  couponCode: z.string().trim().max(60).optional(),

  // Client-generated key making checkout retries idempotent (see useCartStore).
  idempotencyKey: z.string().min(8).max(120).optional(),

  // Mandatory when a line lands below its minimum floor and the cashier holds
  // pricing.below_minimum_override (Phase 6).
  belowMinimumReason: z.string().trim().max(300).optional(),

  // ✅ Add the items array here!
  items: z.array(cartItemPayloadSchema).min(1, "Cart cannot be empty"),
});

// 3. Export the TypeScript type for your payload
export type CreateSalePayload = z.infer<typeof createSalePayloadSchema>;
