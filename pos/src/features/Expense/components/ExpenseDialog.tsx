import { zodResolver } from "@hookform/resolvers/zod";
import {
  useEffect,
  useState,
  type ReactElement,
} from "react";
import { useForm } from "react-hook-form";
import { Plus, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { expenseSchema, type ExpenseFormInput, type ExpenseFormOutput } from "../expense.schema";
import type { ExpenseCategory, ExpenseDraft, ExpenseRecord } from "../expense.type";
import { useCreateExpense, useUpdateExpense } from "../hooks/useExpenses";

function localDateValue() {
  const date = new Date();
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 10);
}

interface ExpenseDialogProps {
  categories: ExpenseCategory[];
  expense?: ExpenseRecord;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactElement;
}

function getDefaultValues(expense?: ExpenseRecord): ExpenseFormInput {
  return {
    title: expense?.title ?? "",
    expenseDate: expense?.expenseDate ?? localDateValue(),
    amount: expense?.amount ?? 0,
    categoryId:
      expense?.categoryId === null || expense?.categoryId === undefined
        ? "none"
        : String(expense.categoryId),
    paymentMethod: expense?.paymentMethod ?? "Cash",
    payee: expense?.payee ?? "",
    referenceNo: expense?.referenceNo ?? "",
    note: expense?.note ?? "",
    settlement: "full",
    initialPaymentAmount: undefined,
  };
}

export function ExpenseDialog({
  categories,
  expense,
  open: controlledOpen,
  onOpenChange,
  trigger,
}: ExpenseDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const createExpense = useCreateExpense();
  const updateExpense = useUpdateExpense();
  const saving = createExpense.isPending || updateExpense.isPending;
  const form = useForm<ExpenseFormInput, unknown, ExpenseFormOutput>({
    resolver: zodResolver(expenseSchema),
    defaultValues: getDefaultValues(expense),
  });

  useEffect(() => {
    if (open) form.reset(getDefaultValues(expense));
  }, [expense, form, open]);

  function handleOpenChange(nextOpen: boolean) {
    if (controlledOpen === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
    if (!nextOpen) {
      form.reset(getDefaultValues());
    }
  }

  async function onSubmit(data: ExpenseFormOutput) {
    const draft: ExpenseDraft = {
      title: data.title,
      expenseDate: data.expenseDate,
      amount: data.amount,
      categoryId: data.categoryId,
      paymentMethod: data.paymentMethod,
      payee: data.payee,
      referenceNo: data.referenceNo,
      note: data.note,
      settlement: expense ? "full" : data.settlement,
      initialPaymentAmount:
        data.settlement === "partial" ? data.initialPaymentAmount : undefined,
    };
    try {
      await createEntityPromiseToast({
        data: draft,
        apiCall: (d) =>
          expense
            ? updateExpense.mutateAsync({ id: expense.id, draft: d })
            : createExpense.mutateAsync(d),
        entityName: expense ? "Expense update" : "Expense",
        displayName: data.title,
      });
      handleOpenChange(false);
      form.reset();
    } catch {
      // The promise toast displays the API error and keeps the form available for correction.
    }
  }

  const errors = form.formState.errors;
  const watchSettlement = form.watch("settlement");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger ? (
        <DialogTrigger render={trigger} />
      ) : (
        <DialogTrigger
          render={
            <Button>
              <Plus />
              Add expense
            </Button>
          }
        />
      )}
      <DialogContent className="sm:max-w-xl">
        <form
          id="expense-form"
          onSubmit={form.handleSubmit(onSubmit)}
          className="space-y-5"
        >
          <DialogHeader>
            <DialogTitle>{expense ? "Edit expense" : "Record an expense"}</DialogTitle>
            <DialogDescription>
              {expense
                ? "Update this expense record and save your changes."
                : "Add the expense details to keep your business records up to date."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field data-invalid={Boolean(errors.title)}>
              <FieldLabel htmlFor="expense-title">Expense title</FieldLabel>
              <Input
                id="expense-title"
                placeholder="e.g. Office supplies"
                aria-invalid={Boolean(errors.title)}
                {...form.register("title")}
              />
              <FieldError>{errors.title?.message}</FieldError>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.amount)}>
                <FieldLabel htmlFor="expense-amount">Amount (৳)</FieldLabel>
                <Input
                  id="expense-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  aria-invalid={Boolean(errors.amount)}
                  {...form.register("amount", { valueAsNumber: true })}
                />
                <FieldError>{errors.amount?.message}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errors.expenseDate)}>
                <FieldLabel htmlFor="expense-date">Expense date</FieldLabel>
                <Input
                  id="expense-date"
                  type="date"
                  aria-invalid={Boolean(errors.expenseDate)}
                  {...form.register("expenseDate")}
                />
                <FieldError>{errors.expenseDate?.message}</FieldError>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.categoryId)}>
                <FieldLabel htmlFor="expense-category">Category</FieldLabel>
                <select
                  id="expense-category"
                  className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  aria-invalid={Boolean(errors.categoryId)}
                  {...form.register("categoryId")}
                >
                  <option value="none">Uncategorized</option>
                  {categories.map((category) => (
                    <option key={category.id} value={String(category.id)}>
                      {category.categoryName}
                    </option>
                  ))}
                </select>
                <FieldError>{errors.categoryId?.message}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errors.paymentMethod)}>
                <FieldLabel htmlFor="expense-payment">Payment method</FieldLabel>
                <select
                  id="expense-payment"
                  className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  aria-invalid={Boolean(errors.paymentMethod)}
                  {...form.register("paymentMethod")}
                >
                  <option value="Cash">Cash</option>
                  <option value="Mobile">Mobile</option>
                  <option value="Card">Card</option>
                </select>
                <FieldError>{errors.paymentMethod?.message}</FieldError>
              </Field>
            </div>
            <Field data-invalid={Boolean(errors.payee)}>
              <FieldLabel htmlFor="expense-payee">Payee</FieldLabel>
              <Input
                id="expense-payee"
                placeholder="Optional vendor or person paid"
                aria-invalid={Boolean(errors.payee)}
                {...form.register("payee")}
              />
              <FieldError>{errors.payee?.message}</FieldError>
            </Field>
            {!expense ? (
              <Field data-invalid={Boolean(errors.settlement)}>
                <FieldLabel>Settlement</FieldLabel>
                <div className="grid gap-2 sm:grid-cols-3">
                  {(
                    [
                      ["full", "Paid in full", "Settles the whole amount now"],
                      ["partial", "Partial", "Record a down payment now"],
                      ["unpaid", "Unpaid", "Keep the full amount as due"],
                    ] as const
                  ).map(([value, label, hint]) => (
                    <label
                      key={value}
                      className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm has-checked:border-primary has-checked:bg-primary/5"
                    >
                      <input
                        type="radio"
                        value={value}
                        className="mt-0.5"
                        {...form.register("settlement")}
                      />
                      <span>
                        <span className="block font-medium">{label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {hint}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <FieldError>{errors.settlement?.message}</FieldError>
              </Field>
            ) : null}
            {!expense && watchSettlement === "partial" ? (
              <Field data-invalid={Boolean(errors.initialPaymentAmount)}>
                <FieldLabel htmlFor="expense-initial-payment">
                  Amount settled now (৳)
                </FieldLabel>
                <Input
                  id="expense-initial-payment"
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  aria-invalid={Boolean(errors.initialPaymentAmount)}
                  {...form.register("initialPaymentAmount", {
                    valueAsNumber: true,
                  })}
                />
                <FieldError>{errors.initialPaymentAmount?.message}</FieldError>
              </Field>
            ) : null}
            <Field data-invalid={Boolean(errors.referenceNo)}>
              <FieldLabel htmlFor="expense-reference">Reference number</FieldLabel>
              <Input
                id="expense-reference"
                placeholder="Optional receipt or transaction ID"
                aria-invalid={Boolean(errors.referenceNo)}
                {...form.register("referenceNo")}
              />
              <FieldError>{errors.referenceNo?.message}</FieldError>
            </Field>
            <Field data-invalid={Boolean(errors.note)}>
              <FieldLabel htmlFor="expense-note">Note</FieldLabel>
              <Textarea
                id="expense-note"
                placeholder="Add any useful context"
                rows={3}
                aria-invalid={Boolean(errors.note)}
                {...form.register("note")}
              />
              <FieldError>{errors.note?.message}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline" disabled={saving}>
                  Cancel
                </Button>
              }
            />
            <Button disabled={saving} type="submit">
              {saving ? (
                <>
                  <Spinner />
                  Saving
                </>
              ) : (
                <>
                  <Save />
                  {expense ? "Update expense" : "Save expense"}
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
