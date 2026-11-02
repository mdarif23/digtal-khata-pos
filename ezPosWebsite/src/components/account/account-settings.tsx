"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import { useAuth } from "@/components/providers/auth-provider";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import { exportBusinessData, updateBusiness } from "@/lib/api/account";
import {
  fetchSessions,
  revokeSession,
  type ActiveSession,
} from "@/lib/api/sessions";
import { changePassword, updateProfile } from "@/lib/api/portal";

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

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      <p className="mt-1 text-xs text-slate-500">{description}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}

export function AccountSettings() {
  const { user, refresh, onSignedOut } = useAuth();
  const { businessId, business: membership } = useActiveBusiness();

  // Business settings
  const [bizName, setBizName] = useState(membership?.businessName ?? "");
  const [bizPhone, setBizPhone] = useState("");
  const [bizAddress, setBizAddress] = useState("");
  const [bizType, setBizType] = useState<string>(BUSINESS_TYPES[0]);
  const [bizCurrency, setBizCurrency] = useState<string>("BDT");
  const [bizLogo, setBizLogo] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [bizLoaded, setBizLoaded] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [bizMessage, setBizMessage] = useState<string | null>(null);
  const [bizOk, setBizOk] = useState(false);

  // Profile
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileOk, setProfileOk] = useState(false);

  // Password
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordOk, setPasswordOk] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);

  useEffect(() => {
    if (user && fullName === "" && user.fullName) {
      void (async () => {
        await Promise.resolve();
        setFullName(user.fullName);
      })();
    }
  }, [user, fullName]);

  // Load the business profile for fields not exposed on the membership.
  useEffect(() => {
    if (!businessId || bizLoaded) return;
    void (async () => {
      const { getAccessToken } = await import("@/lib/api/auth");
      const API_BASE =
        process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000";
      const res = await fetch(`${API_BASE}/api/businesses/${businessId}`, {
        headers: {
          Authorization: `Bearer ${getAccessToken() ?? ""}`,
          "X-Business-Id": String(businessId),
        },
      });
      if (res.ok) {
        const body = (await res.json()) as {
          business: {
            name: string;
            phone: string | null;
            address: string | null;
            businessType: string | null;
            currency: string;
            logoUrl: string | null;
          };
        };
        setBizName(body.business.name);
        setBizPhone(body.business.phone ?? "");
        setBizAddress(body.business.address ?? "");
        if (body.business.businessType) setBizType(body.business.businessType);
        setBizCurrency(body.business.currency);
        setBizLogo(body.business.logoUrl);
      }
      setBizLoaded(true);
    })();
  }, [businessId, bizLoaded]);

  // Active sessions (loaded once per mount)
  useEffect(() => {
    if (sessionsLoaded) return;
    void (async () => {
      const result = await fetchSessions();
      setSessions(result.data ?? []);
      setSessionsLoaded(true);
    })();
  }, [sessionsLoaded]);

  async function saveBusiness() {
    setBizMessage(null);
    const result = await updateBusiness(businessId!, {
      name: bizName.trim(),
      phone: bizPhone.trim() || undefined,
      address: bizAddress.trim() || undefined,
      businessType: bizType,
      currency: bizCurrency,
      logoDataUrl: bizLogo,
    });
    setBizOk(result.ok);
    setBizMessage(result.message);
  }

  async function saveProfile() {
    setProfileMessage(null);
    const result = await updateProfile({
      fullName: fullName.trim(),
      phone: phone.trim() || undefined,
    });
    setProfileOk(result.ok);
    setProfileMessage(result.message);
    if (result.ok) await refresh();
  }

  async function savePassword() {
    setPasswordMessage(null);
    setPasswordBusy(true);
    const result = await changePassword(currentPassword, newPassword);
    setPasswordBusy(false);
    setPasswordOk(result.ok);
    setPasswordMessage(result.message);
    if (result.ok) {
      // All sessions were revoked server-side — sign out locally too.
      setTimeout(() => onSignedOut(), 2500);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Settings
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Business details, your profile, and account security.
        </p>
      </div>

      {user && !user.emailVerified ? (
        <Alert tone="warning" title="Email not verified">
          {verificationSent ? (
            "Verification email sent — check your inbox."
          ) : (
            <>
              Check your inbox for the verification link, or{" "}
              <button
                type="button"
                className="font-semibold underline underline-offset-2"
                onClick={() => {
                  void (async () => {
                    const { resendVerificationEmail } = await import(
                      "@/lib/api/account"
                    );
                    const result = await resendVerificationEmail();
                    if (result.ok) setVerificationSent(true);
                  })();
                }}
              >
                resend it
              </button>
              .
            </>
          )}
        </Alert>
      ) : null}

      <Card
        title="Business settings"
        description="Shown on invoices and used for currency display."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="settings-biz-name"
            label="Business name"
            value={bizName}
            onChange={(event) => setBizName(event.target.value)}
          />
          <TextField
            id="settings-biz-phone"
            label="Phone"
            value={bizPhone}
            onChange={(event) => setBizPhone(event.target.value)}
          />
          <TextField
            id="settings-biz-address"
            label="Address"
            value={bizAddress}
            onChange={(event) => setBizAddress(event.target.value)}
          />
          <div>
            <label
              htmlFor="settings-biz-type"
              className="block text-sm font-medium text-slate-700"
            >
              Business type
            </label>
            <select
              id="settings-biz-type"
              value={bizType}
              onChange={(event) => setBizType(event.target.value)}
              className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-2 focus:outline-indigo-600"
            >
              {BUSINESS_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="settings-biz-currency"
              className="block text-sm font-medium text-slate-700"
            >
              Currency
            </label>
            <select
              id="settings-biz-currency"
              value={bizCurrency}
              onChange={(event) => setBizCurrency(event.target.value)}
              className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-2 focus:outline-indigo-600"
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-4">
          <span className="block text-sm font-medium text-slate-700">Logo</span>
          <div className="mt-2 flex items-center gap-4">
            {bizLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={bizLogo}
                alt="Business logo preview"
                className="size-16 rounded-lg border border-slate-200 object-contain"
              />
            ) : (
              <div className="flex size-16 items-center justify-center rounded-lg border border-dashed border-slate-300 text-xs text-slate-400">
                None
              </div>
            )}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 180_000) {
                  setBizMessage("Logo is too large — use an image under 180KB.");
                  setBizOk(false);
                  return;
                }
                const reader = new FileReader();
                reader.onload = () => setBizLogo(reader.result as string | null);
                reader.readAsDataURL(file);
              }}
            />
            {bizLogo ? (
              <Button size="sm" variant="ghost" onClick={() => setBizLogo(null)}>
                Remove
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button onClick={saveBusiness} disabled={!businessId}>
            Save business settings
          </Button>
          {bizMessage ? (
            <p
              className={
                bizOk ? "text-sm text-green-700" : "text-sm text-red-600"
              }
              role="status"
            >
              {bizMessage}
            </p>
          ) : null}
        </div>
      </Card>

      <Card
        title="Export your data"
        description="Download your products, customers, sales, and stock as JSON. Available even in read-only mode."
      >
        <Button
          variant="outline"
          disabled={!businessId || exporting}
          onClick={() => {
            setExporting(true);
            try {
              void exportBusinessData(businessId!);
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? "Preparing…" : "Export business data (JSON)"}
        </Button>
      </Card>

      <Card title="Your profile" description="How your name appears in ezPos.">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="settings-full-name"
            label="Full name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
          <TextField
            id="settings-phone"
            label="Phone"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={saveProfile}>Save profile</Button>
          {profileMessage ? (
            <p
              className={profileOk ? "text-sm text-green-700" : "text-sm text-red-600"}
              role="status"
            >
              {profileMessage}
            </p>
          ) : null}
        </div>
      </Card>

      <Card
        title="Active sessions"
        description="Devices currently signed in to your account. Signing one out forces it to log in again."
      >
        {sessions === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-slate-500">No active sessions.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium text-slate-900">
                    {session.userAgent
                      ? session.userAgent.slice(0, 60)
                      : "Unknown device"}
                  </p>
                  <p className="text-xs text-slate-500">
                    {session.ipAddress ?? "unknown IP"} · signed in{" "}
                    {session.createdAt
                      ? new Date(session.createdAt).toLocaleString()
                      : "—"}
                    {session.lastUsedAt
                      ? ` · last active ${new Date(session.lastUsedAt).toLocaleString()}`
                      : ""}
                    {" · expires "}
                    {new Date(session.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void (async () => {
                      const result = await revokeSession(session.id);
                      if (result.ok) {
                        const fresh = await fetchSessions();
                        setSessions(fresh.data ?? []);
                      }
                    })();
                  }}
                >
                  Sign out
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Password"
        description="Changing your password signs you out everywhere for security."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="settings-current-password"
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <TextField
            id="settings-new-password"
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="At least 8 characters."
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button
            onClick={savePassword}
            disabled={passwordBusy || newPassword.length < 8}
          >
            {passwordBusy ? "Updating…" : "Change password"}
          </Button>
          {passwordMessage ? (
            <p
              className={
                passwordOk ? "text-sm text-green-700" : "text-sm text-red-600"
              }
              role="status"
            >
              {passwordMessage}
            </p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
