import { z } from "zod";
export const createPurchaseSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.number().int().positive(),
        quantity: z.number().positive(),
        purchasePrice: z.number().nonnegative(),
        discount: z.number().nonnegative().default(0),
        tax: z.number().nonnegative().default(0),
      }),
    )
    .min(1, "At least one purchase item is required"),
  supplierId: z.number().int().positive().nullable(),
  purchaseDate: z.coerce.date(),
  discount: z.number().nonnegative().default(0),
  /** Percentage discounts resolve to the fixed amount at creation; the
   *  stored discount is always the resolved payable amount. */
  discountBasis: z.enum(["fixed", "percentage"]).default("fixed"),
  tax: z.number().nonnegative().default(0),
  shippingCost: z.number().nonnegative().default(0),
  notes: z
    .string()
    .max(300, "Notes are too long")
    .optional()
    .or(z.literal(""))
    .transform((val) => (val?.trim() === "" ? null : val)),
}).superRefine((purchase, ctx) => {
  const subtotal = purchase.items.reduce((sum, item, index) => {
    const gross = item.quantity * item.purchasePrice;
    if (item.discount > gross) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index, "discount"],
        message: "Line discount cannot exceed the line amount",
      });
    }
    return sum + gross - item.discount + item.tax;
  }, 0);

  if (purchase.discount > subtotal) {
    ctx.addIssue({
      code: "custom",
      path: ["discount"],
      message: "Purchase discount cannot exceed the items subtotal",
    });
  }
});
export type CreatePurchaseInput =
  z.output<typeof createPurchaseSchema>;