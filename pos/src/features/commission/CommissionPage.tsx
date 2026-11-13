import { useCallback, useEffect, useState } from "react";
import { RefreshCcw } from "lucide-react";
import api from "@/api/axios.js";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type CommissionTotals,
  createRuleApi,
  listEntriesApi,
  listRulesApi,
  transitionEntryApi,
  updateRuleApi,
  type CommissionEntryRow,
  type CommissionRule,
} from "./commission.api";
import { formatCurrency } from "@/features/reports/utils/reportUtils";

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

const STATUS_FILTERS = ["all", "pending", "approved", "payable", "paid", "reversed"] as const;

/**
 * Commission management (Phase 5 — Feature 13): rules, entry ledger with
 * the forward-only lifecycle, and totals. Targets live on the Targets page.
 */
export function CommissionPage() {
  const [rules, setRules] = useState<CommissionRule[] | null>(null);
  const [rows, setRows] = useState<CommissionEntryRow[] | null>(null);
  const [totals, setTotals] = useState<CommissionTotals | null>(null);
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [acting, setActing] = useState(false);
  const [users, setUsers] = useState<{ id: number; fullName: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const [r, e] = await Promise.all([
        listRulesApi(),
        listEntriesApi({
          ...(statusFilter !== "all" ? { status: statusFilter } : {}),
        }),
      ]);
      setRules(r);
      setRows(e.rows);
      setTotals(e.totals);
      api
        .get<{ success: boolean; data: { id: number; fullName: string }[] }>("/users")
        .then((res) => setUsers((res.data.data ?? []).filter((u: { id: number; fullName: string; isActive?: boolean }) => u.isActive !== false)))
        .catch(() => setUsers([]));
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to load commissions."), type: "error" });
      setRules([]);
      setRows([]);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function advance(entry: CommissionEntryRow, to: "approved" | "payable" | "paid" | "reversed") {
    setActing(true);
    try {
      await transitionEntryApi(entry.id, to);
      toast.add({ title: `Entry ${to}.`, type: "success" });
      void load();
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to update the entry."), type: "error" });
    } finally {
      setActing(false);
    }
  }

  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [ruleForm, setRuleForm] = useState({
    name: "",
    calcMethod: "percentage_of_sales",
    rate: "5",
    userId: "",
  });

  async function createRule() {
    setActing(true);
    try {
      await createRuleApi({
        name: ruleForm.name.trim(),
        calcMethod: ruleForm.calcMethod,
        rate: Number(ruleForm.rate) || 0,
        userId: ruleForm.userId === "" ? null : Number(ruleForm.userId),
        isActive: true,
      });
      setRules(await listRulesApi());
      setRuleFormOpen(false);
      setRuleForm({ name: "", calcMethod: "percentage_of_sales", rate: "5", userId: "" });
      toast.add({ title: "Rule created.", type: "success" });
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to create the rule."), type: "error" });
    } finally {
      setActing(false);
    }
  }

  async function toggleRule(rule: CommissionRule) {
    try {
      await updateRuleApi(rule.id, { isActive: !rule.isActive });
      setRules(await listRulesApi());
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to update the rule."), type: "error" });
    }
  }

  return (
    <div className="grid gap-5 p-4 lg:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Commissions</h1>
          <p className="text-sm text-muted-foreground">
            Salesperson commission rules and the entry ledger.
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()}>
          <RefreshCcw className="size-4" /> Refresh
        </Button>
      </div>

      {totals ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Pending</p>
            <p className="text-lg font-semibold">{formatCurrency(totals.pending ?? 0)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Approved / payable</p>
            <p className="text-lg font-semibold">{formatCurrency(totals.approved ?? 0)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Paid</p>
            <p className="text-lg font-semibold">{formatCurrency(totals.paid ?? 0)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Reversed</p>
            <p className="text-lg font-semibold text-red-600">
              {formatCurrency(totals.reversed ?? 0)}
            </p>
          </div>
        </div>
      ) : null}

      <section className="grid gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Rules</h2>
          <Button size="sm" onClick={() => setRuleFormOpen(true)}>
            New rule
          </Button>
        </div>
        {rules === null ? (
          <Skeleton className="h-20 w-full" />
        ) : rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No commission rules yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">Name</th>
                  <th className="p-2 font-medium">Method</th>
                  <th className="p-2 text-right font-medium">Rate</th>
                  <th className="p-2 font-medium">Status</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id} className="border-t">
                    <td className="p-2 font-medium">{rule.name}</td>
                    <td className="p-2 font-mono text-xs">{rule.calcMethod}</td>
                    <td className="p-2 text-right font-mono">
                      {rule.calcMethod === "fixed_per_sale"
                        ? formatCurrency(rule.rate)
                        : `${rule.rate}%`}
                    </td>
                    <td className="p-2">
                      <Badge variant={rule.isActive ? "default" : "secondary"}>
                        {rule.isActive ? "active" : "off"}
                      </Badge>
                    </td>
                    <td className="p-2 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void toggleRule(rule)}
                      >
                        {rule.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog open={ruleFormOpen} onOpenChange={setRuleFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New commission rule</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="rule-name">Name</Label>
              <Input
                id="rule-name"
                value={ruleForm.name}
                onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rule-method">Method</Label>
              <select
                id="rule-method"
                className="rounded-md border bg-background p-2 text-sm"
                value={ruleForm.calcMethod}
                onChange={(e) => setRuleForm({ ...ruleForm, calcMethod: e.target.value })}
              >
                <option value="percentage_of_sales">% of sales</option>
                <option value="percentage_of_profit">% of profit (line total − cost)</option>
                <option value="fixed_per_sale">Fixed per sale</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rule-rate">
                {ruleForm.calcMethod === "fixed_per_sale" ? "Flat amount (৳)" : "Rate (%)"}
              </Label>
              <Input
                id="rule-rate"
                type="number"
                min={0}
                value={ruleForm.rate}
                onChange={(e) => setRuleForm({ ...ruleForm, rate: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rule-user">Salesperson (empty = everyone)</Label>
              <select
                id="rule-user"
                className="rounded-md border bg-background p-2 text-sm"
                value={ruleForm.userId}
                onChange={(e) => setRuleForm({ ...ruleForm, userId: e.target.value })}
              >
                <option value="">All salespeople</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.fullName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => void createRule()}
              disabled={acting || ruleForm.name.trim() === ""}
            >
              {acting ? "Creating…" : "Create rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-medium">Entries</h2>
          {STATUS_FILTERS.map((filter) => (
            <Button
              key={filter}
              size="sm"
              variant={statusFilter === filter ? "default" : "outline"}
              onClick={() => setStatusFilter(filter)}
            >
              {filter}
            </Button>
          ))}
        </div>
        {rows === null || rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries match.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">When</th>
                  <th className="p-2 font-medium">Salesperson</th>
                  <th className="p-2 font-medium">Rule</th>
                  <th className="p-2 text-right font-medium">Amount</th>
                  <th className="p-2 font-medium">Status</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => (
                  <tr key={entry.id} className="border-t">
                    <td className="p-2 text-xs text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleDateString()}
                    </td>
                    <td className="p-2">{entry.salespersonName}</td>
                    <td className="p-2 text-xs">{entry.ruleName}</td>
                    <td className="p-2 text-right font-mono">
                      {formatCurrency(Number(entry.amount))}
                    </td>
                    <td className="p-2">
                      <Badge
                        variant={
                          entry.status === "paid"
                            ? "default"
                            : entry.status === "reversed"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {entry.status}
                      </Badge>
                    </td>
                    <td className="p-2 text-right">
                      {entry.status === "pending" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={acting}
                          onClick={() => void advance(entry, "approved")}
                        >
                          Approve
                        </Button>
                      ) : entry.status === "approved" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={acting}
                          onClick={() => void advance(entry, "payable")}
                        >
                          Mark payable
                        </Button>
                      ) : entry.status === "payable" ? (
                        <Button
                          size="sm"
                          disabled={acting}
                          onClick={() => void advance(entry, "paid")}
                        >
                          Mark paid
                        </Button>
                      ) : null}
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
