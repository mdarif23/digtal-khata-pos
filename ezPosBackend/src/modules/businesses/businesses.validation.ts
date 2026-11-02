import { z } from "zod";

/**
 * Optional string field that trims, treats "" as absent, and validates the
 * rest. Implemented with z.preprocess because `.optional()` applied after
 * `.transform()/.pipe()` would still require the raw input to be a string.
 */
function optionalTextField(
  inner: z.ZodType<string>,
): z.ZodType<string | undefined> {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }, inner.optional());
}

export const createBusinessSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Enter your business name")
    .max(100, "Business name is too long"),
  phone: optionalTextField(
    z.string().regex(/^\+?[0-9\s-]{6,20}$/, "Enter a valid phone number"),
  ),
  email: optionalTextField(z.email("Enter a valid email address").max(255)),
  address: optionalTextField(z.string().max(500, "Address is too long")),
  businessType: optionalTextField(z.string().max(50, "Business type is too long")),
  country: optionalTextField(z.string().max(50, "Country is too long")),
});

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;

export const updateBusinessSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  phone: optionalTextField(
    z.string().regex(/^\+?[0-9\s-]{6,20}$/, "Enter a valid phone number"),
  ),
  email: optionalTextField(z.email("Enter a valid email address").max(255)),
  address: optionalTextField(z.string().max(500, "Address is too long")),
  businessType: optionalTextField(z.string().max(50, "Business type is too long")),
  country: optionalTextField(z.string().max(50, "Country is too long")),
  currency: optionalTextField(
    z
      .string()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().length(3, "Use a 3-letter currency code such as BDT")),
  ),
  timezone: optionalTextField(
    z
      .string()
      .max(64, "Timezone is too long")
      .regex(
        /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/,
        "Use an IANA timezone such as Asia/Dhaka",
      ),
  ),
  mode: z
    .enum(["physical_only", "online_only", "omnichannel"], {
      message: "Invalid business mode.",
    })
    .optional(),
});

export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;
