import { z } from "zod";

export const REJECTION_CATEGORIES = [
  "damaged",
  "incorrect",
  "expired",
  "other",
] as const;

export const receiveItemsFormSchema = z.object({
  purchaseId: z.number().int().positive(),
  items: z.array(
    z
      .object({
        itemId: z.number().int().positive(),
        trackingType: z.enum(["none", "batch", "serial"]),
        // ACCEPTED quantity — the only quantity that enters inventory.
        receiveNow: z.number().finite().min(0),
        // Delivered but refused — recorded, never stocked or valued.
        // (Required: the page's form defaults always provide 0.)
        rejectedQuantity: z.number().finite().min(0),
        rejectionCategory: z.enum(REJECTION_CATEGORIES).optional(),
        rejectionReason: z.string().max(300).optional(),
        // Required whenever this line accepts more than the outstanding
        // quantity (over-receiving — within tolerance or approved).
        overReceiveReason: z.string().max(300).optional(),
        unitCost: z.number().finite().min(0),
        sellingPrice: z.number().finite().min(0),
        batches: z.array(
          z.object({
            batchNumber: z.string().min(1),
            quantity: z.number().min(1),
            manufacturedDate: z.date(),
            expiryDate: z.date(),
          }),
        ),
        serialNumbers: z.array(
          z.string().min(1, "Serial number cannot be empty"),
        ),
      })
      .superRefine((data, ctx) => {
        if (
          data.trackingType === "serial" &&
          !Number.isInteger(data.receiveNow)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["receiveNow"],
            message: "Serial-tracked quantities must be whole numbers.",
          });
        }
        if (data.trackingType === "serial" && data.receiveNow > 0) {
          if (data.serialNumbers.length !== data.receiveNow) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["serialNumbers"],
              message: `Quantity is ${data.receiveNow}, but you provided ${data.serialNumbers.length} serial numbers.`,
            });
          }
        }
        if (data.trackingType === "batch" && data.receiveNow > 0) {
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
  ).min(1, "At least one purchase item is required"),
  paymentAmount: z.number().finite().min(0),
  paymentMethod: z.enum([
    "cash",
    "bank_transfer",
    "cheque",
    "card",
    "other",
  ]),
  paymentNotes: z.string().max(300),
});
export type ReceiveItemsFormValues = z.infer<typeof receiveItemsFormSchema>;
