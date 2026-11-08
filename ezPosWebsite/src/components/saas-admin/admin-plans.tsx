"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import {
  createPlan,
  fetchAllPlans,
  PLAN_FEATURE_FLAGS,
  PLAN_LIMIT_FIELDS,
  updatePlan,
  type AdminPlan,
} from "@/lib/api/saas-admin";

const FEATURE_LABELS = new Map(PLAN_FEATURE_FLAGS.map((f) => [f.key, f.label]));
const LIMIT_LABELS = new Map(PLAN_LIMIT_FIELDS.map((f) => [f.key, f.label]));

/** Expandable per-plan editor for feature flags and usage limits. */
function PlanEditor({ plan, onSaved }: { plan: AdminPlan; onSaved: () => void }) {
  const [features, setFeatures] = useState<Record<string, boolean>>(
    () => ({ ...(plan.features ?? {}) }),
  );
  const [limits, setLimits] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const { key } of PLAN_LIMIT_FIELDS) {
      const value = plan.limits?.[key];
      initial[key] = value === undefined ? "" : String(value);
    }
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);

  async function save() {
    setBusy(true);
    setResult(null);
    const cleanLimits: Record<string, number> = {};
    for (const { key } of PLAN_LIMIT_FIELDS) {
      const raw = limits[key]?.trim() ?? "";
      if (raw === "") continue; // blank = uncapped
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        setBusy(false);
        setResult({ text: `${LIMIT_LABELS.get(key)} must be a whole number of at least 1, or blank for uncapped.`, ok: false });
        return;
      }
      cleanLimits[key] = parsed;
    }
    const api = await updatePlan(plan.id, { features, limits: cleanLimits });
    setBusy(false);
    setResult({ text: api.message, ok: api.ok });
    if (api.ok) onSaved();
  }

  return (
    <div className="grid gap-6 px-5 py-4 md:grid-cols-2">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Features (POS gating enforced server-side)
        </p>
        <div className="mt-2 space-y-1.5">
          {PLAN_FEATURE_FLAGS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={features[key] === true}
                onChange={(event) =>
                  setFeatures((prev) => ({ ...prev, [key]: event.target.checked }))
                }
                className="h-4 w-4 rounded border-slate-300"
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Usage limits (blank = uncapped)
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {PLAN_LIMIT_FIELDS.map(({ key, label }) => (
            <label key={key} className="text-sm text-slate-700">
              <span className="block text-xs text-slate-500">{label}</span>
              <input
                type="number"
                min={1}
                value={limits[key] ?? ""}
                onChange={(event) =>
                  setLimits((prev) => ({ ...prev, [key]: event.target.value }))
                }
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save features & limits"}
          </Button>
          {result ? (
            <span className={result.ok ? "text-xs text-green-700" : "text-xs text-red-600"}>
              {result.text}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AdminPlans() {
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [newName, setNewName] = useState("");
  const [newInterval, setNewInterval] = useState<"monthly" | "yearly">("monthly");
  const [newPrice, setNewPrice] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const result = await fetchAllPlans();
    if (result.ok && result.data) {
      setPlans(result.data);
      setLoadError(null);
    } else if (result.data === undefined) {
      setLoadError(result.message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function save(plan: AdminPlan, changes: { price?: number; isActive?: boolean; isPopular?: boolean }) {
    setBusy(true);
    setMessage(null);
    const result = await updatePlan(plan.id, changes);
    setBusy(false);
    setMessage({ text: result.message, ok: result.ok });
    if (result.ok) await reload();
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
          removed. Use the editor to control which POS features and usage
          limits each plan includes — changes apply to subscribers immediately.
        </p>
      </div>

      {message ? (
        <Alert tone={message.ok ? "info" : "warning"} title={message.ok ? "Done" : "Action failed"}>
          {message.text}
        </Alert>
      ) : null}
      {loadError ? (
        <Alert tone="warning" title="Could not load plans">
          {loadError}
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
        {plans === null && !loadError ? (
          <p className="px-5 py-8 text-sm text-slate-500">Loading…</p>
        ) : plans !== null && plans.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-500">No plans yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2 font-medium">Plan</th>
                <th className="px-5 py-2 font-medium">Interval</th>
                <th className="px-5 py-2 font-medium">Price</th>
                <th className="px-5 py-2 font-medium">Features / limits</th>
                <th className="px-5 py-2 font-medium">State</th>
                <th className="px-5 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(plans ?? []).map((plan) => {
                const featureCount = Object.values(plan.features ?? {}).filter(Boolean).length;
                const limitCount = Object.keys(plan.limits ?? {}).length;
                const expanded = expandedId === plan.id;
                return (
                  <>
                    <tr key={plan.id}>
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
                      <td className="px-5 py-3 text-slate-600">
                        {featureCount} feature{featureCount === 1 ? "" : "s"}
                        <span className="block text-xs text-slate-400">
                          {limitCount} limit{limitCount === 1 ? "" : "s"}
                        </span>
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
                            onClick={() => setExpandedId(expanded ? null : plan.id)}
                          >
                            {expanded ? "Close editor" : "Edit features & limits"}
                          </Button>
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
                        </div>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr key={`${plan.id}-editor`}>
                        <td colSpan={6} className="border-t border-slate-100 bg-slate-50/60">
                          <PlanEditor
                            plan={plan}
                            onSaved={() => void reload()}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
