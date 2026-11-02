"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/forms/text-field";
import {
  createPlan,
  fetchAllPlans,
  updatePlan,
  type AdminPlan,
} from "@/lib/api/saas-admin";

export function AdminPlans() {
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [newName, setNewName] = useState("");
  const [newInterval, setNewInterval] = useState<"monthly" | "yearly">("monthly");
  const [newPrice, setNewPrice] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const result = await fetchAllPlans();
    setPlans(result.data ?? []);
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
          removed. Feature/limit editing lives in the API today; the full
          editor comes with finer-grained admin roles.
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
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
