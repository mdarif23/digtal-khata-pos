import { useCallback, useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getAchievementsApi,
  listTargetsApi,
  setTargetApi,
  type TargetAchievement,
} from "./commission.api";

function extractError(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: { data?: { message?: string } } }).response
      ?.data?.message === "string"
  ) {
    return (error as { response: { data: { message: string } } }).response.data
      .message;
  }
  return fallback;
}

interface UserOption {
  id: number;
  fullName: string;
  isActive: boolean;
}

/**
 * Sales targets (Phase 5 — Feature 13): per-user period targets with
 * achievement computed from salesperson-attributed completed sales.
 */
export function TargetsPage() {
  const [achievements, setAchievements] = useState<TargetAchievement[] | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    userId: "",
    periodType: "monthly",
    periodStart: "",
    periodEnd: "",
    targetAmount: "",
  });

  const load = useCallback(async () => {
    try {
      const [a, u] = await Promise.all([
        getAchievementsApi(),
        import("@/api/axios.js").then((axios) =>
          axios.default
            .get<{ success: boolean; data: UserOption[] }>("/users")
            .then((res) => (res.data.data ?? []).filter((x) => x.isActive))
            .catch(() => [] as UserOption[]),
        ),
      ]);
      setAchievements(a);
      setUsers(u);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to load targets."), type: "error" });
      setAchievements([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (form.userId === "" || !form.periodStart || !form.periodEnd || form.targetAmount === "") {
      toast.add({ title: "Fill the user, period and target amount.", type: "error" });
      return;
    }
    setSaving(true);
    try {
      await setTargetApi({
        userId: Number(form.userId),
        periodType: form.periodType,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        targetAmount: Number(form.targetAmount),
      });
      toast.add({ title: "Target saved.", type: "success" });
      setAchievements(await getAchievementsApi());
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to save the target."), type: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-5 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold">Sales targets</h1>
        <p className="text-sm text-muted-foreground">
          Per-user targets with achievement from attributed sales.
        </p>
      </div>

      <section className="grid gap-3 rounded-md border p-4">
        <h2 className="font-medium">Set a target</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor="target-user">User</Label>
            <select
              id="target-user"
              className="rounded-md border bg-background p-2 text-sm"
              value={form.userId}
              onChange={(e) => setForm({ ...form, userId: e.target.value })}
            >
              <option value="">Pick a user</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.fullName}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="target-type">Period</Label>
            <select
              id="target-type"
              className="rounded-md border bg-background p-2 text-sm"
              value={form.periodType}
              onChange={(e) => setForm({ ...form, periodType: e.target.value })}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="target-start">Start</Label>
            <Input
              id="target-start"
              type="date"
              value={form.periodStart}
              onChange={(e) => setForm({ ...form, periodStart: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="target-end">End</Label>
            <Input
              id="target-end"
              type="date"
              value={form.periodEnd}
              onChange={(e) => setForm({ ...form, periodEnd: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="target-amount">Target (৳)</Label>
            <Input
              id="target-amount"
              type="number"
              min={0}
              value={form.targetAmount}
              onChange={(e) => setForm({ ...form, targetAmount: e.target.value })}
            />
          </div>
        </div>
        <div>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save target"}
          </Button>
        </div>
      </section>

      <section className="grid gap-2">
        <h2 className="font-medium">Achievement</h2>
        {achievements === null ? (
          <Skeleton className="h-32 w-full" />
        ) : achievements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No targets set.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">User</th>
                  <th className="p-2 font-medium">Period</th>
                  <th className="p-2 text-right font-medium">Target</th>
                  <th className="p-2 text-right font-medium">Actual</th>
                  <th className="p-2 font-medium">Achievement</th>
                </tr>
              </thead>
              <tbody>
                {achievements.map((row) => (
                  <tr key={`${row.userId}-${row.periodStart}`} className="border-t">
                    <td className="p-2 font-medium">{row.userName}</td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {row.periodType} · {row.periodStart} → {row.periodEnd}
                    </td>
                    <td className="p-2 text-right font-mono">
                      ৳{row.targetAmount.toLocaleString()}
                    </td>
                    <td className="p-2 text-right font-mono">
                      ৳{row.actualAmount.toLocaleString()}
                    </td>
                    <td className="p-2">
                      {row.achievementPercent === null ? (
                        "—"
                      ) : (
                        <span
                          className={
                            row.achievementPercent >= 100
                              ? "font-semibold text-success"
                              : "font-semibold text-warning"
                          }
                        >
                          {row.achievementPercent}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
