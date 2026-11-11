import { z } from "zod";
import { purchasePayments } from "../../../db/schema/purchasePayments.js";

export const REJECTION_CATEGORIES = [
  "damaged",
  "incorrect",
  "expired",
  "other",
] as const;

export const receiveItemsFormSchema = z.object({
  purchaseId: z.number(),
  items: z.array(
    z
      .object({
        itemId: z.number(),
        trackingType: z.enum(["none", "batch", "serial"]),
        // ACCEPTED quantity — the only quantity that enters inventory.
        // When uomConversionId is set this is in the ENTERED packaging unit;
        // the service converts it to base units authoritatively.
        receiveNow: z.number().min(0),
        // Delivered but refused — recorded, never stocked or valued.
        rejectedQuantity: z.number().min(0).default(0),
        rejectionCategory: z
          .enum(REJECTION_CATEGORIES)
          .optional(),
        rejectionReason: z.string().max(300).optional(),
        // Required whenever this line accepts more than the outstanding
        // quantity (over-receiving — within tolerance or approved).
        overReceiveReason: z.string().max(300).optional(),
        unitCost: z.number().min(0),
        sellingPrice: z.number().min(0),
        batches: z.array(
          z.object({
            batchNumber: z.string().min(1),
            quantity: z.number().min(1),
            manufacturedDate: z.coerce.date(),
            expiryDate: z.coerce.date(),
          }),
        ),
        serialNumbers: z.array(
          z.string().min(1, "Serial number cannot be empty"),
        ),
        // Supplier warranty (migration 0064): optional per-line terms
        // captured at receiving time; start date = first receive date.
        warranty: z
          .object({
            duration: z.number().int().positive().max(360),
            durationUnit: z.enum(["days", "months", "years"]).default("months"),
            provider: z
              .enum([
                "manufacturer",
                "seller",
                "distributor",
                "supplier",
                "third_party",
              ])
              .default("supplier"),
            terms: z.string().max(5000).nullish(),
          })
          .optional(),
        // UOM (migration 0062): the packaging unit the quantities below are
        // entered in. NULL = the product's base unit (all legacy clients).
        uomConversionId: z.number().int().positive().nullish(),
      })
      .superRefine((data, ctx) => {
        // Cross-field quantity checks run at the schema ONLY for the identity
        // (base-unit) path — a UOM line needs the server-resolved factor
        // first, so createReceivePurchase re-validates post-conversion.
        const identity = data.uomConversionId == null;
        if (
          identity &&
          data.trackingType === "serial" &&
          !Number.isInteger(data.receiveNow)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["receiveNow"],
            message: "Serial-tracked quantities must be whole numbers.",
          });
        }
        if (
          identity &&
          data.trackingType === "serial" &&
          data.receiveNow > 0
        ) {
          if (data.serialNumbers.length !== data.receiveNow) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["serialNumbers"],
              message: `Quantity is ${data.receiveNow}, but you provided ${data.serialNumbers.length} serial numbers.`,
            });
          }
        }
        if (identity && data.trackingType === "batch" && data.receiveNow > 0) {
          const totalBatchQty = data.batches.reduce(
            (sum, b) => sum + b.quantity,
            0,
          );
          if (totalBatchQty !== data.receiveNow) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["batches"],
              message: `Batch total quantity (${totalBatchQty}) must equal receive quantity (${data.receiveNow}).`,
            });
          }
        }
        if (data.rejectedQuantity > 0) {
          if (!data.rejectionCategory) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["rejectionCategory"],
              message: "A rejection category is required for rejected goods.",
            });
          }
          if (!data.rejectionReason?.trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["rejectionReason"],
              message: "A rejection reason is required for rejected goods.",
            });
          }
        }
        for (const [index, batch] of data.batches.entries()) {
          if (batch.expiryDate.getTime() < batch.manufacturedDate.getTime()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["batches", index, "expiryDate"],
              message: "Expiry date cannot be before the manufacturing date.",
            });
          }
        }
      }),
  ),

  paymentAmount: z.number().min(0),
  paymentMethod: z.enum(purchasePayments.method.enumValues),
  paymentNotes: z.string().optional(),
});
export type ReceiveItemsFormValues = z.infer<typeof receiveItemsFormSchema>;
