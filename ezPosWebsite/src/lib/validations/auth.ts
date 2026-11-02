import { z } from "zod";

/**
 * Preview schemas for the sign-in and sign-up forms.
 * These power client-side validation only — no authentication exists yet.
 */

export const signInSchema = z.object({
  email: z
    .string()
    .min(1, "Email is required")
    .email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export type SignInValues = z.infer<typeof signInSchema>;

export const signUpSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, "Enter your full name")
      .max(100, "Name is too long"),
    businessName: z
      .string()
      .trim()
      .min(2, "Enter your business name")
      .max(100, "Business name is too long"),
    email: z
      .string()
      .min(1, "Email is required")
      .email("Enter a valid email address"),
    phone: z
      .string()
      .trim()
      .regex(/^$|^\+?[0-9\s-]{6,19}$/, "Enter a valid phone number"),
    password: z.string().min(8, "Use at least 8 characters"),
    confirmPassword: z.string().min(1, "Confirm your password"),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });

export type SignUpValues = z.infer<typeof signUpSchema>;
