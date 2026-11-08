"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import { forgotPassword } from "@/lib/api/account";
import { SERVER_UNREACHABLE_MESSAGE } from "@/lib/api/auth";

const schema = z.object({
  email: z.string().trim().pipe(z.email("Enter a valid email address")),
});
type Values = z.infer<typeof schema>;

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  if (sent) {
    return (
      <Alert tone="info" title="Check your inbox">
        If an account exists for that email, a password-reset link is on its
        way. The link works once and expires shortly.
      </Alert>
    );
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit(async ({ email }) => {
        setServerError(null);
        const result = await forgotPassword(email);
        // Always shows the confirmation — the backend never reveals whether
        // the email belongs to an account. Only a transport-level failure
        // (API unreachable) blocks the flow with an error.
        if (result.status === 0) {
          setServerError(result.message ?? SERVER_UNREACHABLE_MESSAGE);
          return;
        }
        setSent(true);
      })}
      className="space-y-5"
    >
      {serverError ? (
        <Alert tone="warning" title="Request failed">
          {serverError}
        </Alert>
      ) : null}
      <TextField
        id="forgot-email"
        label="Email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        error={errors.email?.message}
        {...register("email")}
      />
      <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
