"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import {
  createPlan,
  fetchAllPlans,
  updatePlan,
  type AdminPlan,
  type PlanFeatures,
  type PlanLimits,
} from "@/lib/api/saas-admin";

const LIMIT_FIELDS: { key: keyof PlanLimits; label: string }[] = [
  { key: "maxUsers", label: "Max users" },
  { key: "maxLocations", label: "Max locations" },
  { key: "maxProducts", label: "Max products" },
  { key: "maxConnectedStores", label: "Max connected stores" },
  { key: "maxWebhookEndpoints", label: "Max webhook endpoints" },
];

const FEATURE_FIELDS: { key: keyof PlanFeatures; label: string }[] = [
  { key: "multiLocation", label: "Multi-location" },
  { key: "advancedReports", label: "Advanced reports" },
  { key: "exports", label: "Exports" },
  { key: "purchaseManagement", label: "Purchase management" },
  { key: "storefrontApi", label: "Storefront API" },
  { key: "woocommerceIntegration", label: "WooCommerce integration" },
  { key: "customStorefront", label: "Custom storefront" },
  { key: "multipleOnlineStores", label: "Multiple online stores" },
  { key: "advancedWebhooks", label: "Advanced webhooks" },
];

export function AdminPlans() {
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [newName, setNewName] = useState("");
  const [newInterval, setNewInterval] = useState<"monthly" | "yearly">("monthly");
  const [newPrice, setNewPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<number | null>(null);
  const [draftLimits, setDraftLimits] = useState<Record<string, string>>({});
  const [draftFeatures, setDraftFeatures] = useState<Record<string, boolean>>({});

  const reload = useCallback(async () => {
    const result = await fetchAllPlans();
    setPlans(result.data ?? []);
  }, []);

  useEffect(() => {
    void (async () => {
      await reload();
    })();
  }, [reload]);

  async function save(plan: AdminPlan, changes: { price?: number; isActive?: boolean; isPopular?: boolean }) {
    setBusy(true);
    setMessage(null);
    const result = await updatePlan(plan.id, changes);
    setBusy(false);
    setMessage({ text: result.message, ok: result.ok });
    if (result.ok) await reload();
  }

  function startEditing(plan: AdminPlan) {
    setEditingPlanId(plan.id);
    setDraftLimits(
      Object.fromEntries(
        LIMIT_FIELDS.map(({ key }) => [
          key,
          plan.limits && plan.limits[key] !== undefined
            ? String(plan.limits[key])
            : "",
        ]),
      ),
    );
    setDraftFeatures(
      Object.fromEntries(
        FEATURE_FIELDS.map(({ key }) => [
          key,
          Boolean(plan.features?.[key]),
        ]),
      ),
    );
    setMessage(null);
  }

  // The backend replaces limits/features wholesale, so both objects are sent
  // complete. A blank limit field removes that limit; unchecking a feature
  // turns it off.
  async function saveEditor(plan: AdminPlan) {
    const limits: PlanLimits = {};
    for (const { key } of LIMIT_FIELDS) {
      const raw = draftLimits[key]?.trim() ?? "";
      if (raw === "") continue;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        setMessage({
          text: `${LIMIT_FIELDS.find((f) => f.key === key)?.label}: enter a whole number of 1 or more, or leave blank to remove the limit.`,
          ok: false,
        });
        return;
      }
      limits[key] = value;
    }
    const features: PlanFeatures = Object.fromEntries(
      FEATURE_FIELDS.map(({ key }) => [key, Boolean(draftFeatures[key])]),
    );
    setBusy(true);
    setMessage(null);
    const result = await updatePlan(plan.id, { limits, features });
    setBusy(false);
    setMessage({ text: result.message, ok: result.ok });
    if (result.ok) {
      setEditingPlanId(null);
      await reload();
    }
  }

  async function create() {
    const price = Number(newPrice);
    if (newName.trim().length < 2 || !Number.isFinite(price) || price < 0) {
      setMessage({ text: "Enter a plan name and a valid price.", ok: false });
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await createPlan({
      name: newName.trim(),
      interval: newInterval,
      price,
    });
    setBusy(false);
    setMessage({ text: result.message, ok: result.ok });
    if (result.ok) {
      setNewName("");
      setNewPrice("");
      await reload();
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">
          Plans
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Plans referenced by subscriptions archive on delete instead of being
          removed. Use “Limits &amp; features” to edit what each plan allows —
          a blank limit removes it.
        </p>
      </div>

      {message ? (
        <Alert tone={message.ok ? "info" : "warning"} title={message.ok ? "Done" : "Action failed"}>
          {message.text}
        </Alert>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">New plan</h3>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <TextField
            id="plan-name"
            label="Name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <div>
            <label
              htmlFor="plan-interval"
              className="block text-sm font-medium text-slate-700"
            >
              Interval
            </label>
            <select
              id="plan-interval"
              value={newInterval}
              onChange={(event) =>
                setNewInterval(event.target.value as "monthly" | "yearly")
              }
              className="mt-1.5 block rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="monthly">monthly</option>
              <option value="yearly">yearly</option>
            </select>
          </div>
          <TextField
            id="plan-price"
            label="Price (BDT)"
            type="number"
            value={newPrice}
            onChange={(event) => setNewPrice(event.target.value)}
          />
          <div className="pb-0.5">
            <Button onClick={create} disabled={busy}>
              Create plan
            </Button>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {plans === null ? (
          <p className="px-5 py-8 text-sm text-slate-500">Loading…</p>
        ) : plans.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-500">No plans yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2 font-medium">Plan</th>
                <th className="px-5 py-2 font-medium">Interval</th>
                <th className="px-5 py-2 font-medium">Price</th>
                <th className="px-5 py-2 font-medium">State</th>
                <th className="px-5 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {plans.map((plan) => (
                <Fragment key={plan.id}>
                <tr>
                  <td className="px-5 py-3">
                    <p className="font-medium text-slate-900">{plan.name}</p>
                    <p className="text-xs text-slate-400">{plan.slug}</p>
                  </td>
                  <td className="px-5 py-3 text-slate-600">{plan.interval}</td>
                  <td className="px-5 py-3">
                    <input
                      type="number"
                      aria-label={`Price for ${plan.name}`}
                      defaultValue={plan.price}
                      onBlur={(event) => {
                        const price = Number(event.target.value);
                        if (Number.isFinite(price) && price !== plan.price) {
                          void save(plan, { price });
                        }
                      }}
                      className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={
                        plan.isActive
                          ? "font-medium text-green-700"
                          : "font-medium text-slate-400"
                      }
                    >
                      {plan.isActive ? "active" : "archived"}
                    </span>
                    {plan.isPopular ? (
                      <span className="block text-xs text-indigo-600">popular</span>
                    ) : null}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void save(plan, { isPopular: !plan.isPopular })}
                      >
                        {plan.isPopular ? "Unmark popular" : "Mark popular"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void save(plan, { isActive: !plan.isActive })
                        }
                      >
                        {plan.isActive ? "Archive" : "Reactivate"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          editingPlanId === plan.id
                            ? setEditingPlanId(null)
                            : startEditing(plan)
                        }
                      >
                        Limits &amp; features
                      </Button>
                    </div>
                  </td>
                </tr>
                {editingPlanId === plan.id ? (
                  <tr>
                    <td colSpan={5} className="border-t border-slate-100 bg-slate-50 px-5 py-4">
                      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
                        {LIMIT_FIELDS.map(({ key, label }) => (
                          <TextField
                            key={key}
                            id={`limit-${plan.id}-${key}`}
                            label={label}
                            type="number"
                            value={draftLimits[key] ?? ""}
                            onChange={(event) =>
                              setDraftLimits((prev) => ({
                                ...prev,
                                [key]: event.target.value,
                              }))
                            }
                          />
                        ))}
                      </div>
                      <fieldset className="mt-4">
                        <legend className="text-xs font-medium uppercase tracking-wide text-slate-500">
                          Features
                        </legend>
                        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                          {FEATURE_FIELDS.map(({ key, label }) => (
                            <label
                              key={key}
                              className="flex items-center gap-2 text-sm text-slate-700"
                            >
                              <input
                                type="checkbox"
                                checked={Boolean(draftFeatures[key])}
                                onChange={(event) =>
                                  setDraftFeatures((prev) => ({
                                    ...prev,
                                    [key]: event.target.checked,
                                  }))
                                }
                                className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <div className="mt-4 flex gap-2">
                        <Button onClick={() => void saveEditor(plan)} disabled={busy}>
                          Save
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => setEditingPlanId(null)}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                      </div>
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
