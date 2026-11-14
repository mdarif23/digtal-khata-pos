import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Plus, Target, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PermissionButton } from "@/components/common/PermissionGuard";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { getBudgetUsageApi } from "@/api/expenses.api";
import { formatCurrency } from "@/features/reports/utils/reportUtils";
import { cn } from "@/lib/utils";
import {
  useCreateExpenseBudget,
  useDeleteExpenseBudget,
  useExpenseBudgets,
  useUpdateExpenseBudget,
} from "../hooks/useExpenses";
import type { ExpenseBudgetDraft, ExpenseCategory, ExpenseBudgetUsage } from "../expense.type";

function thisMonthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function monthInputValue(month: string): string {
  return month.slice(0, 7); // YYYY-MM for <input type="month">
}

function monthFromInput(value: string): string {
  return `${value}-01`;
}

function BudgetForm({
  categories,
  initial,
  onSubmit,
  onCancel,
  saving,
  error,
}: {
  categories: ExpenseCategory[];
  initial: ExpenseBudgetDraft;
  onSubmit: (draft: ExpenseBudgetDraft) => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const [draft, setDraft] = useState<ExpenseBudgetDraft>(initial);
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <FieldGroup className="gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="budget-month">Month</FieldLabel>
            <Input
              id="budget-month"
              type="month"
              value={monthInputValue(draft.month)}
              onChange={(event) =>
                setDraft({ ...draft, month: monthFromInput(event.target.value) })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="budget-amount">Budget amount (৳)</FieldLabel>
            <Input
              id="budget-amount"
              type="number"
              min="0.01"
              step="0.01"
              value={draft.amount || ""}
              onChange={(event) =>
                setDraft({ ...draft, amount: Number(event.target.value) })
              }
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="budget-category">Category scope</FieldLabel>
            <select
              id="budget-category"
              className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={draft.categoryId === null ? "all" : String(draft.categoryId)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  categoryId:
                    event.target.value === "all"
                      ? null
                      : Number(event.target.value),
                })
              }
            >
              <option value="all">All categories</option>
              {categories.map((category) => (
                <option key={category.id} value={String(category.id)}>
                  {category.categoryName}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="budget-location">Location scope</FieldLabel>
            <select
              id="budget-location"
              className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={draft.locationId === null ? "all" : String(draft.locationId)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  locationId:
                    event.target.value === "all"
                      ? null
                      : Number(event.target.value),
                })
              }
            >
              <option value="all">All locations</option>
            </select>
          </Field>
        </div>
      </FieldGroup>
      <FieldError>{error}</FieldError>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={saving}
          onClick={() => onSubmit(draft)}
        >
          Save budget
        </Button>
      </div>
    </div>
  );
}

function BudgetsManageDialog({
  open,
  onOpenChange,
  categories,
  month,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: ExpenseCategory[];
  month: string;
}) {
  const budgetsQuery = useExpenseBudgets(month);
  const [mode, setMode] = useState<"closed" | "create" | "edit">("closed");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const createBudget = useCreateExpenseBudget();
  const updateBudget = useUpdateExpenseBudget();
  const deleteBudget = useDeleteExpenseBudget();
  const saving = createBudget.isPending || updateBudget.isPending;

  useEffect(() => {
    if (!open) {
      setMode("closed");
      setFormError(null);
    }
  }, [open]);

  async function handleSubmit(draft: ExpenseBudgetDraft) {
    if (!(draft.amount > 0)) {
      setFormError("Enter a budget amount greater than zero");
      return;
    }
    if (!/^\d{4}-\d{2}-01$/.test(draft.month)) {
      setFormError("Choose a month");
      return;
    }
    try {
      await createEntityPromiseToast({
        data: draft,
        apiCall: async (d) => {
          if (mode === "edit" && editingId) {
            await updateBudget.mutateAsync({ id: editingId, draft: d });
            return;
          }
          await createBudget.mutateAsync(d);
        },
        entityName: "Expense budget",
        displayName: formatCurrency(draft.amount),
      });
      setMode("closed");
      setFormError(null);
    } catch {
      // The promise toast surfaces the API error (e.g. duplicate scope).
    }
  }

  const rows: ExpenseBudgetUsage[] = budgetsQuery.data ?? [];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Expense budgets</DialogTitle>
            <DialogDescription>
              Monthly spending plans. Actuals update live from recorded
              expenses; budgets can cover everything or a single
              category/location.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
            {mode !== "closed" ? (
              <BudgetForm
                categories={categories}
                initial={{ categoryId: null, locationId: null, month, amount: 0 }}
                error={formError}
                saving={saving}
                onCancel={() => setMode("closed")}
                onSubmit={(draft) => void handleSubmit(draft)}
              />
            ) : (
              <PermissionButton
                type="button"
                variant="outline"
                size="sm"
                permission="expenses.edit"
                onClick={() => {
                  setMode("create");
                  setFormError(null);
                }}
              >
                <Plus />
                New budget
              </PermissionButton>
            )}

            {budgetsQuery.isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : rows.length ? (
              <ul className="space-y-2">
                {rows.map((budget) => (
                  <li
                    key={budget.id}
                    className="flex items-center justify-between gap-3 rounded-lg border p-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {budget.categoryName ?? "All categories"}
                        {budget.locationName
                          ? ` · ${budget.locationName}`
                          : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatCurrency(budget.actualAmount)} of{" "}
                        {formatCurrency(budget.amount)} ·{" "}
                        {monthInputValue(budget.month)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <PermissionButton
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        permission="expenses.edit"
                        aria-label="Edit budget"
                        onClick={() => {
                          setMode("edit");
                          setEditingId(budget.id);
                          setFormError(null);
                        }}
                      >
                        <Pencil />
                      </PermissionButton>
                      <PermissionButton
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        permission="expenses.edit"
                        aria-label="Delete budget"
                        onClick={() => setDeleteTarget(budget.id)}
                      >
                        <Trash2 className="text-destructive" />
                      </PermissionButton>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-3 text-center text-sm text-muted-foreground">
                No budgets for this month yet.
              </p>
            )}
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline">Close</Button>} />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title="Delete this budget?"
        description="The budget plan is removed. Recorded expenses are not affected."
        entityName="Budget"
        onConfirm={async () => {
          if (deleteTarget === null) return;
          await deleteBudget.mutateAsync(deleteTarget);
          setDeleteTarget(null);
        }}
      />
    </>
  );
}

/**
 * Budget progress for the analytics panel — recent months' usage fetched in
 * one server aggregate. Shows the manage dialog behind expenses.edit.
 */
export function BudgetsSection({
  categories,
  locationId,
}: {
  categories: ExpenseCategory[];
  locationId?: number | undefined;
}) {
  const [manageOpen, setManageOpen] = useState(false);
  const usageQuery = useQuery({
    queryKey: ["expenses", "budget-usage", locationId ?? "all"],
    queryFn: () => getBudgetUsageApi(3, locationId),
  });

  const rows = usageQuery.data ?? [];
  const currentMonth = thisMonthStart();
  const currentRows = rows.filter((r) => r.month === currentMonth);
  const shown = currentRows.length ? currentRows : rows.slice(0, 3);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Budgets
        </h3>
        <PermissionButton
          type="button"
          variant="outline"
          size="sm"
          permission="expenses.edit"
          onClick={() => setManageOpen(true)}
        >
          <Target />
          Manage
        </PermissionButton>
      </div>
      {usageQuery.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : shown.length ? (
        <ul className="space-y-2">
          {shown.map((budget) => {
            const utilization = Math.min(100, budget.utilizationPercent ?? 0);
            return (
              <li key={budget.id} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {budget.categoryName ?? "All categories"}
                    {budget.locationName ? ` · ${budget.locationName}` : ""}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {monthInputValue(budget.month)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "tabular-nums",
                      budget.overBudget ? "font-medium text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {formatCurrency(budget.actualAmount)} /{" "}
                    {formatCurrency(budget.amount)}
                    {budget.overBudget ? " · over" : ""}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      budget.overBudget ? "bg-destructive" : "bg-success",
                    )}
                    style={{ width: `${utilization}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No budgets set — create one to track monthly spending against a plan.
        </p>
      )}
      <BudgetsManageDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        categories={categories}
        month={currentMonth}
      />
    </div>
  );
}
