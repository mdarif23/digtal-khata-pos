"use client";

import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Global error boundary — catches unhandled render/runtime errors in any
 * route segment and shows a branded recovery screen instead of the
 * framework default.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-full flex-col bg-white font-sans text-slate-900 antialiased">
        <section className="py-24">
          <div className="mx-auto max-w-md text-center">
            <p className="text-sm font-semibold uppercase tracking-wide text-red-600">
              Something went wrong
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
              An unexpected error occurred
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              The page could not be rendered. Try again — if the problem
              persists, contact us through the contact page.
            </p>
            {error.digest ? (
              <p className="mt-2 text-xs text-slate-400">
                Error reference: {error.digest}
              </p>
            ) : null}
            <div className="mt-8 flex justify-center gap-3">
              <Button onClick={reset}>Try again</Button>
              <Link
                href="/"
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Back to home
              </Link>
            </div>
            <div className="mt-6 flex justify-center">
              <Alert tone="info" title="Tip">
                If you were in the middle of checkout, your order and payment
                state are safe — return via Account → Billing.
              </Alert>
            </div>
          </div>
        </section>
      </body>
    </html>
  );
}
