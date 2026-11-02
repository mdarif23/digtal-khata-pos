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

export const registerSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, "Enter your full name")
    .max(100, "Name is too long"),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email address").max(255)),
  phone: optionalTextField(
    z.string().regex(/^\+?[0-9\s-]{6,20}$/, "Enter a valid phone number"),
  ),
  password: z
    .string()
    .min(8, "Use at least 8 characters")
    .max(128, "Password is too long"),
  // Optional for backward compatibility with existing clients; the website
  // always sends true (required by its checkbox).
  termsAccepted: z.boolean().optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email address")),
  password: z.string().min(1, "Password is required").max(128),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().trim().min(10).max(200),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email address")),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(10).max(200),
  password: z
    .string()
    .min(8, "Use at least 8 characters")
    .max(128, "Password is too long"),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const updateProfileSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, "Enter your full name")
    .max(100, "Name is too long")
    .optional(),
  phone: z
    .preprocess((value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed === "" ? undefined : trimmed;
    }, z.string().regex(/^\+?[0-9\s-]{6,20}$/, "Enter a valid phone number").optional()),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(128),
  newPassword: z
    .string()
    .min(8, "Use at least 8 characters")
    .max(128, "Password is too long"),
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
