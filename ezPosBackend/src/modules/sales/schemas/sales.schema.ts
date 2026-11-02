import z from "zod";
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
  serialNumbers: z.array(z.string().trim().min(1)).optional()
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
});

// 3. Export the TypeScript type for your payload
export type CreateSalePayload = z.infer<typeof createSalePayloadSchema>;
export type SaleRefundRequest = z.infer<typeof saleRefundRequestSchema>;
