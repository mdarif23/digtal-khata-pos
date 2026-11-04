import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import {
  Archive,
  ArchiveRestore,
  FolderPlus,
  Pencil,
  Save,
  Tags,
  X,
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
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { toast } from "@/components/ui/toast";
import { useExpenseCategories } from "../hooks/useExpenses";
import {
  useArchiveExpenseCategory,
  useCreateExpenseCategory,
  useRestoreExpenseCategory,
  useUpdateExpenseCategory,
  type CategoryWritePayload,
} from "../hooks/useExpenses";
import type { ExpenseCategory } from "../expense.type";

interface DraftState {
  categoryName: string;
  description: string;
  color: string;
}

const EMPTY_DRAFT: DraftState = { categoryName: "", description: "", color: "#2563eb" };

function toDraft(category: ExpenseCategory | null): DraftState {
  return {
    categoryName: category?.categoryName ?? "",
    description: category?.description ?? "",
    color: category?.color ?? "",
  };
}

function CategoryForm({
  value,
  onChange,
  error,
  onSave,
  onCancel,
  saving,
  submitLabel,
}: {
  value: DraftState;
  onChange: (draft: DraftState) => void;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  submitLabel: string;
}) {
  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSave();
      }}
      className="space-y-3 rounded-lg border bg-muted/30 p-3"
    >
      <FieldGroup className="gap-3">
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="category-name">Category name</FieldLabel>
          <Input
            id="category-name"
            autoFocus
            maxLength={100}
            placeholder="e.g. Utilities"
            value={value.categoryName}
            aria-invalid={Boolean(error)}
            onChange={(event) =>
              onChange({ ...value, categoryName: event.target.value })
            }
          />
          <FieldError>{error}</FieldError>
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field>
            <FieldLabel htmlFor="category-description">
              Description (optional)
            </FieldLabel>
            <Input
              id="category-description"
              maxLength={255}
              placeholder="What belongs in this category?"
              value={value.description}
              onChange={(event) =>
                onChange({ ...value, description: event.target.value })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="category-color">Color</FieldLabel>
            <div className="flex items-center gap-2">
              <input
                id="category-color"
                type="color"
                aria-label="Category color"
                className="size-9 cursor-pointer rounded-md border border-input bg-background p-1"
                value={/^#[0-9a-fA-F]{6}$/.test(value.color) ? value.color : "#2563eb"}
                onChange={(event) =>
                  onChange({ ...value, color: event.target.value })
                }
              />
              {value.color ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange({ ...value, color: "" })}
                >
                  <X />
                  Clear
                </Button>
              ) : null}
            </div>
          </Field>
        </div>
      </FieldGroup>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? (
            <>
              <Spinner />
              Saving
            </>
          ) : (
            <>
              <Save />
              {submitLabel}
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

export function ExpenseCategoriesDialog({
  trigger,
}: {
  trigger?: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"closed" | "create" | "edit">("closed");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ExpenseCategory | null>(
    null,
  );

  const categoriesQuery = useExpenseCategories(true);
  const createCategory = useCreateExpenseCategory();
  const updateCategory = useUpdateExpenseCategory();
  const archiveCategory = useArchiveExpenseCategory();
  const restoreCategory = useRestoreExpenseCategory();
  const saving =
    createCategory.isPending ||
    updateCategory.isPending ||
    archiveCategory.isPending ||
    restoreCategory.isPending;

  useEffect(() => {
    if (!open) {
      setMode("closed");
      setEditingId(null);
      setDraft(EMPTY_DRAFT);
      setFormError(null);
    }
  }, [open]);

  function startCreate() {
    setMode("create");
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFormError(null);
  }

  function startEdit(category: ExpenseCategory) {
    setMode("edit");
    setEditingId(category.id);
    setDraft(toDraft(category));
    setFormError(null);
  }

  function validate(draftValue: DraftState): string | null {
    const name = draftValue.categoryName.trim();
    if (!name) return "Enter a category name";
    if (name.length > 100) return "Category names can be up to 100 characters";
    return null;
  }

  async function handleSave() {
    const error = validate(draft);
    if (error) {
      setFormError(error);
      return;
    }
    const payload: CategoryWritePayload = {
      categoryName: draft.categoryName.trim(),
      description: draft.description.trim() || null,
      color: /^#[0-9a-fA-F]{6}$/.test(draft.color) ? draft.color : null,
      icon: null,
    };
    try {
      await createEntityPromiseToast({
        data: payload,
        apiCall: (p) =>
          mode === "edit" && editingId
            ? updateCategory.mutateAsync({ id: editingId, payload: p })
            : createCategory.mutateAsync(p),
        entityName: "Expense category",
        displayName: payload.categoryName,
      });
      setMode("closed");
      setDraft(EMPTY_DRAFT);
    } catch {
      // The promise toast surfaces the API error (e.g. duplicate name).
    }
  }

  async function handleArchive() {
    if (!archiveTarget) return;
    try {
      await toast.promise(
        archiveCategory.mutateAsync(archiveTarget.id),
        {
          loading: "Archiving category…",
          success: `${archiveTarget.categoryName} archived — past expenses keep their label`,
          error: (err: { response?: { data?: { message?: string } }; message?: string }) =>
            err?.response?.data?.message ?? err?.message ?? "Could not archive category",
        },
      );
    } catch {
      // The promise toast displays the API error.
    } finally {
      setArchiveTarget(null);
    }
  }

  async function handleRestore(category: ExpenseCategory) {
    try {
      await toast.promise(restoreCategory.mutateAsync(category.id), {
        loading: "Restoring category…",
        success: `${category.categoryName} restored`,
        error: (err: { response?: { data?: { message?: string } }; message?: string }) =>
          err?.response?.data?.message ?? err?.message ?? "Could not restore category",
      });
    } catch {
      // The promise toast displays the API error.
    }
  }

  const categories = categoriesQuery.data ?? [];
  const active = categories.filter((category) => !category.archivedAt);
  const archived = categories.filter((category) => category.archivedAt);

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={
            trigger ?? (
              <Button variant="outline">
                <Tags />
                Categories
              </Button>
            )
          }
        />
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Expense categories</DialogTitle>
            <DialogDescription>
              Organize expenses into categories. Archived categories stay on
              past expenses — they just stop being offered for new ones.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[26rem] space-y-4 overflow-y-auto pr-1">
            {mode === "create" ? (
              <CategoryForm
                value={draft}
                onChange={(next) => {
                  setDraft(next);
                  if (formError) setFormError(null);
                }}
                error={formError}
                onSave={() => void handleSave()}
                onCancel={() => setMode("closed")}
                saving={saving}
                submitLabel="Create category"
              />
            ) : (
              <PermissionButton
                type="button"
                variant="outline"
                size="sm"
                permission="expenses.edit"
                onClick={startCreate}
              >
                <FolderPlus />
                Add category
              </PermissionButton>
            )}

            {categoriesQuery.isLoading ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Loading categories…
              </p>
            ) : categoriesQuery.isError ? (
              <p role="alert" className="text-sm text-destructive">
                Could not load categories.
              </p>
            ) : (
              <>
                <ul className="space-y-2">
                  {active.map((category) =>
                    mode === "edit" && editingId === category.id ? (
                      <li key={category.id}>
                        <CategoryForm
                          value={draft}
                          onChange={(next) => {
                            setDraft(next);
                            if (formError) setFormError(null);
                          }}
                          error={formError}
                          onSave={() => void handleSave()}
                          onCancel={() => setMode("closed")}
                          saving={saving}
                          submitLabel="Save changes"
                        />
                      </li>
                    ) : (
                      <li
                        key={category.id}
                        className="flex items-center justify-between gap-3 rounded-lg border p-2.5"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            aria-hidden="true"
                            className="size-3 shrink-0 rounded-full"
                            style={
                              category.color
                                ? { backgroundColor: category.color }
                                : undefined
                            }
                          />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {category.categoryName}
                            </p>
                            {category.description ? (
                              <p className="truncate text-xs text-muted-foreground">
                                {category.description}
                              </p>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <PermissionButton
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            permission="expenses.edit"
                            aria-label={`Edit ${category.categoryName}`}
                            onClick={() => startEdit(category)}
                          >
                            <Pencil />
                          </PermissionButton>
                          <PermissionButton
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            permission="expenses.edit"
                            aria-label={`Archive ${category.categoryName}`}
                            onClick={() => setArchiveTarget(category)}
                          >
                            <Archive className="text-muted-foreground" />
                          </PermissionButton>
                        </div>
                      </li>
                    ),
                  )}
                  {!active.length ? (
                    <li className="py-3 text-center text-sm text-muted-foreground">
                      No active categories yet.
                    </li>
                  ) : null}
                </ul>

                {archived.length ? (
                  <div>
                    <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      Archived
                    </p>
                    <ul className="space-y-2">
                      {archived.map((category) => (
                        <li
                          key={category.id}
                          className="flex items-center justify-between gap-3 rounded-lg border border-dashed p-2.5 opacity-75"
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <span
                              aria-hidden="true"
                              className="size-3 shrink-0 rounded-full border"
                              style={
                                category.color
                                  ? { backgroundColor: category.color }
                                  : undefined
                              }
                            />
                            <p className="truncate text-sm">
                              {category.categoryName}
                            </p>
                            <Badge variant="secondary">Archived</Badge>
                          </div>
                          <PermissionButton
                            type="button"
                            variant="ghost"
                            size="sm"
                            permission="expenses.edit"
                            onClick={() => void handleRestore(category)}
                          >
                            <ArchiveRestore />
                            Restore
                          </PermissionButton>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </div>

          <DialogFooter>
            <DialogClose
              render={<Button variant="outline">Close</Button>}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={archiveTarget !== null} onOpenChange={(next) => {
        if (!next) setArchiveTarget(null);
      }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Archive “{archiveTarget?.categoryName ?? ""}”?</DialogTitle>
            <DialogDescription>
              Past expenses keep this category. You can restore it anytime,
              and the name becomes available for a new category.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline" disabled={saving}>
                  Cancel
                </Button>
              }
            />
            <Button type="button" variant="destructive" disabled={saving} onClick={() => void handleArchive()}>
              {saving ? (
                <>
                  <Spinner />
                  Archiving
                </>
              ) : (
                <>
                  <Archive />
                  Archive category
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
