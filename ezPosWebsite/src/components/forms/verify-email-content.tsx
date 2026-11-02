"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle } from "lucide-react";
import { verifyEmailToken } from "@/lib/api/account";

type State =
  | { kind: "working" }
  | { kind: "verified" }
  | { kind: "failed"; message: string };

export function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const [state, setState] = useState<State>({ kind: "working" });

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setState({
        kind: "failed",
        message: "This link is missing its verification token.",
      });
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await verifyEmailToken(token);
      if (cancelled) return;
      setState(
        result.ok
          ? { kind: "verified" }
          : {
              kind: "failed",
              message:
                result.status === 0
                  ? result.message
                  : "This verification link is invalid or has expired. Request a new one from your account page.",
            },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  if (state.kind === "working") {
    return (
      <p className="text-sm text-slate-500" role="status">
        Checking your verification link…
      </p>
    );
  }

  if (state.kind === "verified") {
    return (
      <div className="flex flex-col items-center py-4 text-center">
        <CheckCircle2 className="size-10 text-green-600" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-semibold text-slate-900">
          Email verified
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Your email address is confirmed. Everything on your account is good
          to go.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center py-4 text-center">
      <XCircle className="size-10 text-red-500" aria-hidden="true" />
      <h1 className="mt-3 text-lg font-semibold text-slate-900">
        Verification failed
      </h1>
      <p className="mt-2 text-sm text-slate-600">{state.message}</p>
    </div>
  );
}
