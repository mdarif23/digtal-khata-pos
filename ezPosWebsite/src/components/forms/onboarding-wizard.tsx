"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Store } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import { useAuth } from "@/components/providers/auth-provider";
import {
  createLocation,
  fetchSubscription,
  updateBusiness,
} from "@/lib/api/account";

const POS_URL = process.env.NEXT_PUBLIC_POS_URL ?? "http://localhost:5173";

const BUSINESS_TYPES = [
  "Retail shop",
  "Grocery / mini market",
  "Clothing & footwear",
  "Electronics & appliances",
  "Cosmetics & personal care",
  "Hardware & building materials",
  "Other",
] as const;

const CURRENCIES = ["BDT", "USD", "EUR", "GBP", "INR"] as const;

const TIMEZONES = [
  "Asia/Dhaka",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
] as const;

const STEP_LABELS = [
  "Business",
  "First location",
  "Preferences",
  "Plan",
] as const;

type Step = 0 | 1 | 2 | 3;

function Progress({ current }: { current: Step }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Setup progress">
      {STEP_LABELS.map((label, index) => (
        <li key={label} className="flex items-center gap-2">
          <span
            aria-current={index === current ? "step" : undefined}
            className={
              index < current
                ? "flex size-6 items-center justify-center rounded-full bg-indigo-600 text-white"
                : index === current
                  ? "flex size-6 items-center justify-center rounded-full border-2 border-indigo-600 text-xs font-semibold text-indigo-700"
                  : "flex size-6 items-center justify-center rounded-full border border-slate-300 text-xs text-slate-400"
            }
          >
            {index < current ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : (
              index + 1
            )}
          </span>
          <span
            className={
              index === current
                ? "text-xs font-semibold text-slate-900"
                : "hidden text-xs text-slate-500 sm:inline"
            }
          >
            {label}
          </span>
          {index < STEP_LABELS.length - 1 ? (
            <span
              aria-hidden="true"
              className="h-px w-4 bg-slate-300 sm:w-6"
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function OnboardingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, businesses } = useAuth();
  const businessParam = Number(searchParams.get("business"));
  const businessId = Number.isInteger(businessParam) && businessParam > 0
    ? businessParam
    : (businesses[0]?.businessId ?? null);

  const [step, setStep] = useState<Step>(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1 — business info
  const [name, setName] = useState("");
  const [businessType, setBusinessType] = useState<string>(BUSINESS_TYPES[0]);
  const [country, setCountry] = useState("Bangladesh");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  // Step 2 — location
  const [locationName, setLocationName] = useState("Main Store");
  const [locationAddress, setLocationAddress] = useState("");
  // Step 3 — preferences
  const [currency, setCurrency] = useState<string>("BDT");
  const [timezone, setTimezone] = useState<string>("Asia/Dhaka");
  // Step 4 — plan
  const [planSummary, setPlanSummary] = useState<{
    planName: string | null;
    status: string;
    trial: boolean;
    currentPeriodEnd: string | null;
  } | null>(null);

  const membership = businesses.find((b) => b.businessId === businessId);

  useEffect(() => {
    if (status === "anonymous") router.replace("/sign-in");
  }, [status, router]);

  // Prefill from the existing membership once the auth context resolves.
  useEffect(() => {
    if (membership && !name) {
      setName(membership.businessName);
    }
  }, [membership, name]);

  useEffect(() => {
    if (step !== 3 || !businessId) return;
    void (async () => {
      const result = await fetchSubscription(businessId);
      if (result.ok && result.data) {
        setPlanSummary({
          planName: result.data.plan?.name ?? null,
          status: result.data.subscription.status,
          trial: result.data.subscription.trial,
          currentPeriodEnd: result.data.subscription.currentPeriodEnd,
        });
      }
    })();
  }, [step, businessId]);

  if (status !== "authenticated") {
    return (
      <p className="py-16 text-center text-sm text-slate-500" role="status">
        {status === "loading" ? "Loading…" : "Redirecting…"}
      </p>
    );
  }

  if (!businessId) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <Alert tone="warning" title="No business to set up" role="alert">
          Create a business from your dashboard first, then come back to
          finish setup.
        </Alert>
        <Button className="mt-6 w-full" onClick={() => router.push("/dashboard")}>
          Go to dashboard
        </Button>
      </div>
    );
  }

  async function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  const step1 = () =>
    run(async () => {
      if (name.trim().length < 2) {
        setError("Enter your business name.");
        return;
      }
      const result = await updateBusiness(businessId, {
        name: name.trim(),
        businessType,
        country: country.trim() || undefined,
        phone: phone.trim() || undefined,
        address: address.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setStep(1);
    });

  const step2 = () =>
    run(async () => {
      if (locationName.trim().length < 2) {
        setError("Give this location a name (e.g. Main Store).");
        return;
      }
      const result = await createLocation(businessId, {
        name: locationName.trim(),
        address: locationAddress.trim() || undefined,
      });
      // A duplicate name/code is fine — the location likely exists already.
      if (!result.ok && result.status !== 409) {
        setError(result.message);
        return;
      }
      setStep(2);
    });

  const step3 = () =>
    run(async () => {
      const result = await updateBusiness(businessId, {
        currency,
        timezone,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setStep(3);
    });

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-indigo-600 text-white">
          <Store className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            Set up your business
          </h1>
          <p className="text-sm text-slate-500">
            Four quick steps — you can skip any and finish later.
          </p>
        </div>
      </div>

      <div className="mt-6 border-t border-slate-100 pt-6">
        <Progress current={step} />
      </div>

      {error ? (
        <div className="mt-6">
          <Alert tone="warning" title="Please check" role="alert">
            {error}
          </Alert>
        </div>
      ) : null}

      {step === 0 ? (
        <div className="mt-6 space-y-5">
          <TextField
            id="onboarding-name"
            label="Business name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Arif General Store"
          />
          <div>
            <label
              htmlFor="onboarding-type"
              className="block text-sm font-medium text-slate-700"
            >
              Business type
            </label>
            <select
              id="onboarding-type"
              value={businessType}
              onChange={(event) => setBusinessType(event.target.value)}
              className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-2 focus:outline-indigo-600"
            >
              {BUSINESS_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>
          <TextField
            id="onboarding-country"
            label="Country"
            value={country}
            onChange={(event) => setCountry(event.target.value)}
            autoComplete="country-name"
          />
          <TextField
            id="onboarding-phone"
            label="Business phone (optional)"
            type="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            autoComplete="tel"
          />
          <TextField
            id="onboarding-address"
            label="Address (optional)"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            autoComplete="street-address"
          />
          <div className="flex gap-3">
            <Button className="flex-1" onClick={step1} disabled={busy}>
              {busy ? "Saving…" : "Continue"}
            </Button>
            <Button variant="outline" onClick={() => setStep(1)} disabled={busy}>
              Skip
            </Button>
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="mt-6 space-y-5">
          <p className="text-sm text-slate-600">
            Where does the counter live? Stock and registers are tracked per
            location.
          </p>
          <TextField
            id="onboarding-location"
            label="Location name"
            value={locationName}
            onChange={(event) => setLocationName(event.target.value)}
            placeholder="Main Store"
          />
          <TextField
            id="onboarding-location-address"
            label="Location address (optional)"
            value={locationAddress}
            onChange={(event) => setLocationAddress(event.target.value)}
          />
          <div className="flex gap-3">
            <Button className="flex-1" onClick={step2} disabled={busy}>
              {busy ? "Saving…" : "Continue"}
            </Button>
            <Button variant="outline" onClick={() => setStep(2)} disabled={busy}>
              Skip
            </Button>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="mt-6 space-y-5">
          <div>
            <label
              htmlFor="onboarding-currency"
              className="block text-sm font-medium text-slate-700"
            >
              Currency
            </label>
            <select
              id="onboarding-currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-2 focus:outline-indigo-600"
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="onboarding-timezone"
              className="block text-sm font-medium text-slate-700"
            >
              Timezone
            </label>
            <select
              id="onboarding-timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-2 focus:outline-indigo-600"
            >
              {TIMEZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-3">
            <Button className="flex-1" onClick={step3} disabled={busy}>
              {busy ? "Saving…" : "Continue"}
            </Button>
            <Button variant="outline" onClick={() => setStep(3)} disabled={busy}>
              Skip
            </Button>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="mt-6 space-y-5">
          {planSummary ? (
            <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900">
              {planSummary.trial && planSummary.status === "trialing" ? (
                <>
                  <p className="font-medium">
                    Your free trial is active
                    {planSummary.currentPeriodEnd
                      ? ` until ${new Date(planSummary.currentPeriodEnd).toLocaleDateString()}`
                      : ""}
                    .
                  </p>
                  <p className="mt-1 opacity-90">
                    Every core feature is unlocked — no charge during the
                    trial. Choose a plan any time to keep going after it ends.
                  </p>
                </>
              ) : planSummary.planName ? (
                <p className="font-medium">
                  Current plan: {planSummary.planName}
                </p>
              ) : (
                <p className="font-medium">
                  No plan selected yet — your account is in read-only mode.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500" role="status">
              Loading your plan…
            </p>
          )}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button className="flex-1" onClick={() => router.push("/pricing")}>
              Compare plans
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => router.push("/dashboard")}
            >
              Go to dashboard
            </Button>
            <Button
              variant="ghost"
              className="flex-1"
              onClick={() => window.open(POS_URL, "_blank")}
            >
              Open POS
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function OnboardingWizard() {
  return (
    <Suspense fallback={null}>
      <OnboardingContent />
    </Suspense>
  );
}
