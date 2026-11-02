"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import { signUpSchema, type SignUpValues } from "@/lib/validations/auth";
import { signIn, signUp } from "@/lib/api/auth";
import { useAuth } from "@/components/providers/auth-provider";

export function SignUpForm() {
  const router = useRouter();
  const { onSignedIn } = useAuth();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignUpValues>({
    resolver: zodResolver(signUpSchema),
    defaultValues: {
      fullName: "",
      businessName: "",
      email: "",
      phone: "",
      password: "",
      confirmPassword: "",
    },
  });

  return (
    <form
      noValidate
      onSubmit={handleSubmit(async (values) => {
        setServerError(null);
        // 1. Create the account.
        const registered = await signUp({
          fullName: values.fullName,
          email: values.email,
          password: values.password,
          phone: values.phone || undefined,
        });
        if (!registered.ok) {
          setServerError(registered.message);
          return;
        }
        // 2. Sign in to establish the session.
        const session = await signIn({
          email: values.email,
          password: values.password,
        });
        if (!session.ok) {
          // Account exists — send the user to sign-in rather than faking it.
          router.push("/sign-in?registered=1");
          return;
        }
        await onSignedIn();
        // Carry the intended business name into the dashboard's setup form.
        router.push(
          `/dashboard?create=${encodeURIComponent(values.businessName)}`,
        );
      })}
      className="space-y-5"
    >
      {serverError ? (
        <Alert tone="warning" title="Registration failed" role="alert">
          {serverError}
        </Alert>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          id="fullName"
          label="Full name"
          autoComplete="name"
          placeholder="Arif Hossain"
          error={errors.fullName?.message}
          {...register("fullName")}
        />
        <TextField
          id="businessName"
          label="Business name"
          autoComplete="organization"
          placeholder="Arif General Store"
          error={errors.businessName?.message}
          {...register("businessName")}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          error={errors.email?.message}
          {...register("email")}
        />
        <TextField
          id="phone"
          label="Phone (optional)"
          type="tel"
          autoComplete="tel"
          placeholder="+880 1XXX-XXXXXX"
          error={errors.phone?.message}
          {...register("phone")}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="Use at least 8 characters."
          error={errors.password?.message}
          {...register("password")}
        />
        <TextField
          id="confirmPassword"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          error={errors.confirmPassword?.message}
          {...register("confirmPassword")}
        />
      </div>

      <p className="text-xs leading-5 text-slate-500">
        The business name is saved for your workspace — you will set it up as
        the owner right after your account is created.
      </p>

      <Button
        type="submit"
        size="lg"
        className="w-full"
        disabled={isSubmitting}
      >
        {isSubmitting ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
