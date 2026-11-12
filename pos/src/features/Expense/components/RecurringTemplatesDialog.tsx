import { useEffect, useState, type ReactElement } from "react";
import { getErrorMessage } from "@/utils/getErrorMessage";
import {
  Archive,
  CalendarClock,
  Pencil,
  Play,
  Plus,
  Save,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { PermissionButton } from "@/components/common/PermissionGuard";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { formatCurrency, formatDate } from "@/features/reports/utils/reportUtils";
import {
  useArchiveExpenseTemplate,
  useCreateExpenseTemplate,
  useExpenseTemplates,
  useGenerateExpenseTemplate,
  useUpdateExpenseTemplate,
} from "../hooks/useExpenses";
import type {
  ExpenseCategory,
  ExpenseFrequency,
  ExpenseTemplate,
  ExpenseTemplateDraft,
} from "../expense.type";

const FREQUENCY_LABELS: Record<ExpenseFrequency, string> = {
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
};

function localDateValue() {
  const date = new Date();
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 10);
}

function toDraft(template: ExpenseTemplate | null): ExpenseTemplateDraft {
  return {
    title: template?.title ?? "",
    amount: template?.amount ?? 0,
    categoryId: template?.categoryId ?? null,
    paymentMethod: template?.paymentMethod ?? "Cash",
    payee: template?.payee ?? "",
    note: template?.note ?? "",
    locationId: template?.locationId ?? null,
    frequency: template?.frequency ?? "monthly",
    startDate: template?.startDate ?? localDateValue(),
    endDate: template?.endDate ?? "",
  };
}

interface RecurringTemplatesDialogProps {
  categories: ExpenseCategory[];
  trigger?: ReactElement;
}

export function RecurringTemplatesDialog({
  categories,
  trigger,
}: RecurringTemplatesDialogProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"closed" | "create" | "edit">("closed");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<ExpenseTemplateDraft>(toDraft(null));
  const [error, setError] = useState<string | null>(null);

  const templatesQuery = useExpenseTemplates(true);
  const createTemplate = useCreateExpenseTemplate();
  const updateTemplate = useUpdateExpenseTemplate();
  const archiveTemplate = useArchiveExpenseTemplate();
  const generateTemplate = useGenerateExpenseTemplate();
  const saving =
    createTemplate.isPending || updateTemplate.isPending;

  useEffect(() => {
    if (!open) {
      setMode("closed");
      setEditingId(null);
      setDraft(toDraft(null));
      setError(null);
    }
  }, [open]);

  function validate(value: ExpenseTemplateDraft): string | null {
    if (!value.title.trim()) return "Enter a template title";
    if (!(value.amount > 0)) return "Enter an amount greater than zero";
    if (!value.startDate) return "Choose a start date";
    if (value.endDate && value.endDate < value.startDate) {
      return "The end date must be on or after the start date";
    }
    return null;
  }

  async function handleSave() {
    const validationError = validate(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    const payload: ExpenseTemplateDraft = {
      ...draft,
      title: draft.title.trim(),
      payee: draft.payee?.trim() || null,
      note: draft.note?.trim() || null,
      endDate: draft.endDate || null,
    };
    try {
      await createEntityPromiseToast({
        data: payload,
        apiCall: (p) =>
          mode === "edit" && editingId
            ? updateTemplate.mutateAsync({ id: editingId, draft: p, isActive: true })
            : createTemplate.mutateAsync(p),
        entityName: "Recurring template",
        displayName: payload.title,
      });
      setMode("closed");
    } catch {
      // The promise toast surfaces the API error.
    }
  }

  async function handleGenerate(template: ExpenseTemplate) {
    try {
      const generated = await generateTemplate.mutateAsync(template.id);
      toast.add({
        title:
          generated > 0
            ? `${String(generated)} expense(s) generated from “${template.title}”`
            : "Nothing due yet for this template",
        type: generated > 0 ? "success" : "info",
      });
    } catch (err) {
      toast.add({
        title:
          getErrorMessage(err),
        type: "error",
      });
    }
  }

  async function handleArchive(template: ExpenseTemplate) {
    try {
      await toast.promise(archiveTemplate.mutateAsync(template.id), {
        loading: "Archiving template…",
        success: `${template.title} archived — future generation stopped`,
        error: (err: { response?: { data?: { message?: string } }; message?: string }) =>
          err?.response?.data?.message ?? err?.message ?? "Could not archive template",
      });
    } catch {
      // The promise toast displays the API error.
    }
  }

  const templates: ExpenseTemplate[] = templatesQuery.data ?? [];
  const active = templates.filter((t) => t.isActive);
  const archived = templates.filter((t) => !t.isActive);

  function renderForm() {
    return (
      <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
        <FieldGroup className="gap-3">
          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="template-title">Template title</FieldLabel>
            <Input
              id="template-title"
              maxLength={255}
              placeholder="e.g. Monthly office rent"
              value={draft.title}
              aria-invalid={Boolean(error)}
              onChange={(event) => {
                setDraft({ ...draft, title: event.target.value });
                if (error) setError(null);
              }}
            />
            <FieldError>{error}</FieldError>
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="template-amount">Amount (৳)</FieldLabel>
              <Input
                id="template-amount"
                type="number"
                min="0.01"
                step="0.01"
                value={draft.amount || ""}
                onChange={(event) =>
                  setDraft({ ...draft, amount: Number(event.target.value) })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="template-frequency">Frequency</FieldLabel>
              <select
                id="template-frequency"
                className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={draft.frequency}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    frequency: event.target.value as ExpenseFrequency,
                  })
                }
              >
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
                <option value="yearly">Every year</option>
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="template-method">Payment method</FieldLabel>
              <select
                id="template-method"
                className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={draft.paymentMethod}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    paymentMethod: event.target
                      .value as ExpenseTemplateDraft["paymentMethod"],
                  })
                }
              >
                <option value="Cash">Cash</option>
                <option value="Mobile">Mobile</option>
                <option value="Card">Card</option>
              </select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="template-category">Category</FieldLabel>
              <select
                id="template-category"
                className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={draft.categoryId === null ? "none" : String(draft.categoryId)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    categoryId:
                      event.target.value === "none"
                        ? null
                        : Number(event.target.value),
                  })
                }
              >
                <option value="none">Uncategorized</option>
                {categories.map((category) => (
                  <option key={category.id} value={String(category.id)}>
                    {category.categoryName}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="template-payee">Payee (optional)</FieldLabel>
              <Input
                id="template-payee"
                maxLength={150}
                value={draft.payee ?? ""}
                onChange={(event) =>
                  setDraft({ ...draft, payee: event.target.value })
                }
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="template-start">First expense date</FieldLabel>
              <Input
                id="template-start"
                type="date"
                value={draft.startDate}
                onChange={(event) =>
                  setDraft({ ...draft, startDate: event.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="template-end">End date (optional)</FieldLabel>
              <Input
                id="template-end"
                type="date"
                value={draft.endDate ?? ""}
                onChange={(event) =>
                  setDraft({ ...draft, endDate: event.target.value })
                }
              />
            </Field>
          </div>
        </FieldGroup>
        <p className="text-xs text-muted-foreground">
          Generated expenses are always recorded as unpaid — settle them from
          the expense drawer when the money actually moves.
        </p>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMode("closed")}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => void handleSave()}>
            {saving ? (
              <>
                <Spinner />
                Saving
              </>
            ) : (
              <>
                <Save />
                {mode === "edit" ? "Save changes" : "Create template"}
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  function renderRow(template: ExpenseTemplate, isArchived: boolean) {
    return (
      <li
        key={template.id}
        className={
          isArchived
            ? "flex items-center justify-between gap-3 rounded-lg border border-dashed p-2.5 opacity-75"
            : "flex items-center justify-between gap-3 rounded-lg border p-2.5"
        }
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium">{template.title}</p>
            {isArchived ? <Badge variant="secondary">Archived</Badge> : null}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatCurrency(Number(template.amount))} ·{" "}
            {FREQUENCY_LABELS[template.frequency]} ·{" "}
            {template.categoryName ?? "Uncategorized"}
            {template.payee ? ` · ${template.payee}` : ""}
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <CalendarClock className="size-3" />
            {isArchived
              ? "Archived"
              : `Next due ${formatDate(template.nextGenerationDate)}${
                  template.lastGeneratedDate
                    ? ` · last generated ${formatDate(template.lastGeneratedDate)}`
                    : ""
                }`}
          </p>
        </div>
        {!isArchived ? (
          <div className="flex shrink-0 items-center gap-1">
            <PermissionButton
              type="button"
              variant="ghost"
              size="sm"
              permission="expenses.create"
              disabled={generateTemplate.isPending}
              onClick={() => void handleGenerate(template)}
            >
              <Play />
              Generate
            </PermissionButton>
            <PermissionButton
              type="button"
              variant="ghost"
              size="icon-sm"
              permission="expenses.edit"
              aria-label={`Edit ${template.title}`}
              onClick={() => {
                setMode("edit");
                setEditingId(template.id);
                setDraft(toDraft(template));
                setError(null);
              }}
            >
              <Pencil />
            </PermissionButton>
            <PermissionButton
              type="button"
              variant="ghost"
              size="icon-sm"
              permission="expenses.edit"
              aria-label={`Archive ${template.title}`}
              onClick={() => void handleArchive(template)}
            >
              <Archive className="text-muted-foreground" />
            </PermissionButton>
          </div>
        ) : null}
      </li>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          trigger ?? (
            <Button variant="outline">
              <CalendarClock />
              Recurring
            </Button>
          )
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Recurring expenses</DialogTitle>
          <DialogDescription>
            Templates generate their expenses automatically on schedule —
            always as unpaid dues you settle later.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[26rem] space-y-4 overflow-y-auto pr-1">
          {mode !== "closed" ? (
            renderForm()
          ) : (
            <PermissionButton
              type="button"
              variant="outline"
              size="sm"
              permission="expenses.create"
              onClick={() => {
                setMode("create");
                setDraft(toDraft(null));
                setError(null);
              }}
            >
              <Plus />
              New template
            </PermissionButton>
          )}

          {templatesQuery.isLoading ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Loading templates…
            </p>
          ) : templatesQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Could not load templates.
            </p>
          ) : (
            <>
              <ul className="space-y-2">
                {active.map((template) => renderRow(template, false))}
                {!active.length ? (
                  <li className="py-3 text-center text-sm text-muted-foreground">
                    No active templates yet.
                  </li>
                ) : null}
              </ul>
              {archived.length ? (
                <div>
                  <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Archived
                  </p>
                  <ul className="space-y-2">
                    {archived.map((template) => renderRow(template, true))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline">Close</Button>} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
