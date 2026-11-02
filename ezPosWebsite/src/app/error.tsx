"use client";

import Link from "next/link";
import { Container } from "@/components/ui/container";
import { Button } from "@/components/ui/button";

/**
 * Route-segment error boundary — renders inside the normal layout
 * (header/footer preserved), unlike global-error which replaces it.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="py-24">
      <Container className="max-w-md text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-red-600">
          Something went wrong
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
          This page hit an error
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Try again — if the problem persists, contact us.
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
      </Container>
    </section>
  );
}
