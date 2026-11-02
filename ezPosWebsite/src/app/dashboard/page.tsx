"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ExternalLink, Plus, Store, LogOut } from "lucide-react";
import { Container } from "@/components/ui/container";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import { useAuth } from "@/components/providers/auth-provider";
import { createBusiness } from "@/lib/api/auth";
import { resendVerificationEmail } from "@/lib/api/account";

const POS_URL = process.env.NEXT_PUBLIC_POS_URL ?? "http://localhost:5173";

function subscriptionLabel(status: string, trial: boolean): string {
  if (trial && status === "trialing") return "Free trial — full access";
  if (trial && status === "expired") return "Trial ended — read-only";
  if (status === "active") return "Active subscription";
  if (status === "past_due") return "Payment due — read-only";
  if (status === "canceled" || status === "expired")
    return "Subscription ended — read-only";
  return "No plan yet — read-only";
}

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, user, businesses, onSignedOut } = useAuth();
  const [businessName, setBusinessName] = useState(
    () => searchParams.get("create") ?? "",
  );
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [createError, setCreateError] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);

  // Anonymous visitors never see dashboard content.
  useEffect(() => {
    if (status === "anonymous") router.replace("/sign-in");
  }, [status, router]);

  if (status !== "authenticated" || !user) {
    return (
      <section className="py-24">
        <Container>
          <p className="text-center text-sm text-slate-500" role="status">
            {status === "loading" ? "Loading your workspace…" : "Redirecting…"}
          </p>
        </Container>
      </section>
    );
  }

  const onCreate = async () => {
    if (businessName.trim().length < 2) {
      setCreateMessage("Enter your business name first.");
      setCreateError(true);
      return;
    }
    setCreating(true);
    setCreateMessage(null);
    const result = await createBusiness({ name: businessName.trim() });
    setCreating(false);
    if (result.ok && result.businessId) {
      // Straight into the setup wizard — steps are skippable.
      router.push(`/onboarding?business=${result.businessId}`);
      return;
    }
    setCreateMessage(result.message);
    setCreateError(!result.ok);
  };

  return (
    <section className="py-16 sm:py-24">
      <Container>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
              Welcome, {user.fullName}
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              Signed in as {user.email}
            </p>
            {!user.emailVerified ? (
              <div className="mt-3">
                <Alert tone="warning" title="Email not verified">
                  {verificationSent ? (
                    "Verification email sent — check your inbox."
                  ) : (
                    <>
                      Verify your email to secure your account.{" "}
                      <button
                        type="button"
                        className="font-semibold underline underline-offset-2"
                        onClick={() => {
                          void resendVerificationEmail().then(() =>
                            setVerificationSent(true),
                          );
                        }}
                      >
                        Send verification email
                      </button>
                    </>
                  )}
                </Alert>
              </div>
            ) : null}
          </div>
          <Button
            variant="outline"
            onClick={() => {
              onSignedOut();
              router.push("/");
            }}
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </Button>
        </div>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_360px]">
          {/* Businesses */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Your businesses
            </h2>
            {businesses.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
                No businesses yet — create your first one to start using ezPos.
              </p>
            ) : (
              <ul className="mt-4 space-y-4">
                {businesses.map((business) => (
                  <li
                    key={business.businessId}
                    className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="flex items-center gap-2 font-semibold text-slate-900">
                          <Store
                            className="size-4 text-indigo-600"
                            aria-hidden="true"
                          />
                          {business.businessName}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {business.roleName} ·{" "}
                          {subscriptionLabel(
                            business.subscription.status,
                            business.subscription.trial,
                          )}
                          {business.subscription.currentPeriodEnd
                            ? ` · until ${new Date(
                                business.subscription.currentPeriodEnd,
                              ).toLocaleDateString()}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <ButtonLink
                          href={`/onboarding?business=${business.businessId}`}
                          variant="outline"
                          size="sm"
                        >
                          Business setup
                        </ButtonLink>
                        <ButtonLink href={POS_URL} target="_blank" size="sm">
                          <ExternalLink className="size-4" aria-hidden="true" />
                          Open POS
                        </ButtonLink>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {businesses.some(
              (b) => b.subscription.accessMode === "read_only",
            ) ? (
              <div className="mt-6">
                <Alert
                  title="Read-only access"
                  className="border-amber-200 bg-amber-50 text-amber-900"
                >
                  A business without an active subscription can view its data
                  but not make changes. Plan selection opens when billing goes
                  live.
                </Alert>
              </div>
            ) : null}
          </div>

          {/* Create business */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <Plus className="size-4 text-indigo-600" aria-hidden="true" />
              Create a business
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              You become the owner and can set up products, sales, and
              purchases right away.
            </p>
            <div className="mt-4 space-y-4">
              <TextField
                id="dashboard-business-name"
                label="Business name"
                placeholder="Arif General Store"
                value={businessName}
                onChange={(event) => setBusinessName(event.target.value)}
              />
              <Button
                className="w-full"
                onClick={onCreate}
                disabled={creating || businessName.trim().length < 2}
              >
                {creating ? "Creating…" : "Create business"}
              </Button>
              {createMessage ? (
                <p
                  role="status"
                  className={
                    createError
                      ? "text-sm font-medium text-red-600"
                      : "text-sm text-green-700"
                  }
                >
                  {createMessage}
                </p>
              ) : null}
              <p className="text-xs leading-5 text-slate-500">
                New to ezPos?{" "}
                <Link
                  href="/features"
                  className="font-medium text-indigo-700 hover:underline"
                >
                  See what the POS can do
                </Link>
                .
              </p>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <section className="py-24">
          <Container>
            <p className="text-center text-sm text-slate-500" role="status">
              Loading your workspace…
            </p>
          </Container>
        </section>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}
