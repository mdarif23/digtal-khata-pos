import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { Spinner } from "@/components/ui/spinner";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import {
  useCreateLandedCost,
  useLandedCostContext,
  useLandedCostDocument,
  useLandedCostPreview,
  usePostLandedCost,
  useUpdateLandedCost,
} from "../hooks/useLandedCost";
import type {
  LandedCostExpenseInput,
  LandedCostExpenseType,
  LandedCostMethod,
  PreviewInput,
} from "../landedCost.api";
import { AllocationPreviewTable } from "../components/AllocationPreviewTable";
import { LandedCostSummary } from "../components/LandedCostSummary";
import { LandedCostHistory } from "../components/LandedCostHistory";

const EXPENSE_TYPES: LandedCostExpenseType[] = [
  "shipping",
  "loading",
  "customs",
  "transportation",
  "insurance",
  "handling",
  "other",
];

const SETTLEMENT_OPTIONS = [
  { value: "unpaid", label: "Unpaid (accrue on posting)" },
  { value: "expense_payment", label: "Recorded expense payment" },
  { value: "supplier_payable", label: "Supplier payable" },
  { value: "cash", label: "Cash" },
] as const;

interface ExpenseRow {
  key: number;
  expenseType: LandedCostExpenseType;
  amount: string;
  taxAmount: string;
  taxTreatment: "none" | "recoverable" | "non_recoverable";
  isCapitalizable: boolean;
  settlementType: "unpaid" | "expense_payment" | "supplier_payable" | "cash";
  settlementReferenceId: string;
  vendorId: string;
}

let expenseKey = 0;
const newExpenseRow = (): ExpenseRow => ({
  key: (expenseKey += 1),
  expenseType: "shipping",
  amount: "",
  taxAmount: "0",
  taxTreatment: "none",
  isCapitalizable: true,
  settlementType: "unpaid",
  settlementReferenceId: "",
  vendorId: "",
});

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-36 items-center justify-center rounded-xl border border-dashed border-slate-200 px-4 text-center text-sm text-slate-500">
      {children}
    </div>
  );
}

const formatCurrency = (value: number) =>
  `৳${value.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function LandedCostPage() {
  const { purchaseId: rawPurchaseId } = useParams();
  const purchaseId = Number(rawPurchaseId);
  const contextQuery = useLandedCostContext(purchaseId);

  if (contextQuery.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-slate-500">
        <Spinner className="mr-2 size-4" /> Loading landed costs…
      </div>
    );
  }

  if (contextQuery.isError || !contextQuery.data) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <EmptyState>
          {contextQuery.error?.message ?? "This purchase has no landed-cost context."}
        </EmptyState>
        <div className="mt-4 text-center">
          <Button variant="outline" render={<Link to="/purchases-list" />}>
            <ArrowLeft /> Back to purchases
          </Button>
        </div>
      </div>
    );
  }

  return <LandedCostEditor purchaseId={purchaseId} />;
}

function LandedCostEditor({ purchaseId }: { purchaseId: number }) {
  const context = useLandedCostContext(purchaseId).data!;
  const documentId = context.existingDocumentId;
  const documentQuery = useLandedCostDocument(documentId);
  const detail = documentId ? documentQuery.data : undefined;
  const status = context.existingStatus;

  const [method, setMethod] = useState<LandedCostMethod>("quantity");
  const [expenses, setExpenses] = useState<ExpenseRow[]>([newExpenseRow()]);
  const [manualLines, setManualLines] = useState<Record<number, string>>({});
  const [confirmingPost, setConfirmingPost] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Prefill once the draft document's expenses arrive.
  if (detail && !initialized && detail.document.status === "draft") {
    setInitialized(true);
    setMethod(detail.document.allocationMethod);
    setExpenses(
      detail.expenses.map((expense) => ({
        key: (expenseKey += 1),
        expenseType: expense.expenseType,
        amount: String(expense.amount),
        taxAmount: String(expense.taxAmount ?? 0),
        taxTreatment: expense.taxTreatment ?? "none",
        isCapitalizable: expense.isCapitalizable ?? true,
        settlementType: expense.settlementType ?? "unpaid",
        settlementReferenceId: expense.settlementReferenceId
          ? String(expense.settlementReferenceId)
          : "",
        vendorId: "",
      })),
    );
  }

  const parsedExpenses: LandedCostExpenseInput[] = useMemo(
    () =>
      expenses
        .filter((row) => Number(row.amount) > 0)
        .map((row) => ({
          expenseType: row.expenseType,
          amount: Number(row.amount),
          taxAmount: Number(row.taxAmount) || 0,
          taxTreatment: row.taxTreatment,
          isCapitalizable: row.isCapitalizable,
          settlementType: row.settlementType,
          ...(row.settlementType === "expense_payment" &&
          Number(row.settlementReferenceId) > 0
            ? { settlementReferenceId: Number(row.settlementReferenceId) }
            : {}),
          ...(row.settlementType === "supplier_payable" &&
          Number(row.vendorId) > 0
            ? { vendorId: Number(row.vendorId) }
            : {}),
        })),
    [expenses],
  );

  const previewInput: PreviewInput | null = useMemo(() => {
    if (parsedExpenses.length === 0) return null;
    const manualAllocations =
      method === "manual"
        ? context.lines
            // Only received lines take manual amounts — ordered-but-
            // unreceived lines hold their share as pending allocation
            // (backend-enforced).
            .filter((line) => line.batches.length > 0)
            .map((line) => ({
              purchaseItemId: line.purchaseItemId,
              amount: Number(manualLines[line.purchaseItemId] ?? 0),
            }))
        : undefined;
    return {
      method,
      expenses: parsedExpenses,
      ...(manualAllocations ? { manualAllocations } : {}),
    };
  }, [method, parsedExpenses, context.lines, manualLines]);

  const previewQuery = useLandedCostPreview(purchaseId, previewInput);
  const preview = previewQuery.data;
  type PreviewErrorBody = { issues?: { message: string }[] };
  const previewErrorBody = (
    previewQuery.error as (Error & { body?: PreviewErrorBody }) | null
  )?.body;
  const previewIssues: string[] = previewErrorBody?.issues
    ? previewErrorBody.issues.map((issue) => issue.message)
    : previewQuery.error
      ? [previewQuery.error.message]
      : [];

  const lineContext = useMemo(
    () =>
      new Map(
        context.lines.map((line) => [
          line.purchaseItemId,
          {
            productName: line.productName,
            // Backend context already ships the full 'Product (Options)' label.
            variantName: line.variantName || line.productName,
            sku: line.sku,
            unitCost: line.unitCost,
          },
        ])),
    [context.lines],
  );

  const createMutation = useCreateLandedCost(purchaseId);
  const updateMutation = useUpdateLandedCost(documentId ?? 0);
  const postMutation = usePostLandedCost();
  const saving = createMutation.isPending || updateMutation.isPending;

  const saveDraft = async () => {
    if (!previewInput) return;
    if (documentId && status === "draft") {
      await createEntityPromiseToast({
        data: documentId,
        apiCall: () => updateMutation.mutateAsync(previewInput),
        entityName: "Landed cost draft",
      });
      return;
    }
    const created = await createEntityPromiseToast({
      data: purchaseId,
      apiCall: () => createMutation.mutateAsync(previewInput),
      entityName: "Landed cost draft",
    });
    if (created?.id) {
      window.location.assign(`/purchases/landed-cost/${purchaseId}`);
    }
  };

  const post = async () => {
    if (!documentId) return;
    await createEntityPromiseToast({
      data: documentId,
      apiCall: () => postMutation.mutateAsync(documentId),
      entityName: "Landed cost posting",
      getSuccessMessage: (result) =>
        `Posted — ${formatCurrency(result?.totalAllocated ?? 0)} allocated to inventory.`,
    });
    setConfirmingPost(false);
  };

  const lineContextByName = context.lines;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            to="/purchases-list"
            className="text-sm font-semibold text-emerald-700 hover:text-emerald-900"
          >
            ← Purchases
          </Link>
          <h1 className="mt-1 text-xl font-bold text-slate-900">
            Landed cost — {context.purchase.purchaseOrderNumber}
          </h1>
          <p className="text-sm text-slate-500">
            One combined document per purchase. The original purchase cost is
            never modified; landed costs ride on inventory batches.
          </p>
        </div>
        {status ? (
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
            {status}
          </span>
        ) : null}
      </div>

      {status && status !== "draft" && detail ? (
        <LandedCostHistory detail={detail} />
      ) : (
        <div className="space-y-6">
          {/* Allocation method */}
          <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm shadow-slate-950/[0.02]">
            <Label className="text-sm font-semibold text-slate-700">
              Allocation method
            </Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {(["quantity", "value", "weight", "manual"] as LandedCostMethod[]).map(
                (option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setMethod(option)}
                    className={`rounded-full border px-4 py-1.5 text-sm font-medium capitalize transition ${
                      method === option
                        ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                        : "border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {option}
                  </button>
                ),
              )}
            </div>
            {method === "weight" && (
              <p className="mt-2 text-xs text-slate-500">
                Weight allocation uses variant weights (falling back to the
                product shipping weight). Missing weights are rejected.
              </p>
            )}
          </div>

          {/* Expenses */}
          <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm shadow-slate-950/[0.02]">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold text-slate-700">
                Additional costs
              </Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                nativeButton={false}
                render={
                  <button
                    onClick={() => setExpenses((rows) => [...rows, newExpenseRow()])}
                  />
                }
              >
                <Plus /> Add expense
              </Button>
            </div>

            <div className="mt-3 space-y-3">
              {expenses.map((row, index) => (
                <div
                  key={row.key}
                  className="grid gap-2 rounded-xl border border-slate-100 p-3 sm:grid-cols-12"
                >
                  <div className="sm:col-span-2">
                    <Label className="text-xs text-slate-500">Type</Label>
                    <Select
                      items={EXPENSE_TYPES.map((type) => ({
                        value: type,
                        label: type,
                      }))}
                      value={row.expenseType}
                      onValueChange={(value) =>
                        setExpenses((rows) =>
                          rows.map((r, i) =>
                            i === index
                              ? { ...r, expenseType: value as LandedCostExpenseType }
                              : r,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EXPENSE_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-xs text-slate-500">Amount (৳)</Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      className="mt-1"
                      aria-label={`Expense ${index + 1} amount`}
                      value={row.amount}
                      onChange={(event) =>
                        setExpenses((rows) =>
                          rows.map((r, i) =>
                            i === index ? { ...r, amount: event.target.value } : r,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-xs text-slate-500">Tax (৳)</Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      className="mt-1"
                      value={row.taxAmount}
                      onChange={(event) =>
                        setExpenses((rows) =>
                          rows.map((r, i) =>
                            i === index ? { ...r, taxAmount: event.target.value } : r,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-xs text-slate-500">Tax treatment</Label>
                    <Select
                      items={[
                        { value: "none", label: "None" },
                        { value: "recoverable", label: "Recoverable" },
                        { value: "non_recoverable", label: "Non-recoverable" },
                      ]}
                      value={row.taxTreatment}
                      onValueChange={(value) =>
                        setExpenses((rows) =>
                          rows.map((r, i) =>
                            i === index
                              ? {
                                  ...r,
                                  taxTreatment: value as ExpenseRow["taxTreatment"],
                                }
                              : r,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="recoverable">Recoverable</SelectItem>
                        <SelectItem value="non_recoverable">Non-recoverable</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="sm:col-span-3">
                    <Label className="text-xs text-slate-500">Settlement</Label>
                    <Select
                      items={SETTLEMENT_OPTIONS.map((option) => ({
                        value: option.value,
                        label: option.label,
                      }))}
                      value={row.settlementType}
                      onValueChange={(value) =>
                        setExpenses((rows) =>
                          rows.map((r, i) =>
                            i === index
                              ? {
                                  ...r,
                                  settlementType: value as ExpenseRow["settlementType"],
                                }
                              : r,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SETTLEMENT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {row.settlementType === "expense_payment" && (
                      <Input
                        placeholder="Settled expense #"
                        className="mt-1"
                        value={row.settlementReferenceId}
                        onChange={(event) =>
                          setExpenses((rows) =>
                            rows.map((r, i) =>
                              i === index
                                ? { ...r, settlementReferenceId: event.target.value }
                                : r,
                            ),
                          )
                        }
                      />
                    )}
                    {row.settlementType === "supplier_payable" && (
                      <Input
                        placeholder="Vendor id"
                        className="mt-1"
                        value={row.vendorId}
                        onChange={(event) =>
                          setExpenses((rows) =>
                            rows.map((r, i) =>
                              i === index ? { ...r, vendorId: event.target.value } : r,
                            ),
                          )
                        }
                      />
                    )}
                  </div>
                  <div className="flex items-end justify-between gap-2 sm:col-span-1">
                    <label className="flex items-center gap-1 text-xs text-slate-500">
                      <Checkbox
                        checked={row.isCapitalizable}
                        onCheckedChange={(checked) =>
                          setExpenses((rows) =>
                            rows.map((r, i) =>
                              i === index
                                ? { ...r, isCapitalizable: checked === true }
                                : r,
                            ),
                          )
                        }
                      />
                      Cap.
                    </label>
                    {expenses.length > 1 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        nativeButton={false}
                        render={
                          <button
                            aria-label="Remove expense"
                            onClick={() =>
                              setExpenses((rows) => rows.filter((_, i) => i !== index))
                            }
                          />
                        }
                      >
                        <Trash2 className="size-4 text-rose-500" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Manual allocations */}
          {method === "manual" && (
            <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm shadow-slate-950/[0.02]">
              <Label className="text-sm font-semibold text-slate-700">
                Manual allocation per line (must total the capitalizable amount)
              </Label>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {lineContextByName.map((line) => (
                  <div key={line.purchaseItemId} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-600">
                      {line.variantName || line.productName} ({line.receivedQuantity}/
                      {line.orderedQuantity} received)
                    </span>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      className="w-28"
                      value={manualLines[line.purchaseItemId] ?? ""}
                      onChange={(event) =>
                        setManualLines((current) => ({
                          ...current,
                          [line.purchaseItemId]: event.target.value,
                        }))
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Preview */}
          {preview ? (
            <div className="space-y-4">
              <LandedCostSummary
                totals={{
                  totalExpenseAmount: preview.totalExpenseAmount,
                  totalCapitalizableAmount: preview.totalCapitalizableAmount,
                  totalNonCapitalizableAmount: preview.totalNonCapitalizableAmount,
                  allocatedTotal: preview.allocation.allocatedTotal,
                  pendingTotal: preview.allocation.pendingTotal,
                }}
                impact={preview.accountingImpact}
              />
              <AllocationPreviewTable
                lines={preview.allocation.lines}
                lineContext={lineContext}
              />
            </div>
          ) : null}

          {previewIssues.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {previewIssues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={saving || !previewInput}
              nativeButton={false}
              render={
                <button onClick={saveDraft} disabled={saving || !previewInput} />
              }
            >
              {saving ? "Saving…" : documentId ? "Save draft" : "Create draft"}
            </Button>
            {documentId && status === "draft" && (
              <Button
                type="button"
                disabled={previewQuery.isPending || !preview}
                nativeButton={false}
                render={
                  <button
                    onClick={() => {
                      if (!confirmingPost) {
                        setConfirmingPost(true);
                        return;
                      }
                      void post();
                    }}
                  />
                }
              >
                {confirmingPost
                  ? "Confirm posting?"
                  : `Post ${formatCurrency(preview?.allocation.allocatedTotal ?? 0)} to inventory`}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
