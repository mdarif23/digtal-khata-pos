import { z } from "zod";

export const PAYMENT_ROW_METHODS = [
  "cash",
  "bangla_qr",
  "card",
  "due",
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
    payments: z.array(paymentSchema).min(1, "Select a payment method"),
    discount: z
      .object({
        type: z.enum(["percentage", "fixed"]),
        value: z.number().min(0),
      })
      .nullable(),
    vatPercent: z.number().nullable(),
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
  quantity: z.number().int().positive("Quantity must be at least 1"),
  unitPrice: z.number().nonnegative("Unit price cannot be negative"),
  discount: z
    .object({
      type: z.enum(["percentage", "fixed"]),
      value: z.number().min(0),
    })
    .nullable(),
  serialNumbers: z.array(z.string().trim().min(1)).optional(),
});

// 2. Define the full Payload schema
export const createSalePayloadSchema = z.object({
  saleDate: z.date(),
  customerId: z.number().nullable(),
  payments: z.array(paymentSchema).min(1, "Select a payment method"),
  discount: z
    .object({
      type: z.enum(["percentage", "fixed"]),
      value: z.number().min(0),
    })
    .nullable(),
  vatPercent: z.number().nullable(),

  // ✅ Add the items array here!
  items: z.array(cartItemPayloadSchema).min(1, "Cart cannot be empty"),
});

// 3. Export the TypeScript type for your payload
export type CreateSalePayload = z.infer<typeof createSalePayloadSchema>;
