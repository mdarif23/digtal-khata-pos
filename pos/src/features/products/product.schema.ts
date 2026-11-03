import { z } from "zod";
const serialNumberSchema = z.object({
  serial: z.string().min(1, { message: "Serial number is required" }),
});
const variantSchema = z.object({
  id: z.number().int().optional(),
  options: z
    .array(
      z.object({
        typeId: z.number().int(),
        typeName: z.string(),
        optionId: z.number().int(),
        value: z.string(),
      }),
    )
    .optional(),
  sku: z.string().max(100),
  barcode: z
    .string()
    .max(100)
    .nullable()
    .transform((val) => (val?.trim() === "" ? null : val)),
  sellingPrice: z.coerce.number().min(0),
  alertQuantity: z.coerce.number().min(0),
  isDefault: z.boolean(),
  status: z.enum(["active", "inactive"]),
  imageUrl: z.string().url("Invalid URL").nullable(),
  imageFile: z.instanceof(File).nullable(),
  batchNumber: z.string().max(100),
  purchasePrice: z.coerce.number().min(0),
  quantity: z.coerce.number().int().min(0),
  expiryDate: z.date().nullable(),
  serialNumbers: z.array(serialNumberSchema).optional(),
});

export const productSchema = z
  .object({
    name: z.string().min(1, { message: "Product name is required" }).max(100),
    categoryId: z.number().int().nullable(),
    brandId: z.number().int().nullable(),
    unitId: z
      .number()
      .int()
      .nullable()
      .refine((val) => val !== null, {
        message: "Product Unit is required. Please select a product unit",
      }),
    description: z.string().max(120),
    productType: z.enum(["physical", "service", "digital"]),
    hasVariants: z.boolean(),
    trackingType: z
      .enum(["none", "batch", "serial"])
      .nullable()
      .refine((val) => val !== null, {
        message: "Tracking type is required. Please select a tracking type",
      }),
    supplierId: z.number().int().nullable(),
    status: z.enum(["draft", "active", "inactive"]),
    imageUrl: z.string().url().nullable(),
    imageFile: z.instanceof(File).nullable(),
    source: z.enum(["purchase", "opening"]),
    // Shipping & Packaging defaults (online orders) — copied into sale
    // packages at pack time; editing these never rewrites processed orders.
    shippingWeightKg: z.coerce.number().min(0).nullable().optional(),
    shippingLengthCm: z.coerce.number().min(0).nullable().optional(),
    shippingWidthCm: z.coerce.number().min(0).nullable().optional(),
    shippingHeightCm: z.coerce.number().min(0).nullable().optional(),
    packagingInstructions: z.string().max(1000).nullable().optional(),
    handlingInstructions: z.string().max(1000).nullable().optional(),
    isFragile: z.boolean().optional(),
    variants: z.array(variantSchema),
  })
  .superRefine((data, ctx) => {
    if (data.hasVariants) {
      if (data.variants.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["variants"],
          message: "Add at least one variant if the product has variants",
        });
      }
      data.variants.forEach((variant, index) => {
        if (!variant.options?.length) {
          ctx.addIssue({
            code: "custom",
            path: ["variants", index, "options"],
            message: "Variant options are required",
          });
        }
      });
    }
    data.variants.forEach((variant, index) => {
      if (data.trackingType === "serial" && data.source === "opening") {
        const seenSerials = new Set<string>();
        variant.serialNumbers?.forEach((item, serialIndex) => {
          const normalizedSerial = item.serial.trim().toLocaleLowerCase();
          if (!normalizedSerial) return;
          if (seenSerials.has(normalizedSerial)) {
            ctx.addIssue({
              code: "custom",
              path: ["variants", index, "serialNumbers", serialIndex, "serial"],
              message: "Serial numbers must be unique within this variant",
            });
          }
          seenSerials.add(normalizedSerial);
        });
      }

      const openingRequiredFields = [
        { key: "quantity" as const, label: "Quantity" },
        { key: "purchasePrice" as const, label: "Purchase Price" },
        { key: "batchNumber" as const, label: "Batch Number" },
      ];
      if (data.source === "opening") {
        openingRequiredFields.forEach(({ key, label }) => {
          if (!variant[key]) {
            if (
              (data.trackingType === "serial" && key === "quantity") ||
              (data.trackingType !== "batch" && key === "batchNumber")
            ) {
              return;
            }
            ctx.addIssue({
              code: "custom",
              path: ["variants", index, key],
              message: `${label} is required for opening stock`,
            });
          }
        });
      }
      if (data.source === "purchase") {
        if (variant.quantity && variant.quantity > 0) {
          ctx.addIssue({
            code: "custom",
            path: ["variants", index, "quantity"],
            message:
              "Quantity must be 0 when registering a product for future purchase.",
          });
        }
      }
    });
    // data.variants.map((variant, index) => {
    //   if (variant.serialNumbers.length === 0) {
    //     ctx.addIssue({
    //       code: "custom",
    //       path: ["variants", index, "serialNumber"],
    //       message:
    //         "Add Serial number if the product has serial number or remove it if not required",
    //     });
    //   }
    // });
  });
export const variantDbSchema = variantSchema.safeExtend({
  id: z.number().optional(),
  purchaseCost: z.number().nullable().optional(),
});
export const productDbSchema = productSchema.safeExtend({
  id: z.number(),
  variants: z.array(variantDbSchema),
});

export type ProductType = z.infer<typeof productDbSchema>;
export type ProductVariantType = z.infer<typeof variantDbSchema>;
export type ProductTypeInput = z.input<typeof productSchema>;
export type ProductTypeOutput = z.output<typeof productSchema>;
