"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import { useAuth } from "@/components/providers/auth-provider";
import { updateBusiness } from "@/lib/api/account";
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
  const { businesses, user, refresh, onSignedOut } = useAuth();
  const membership = businesses[0];
  const businessId = membership?.businessId ?? null;

  // Business settings
  const [bizName, setBizName] = useState(membership?.businessName ?? "");
  const [bizPhone, setBizPhone] = useState("");
  const [bizAddress, setBizAddress] = useState("");
  const [bizType, setBizType] = useState<string>(BUSINESS_TYPES[0]);
  const [bizCurrency, setBizCurrency] = useState<string>("BDT");
  const [bizLoaded, setBizLoaded] = useState(false);
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
    if (user && fullName === "" && user.fullName) setFullName(user.fullName);
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
          };
        };
        setBizName(body.business.name);
        setBizPhone(body.business.phone ?? "");
        setBizAddress(body.business.address ?? "");
        if (body.business.businessType) setBizType(body.business.businessType);
        setBizCurrency(body.business.currency);
      }
      setBizLoaded(true);
    })();
  }, [businessId, bizLoaded]);

  async function saveBusiness() {
    setBizMessage(null);
    const result = await updateBusiness(businessId!, {
      name: bizName.trim(),
      phone: bizPhone.trim() || undefined,
      address: bizAddress.trim() || undefined,
      businessType: bizType,
      currency: bizCurrency,
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
          Check your inbox for the verification link, or resend it below.
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
