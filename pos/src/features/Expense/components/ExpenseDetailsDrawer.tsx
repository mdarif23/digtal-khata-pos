import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { PermissionButton } from "@/components/common/PermissionGuard";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { formatCurrency, formatDate } from "@/features/reports/utils/reportUtils";
import {
  getAttachmentUrlApi,
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_MB,
} from "@/api/expenses.api";
import { Paperclip, Trash2, Upload } from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  useDeleteExpenseAttachment,
  useUploadExpenseAttachment,
  useVoidExpensePayment,
} from "../hooks/useExpenses";
import { ExpensePaymentDialog } from "./ExpensePaymentDialog";
import { useExpenseDetail } from "../hooks/useExpenses";
import type { ExpenseAttachment, ExpensePaymentStatus } from "../expense.type";

const STATUS_LABELS: Record<ExpensePaymentStatus, string> = {
  paid: "Paid",
  partial: "Partial",
  unpaid: "Unpaid",
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface ExpenseDetailsDrawerProps {
  expenseId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium">{value}</dd>
    </div>
  );
}

export function ExpenseDetailsDrawer({
  expenseId,
  open,
  onOpenChange,
}: ExpenseDetailsDrawerProps) {
  const { data: expense, isLoading, error } = useExpenseDetail(
    open ? expenseId : 0,
  );
  const voidPayment = useVoidExpensePayment();
  const uploadAttachment = useUploadExpenseAttachment();
  const deleteAttachment = useDeleteExpenseAttachment();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{
    id: number;
    amount: number;
  } | null>(null);
  const [attachmentTarget, setAttachmentTarget] = useState<
    ExpenseAttachment | null
  >(null);

  function validateFile(file: File): string | null {
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
    ];
    if (!allowed.includes(file.type)) {
      return "Only PDF, JPEG, PNG and WebP files are supported";
    }
    if (file.size > ATTACHMENT_MAX_MB * 1024 * 1024) {
      return `Files can be up to ${ATTACHMENT_MAX_MB} MB`;
    }
    return null;
  }

  async function handleFileSelected(file: File) {
    if (!expense) return;
    const error = validateFile(file);
    if (error) {
      toast.add({ title: error, type: "error" });
      return;
    }
    try {
      await toast.promise(
        uploadAttachment.mutateAsync({ expenseId: expense.id, file }),
        {
          loading: "Uploading attachment…",
          success: `${file.name} attached`,
          error: (err: { response?: { data?: { message?: string } }; message?: string }) =>
            err?.response?.data?.message ??
            err?.message ??
            "Could not upload attachment",
        },
      );
    } catch {
      // The promise toast displays the API error.
    }
  }

  async function handleOpenAttachment(attachment: ExpenseAttachment) {
    try {
      const { downloadUrl } = await getAttachmentUrlApi(attachment.id);
      window.open(downloadUrl, "_blank", "noopener,noreferrer");
    } catch {
      toast.add({ title: "Could not open the attachment", type: "error" });
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="pr-6 text-left">
            {isLoading ? <Skeleton className="h-6 w-48" /> : (expense?.title ?? "Expense")}
          </SheetTitle>
          <SheetDescription className="text-left">
            Expense details and settlement history.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 px-4 pb-6">
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={`detail-skeleton-${String(index)}`} className="h-5 w-full" />
              ))}
            </div>
          ) : error || !expense ? (
            <p role="alert" className="text-sm text-destructive">
              Could not load this expense. Close and try again.
            </p>
          ) : (
            <>
              <section>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Overview
                </h3>
                <dl className="divide-y divide-border/60">
                  <DetailRow
                    label="Status"
                    value={STATUS_LABELS[expense.paymentStatus]}
                  />
                  <DetailRow label="Total amount" value={formatCurrency(expense.amount)} />
                  <DetailRow label="Paid" value={formatCurrency(expense.paidAmount)} />
                  <DetailRow
                    label="Due"
                    value={
                      expense.dueAmount > 0 ? formatCurrency(expense.dueAmount) : "—"
                    }
                  />
                  <DetailRow label="Expense date" value={formatDate(expense.expenseDate)} />
                  <DetailRow
                    label="Category"
                    value={expense.categoryName ?? "Uncategorized"}
                  />
                  <DetailRow label="Payee" value={expense.payee ?? "—"} />
                  <DetailRow
                    label="Location"
                    value={expense.locationName ?? "—"}
                  />
                  <DetailRow
                    label="Payment method"
                    value={expense.paymentMethod ?? "—"}
                  />
                  <DetailRow label="Reference" value={expense.referenceNo ?? "—"} />
                  <DetailRow
                    label="Channel"
                    value={
                      expense.channel === "woocommerce"
                        ? "WooCommerce"
                        : expense.channel === "custom_storefront"
                          ? "Custom storefront"
                          : "All channels"
                    }
                  />
                </dl>
                {expense.note ? (
                  <p className="mt-3 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
                    {expense.note}
                  </p>
                ) : null}
              </section>

              <Separator />

              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Settlement history
                  </h3>
                  {expense.dueAmount > 0 ? (
                    <PermissionButton
                      type="button"
                      variant="outline"
                      size="sm"
                      permission="expenses.pay"
                      onClick={() => setPaymentDialogOpen(true)}
                    >
                      Record payment
                    </PermissionButton>
                  ) : null}
                </div>
                {expense.payments.length ? (
                  <ol className="space-y-3">
                    {expense.payments.map((payment) => (
                      <li
                        key={payment.id}
                        className="flex items-start justify-between gap-3 rounded-lg border p-3"
                      >
                        <div>
                          <p className="text-sm font-medium">
                            {formatCurrency(Number(payment.amount))}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {formatDate(payment.paymentDate)} · {payment.paymentMethod}
                            {payment.referenceNo ? ` · ${payment.referenceNo}` : ""}
                          </p>
                          {payment.note ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {payment.note}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Badge variant="secondary">Settlement</Badge>
                          <PermissionButton
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            permission="expenses.delete"
                            aria-label={`Void payment of ${formatCurrency(Number(payment.amount))}`}
                            onClick={() =>
                              setVoidTarget({
                                id: payment.id,
                                amount: Number(payment.amount),
                              })
                            }
                          >
                            <Trash2 className="text-destructive" />
                          </PermissionButton>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No payments recorded yet — the outstanding balance remains{" "}
                    {formatCurrency(expense.dueAmount)}.
                  </p>
                )}
              </section>

              <Separator />

              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Attachments
                  </h3>
                  <PermissionButton
                    type="button"
                    variant="outline"
                    size="sm"
                    permission="expenses.edit"
                    disabled={uploadAttachment.isPending}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload />
                    Attach file
                  </PermissionButton>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ATTACHMENT_ACCEPT}
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void handleFileSelected(file);
                    }}
                  />
                </div>
                {expense.attachments.length ? (
                  <ul className="space-y-2">
                    {expense.attachments.map((attachment) => (
                      <li
                        key={attachment.id}
                        className="flex items-center justify-between gap-3 rounded-lg border p-2.5"
                      >
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-2.5 text-left"
                          onClick={() => void handleOpenAttachment(attachment)}
                        >
                          <Paperclip className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {attachment.fileName}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {formatBytes(Number(attachment.bytes))} ·{" "}
                              {formatDate(attachment.createdAt)}
                            </span>
                          </span>
                        </button>
                        <PermissionButton
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          permission="expenses.delete"
                          aria-label={`Delete ${attachment.fileName}`}
                          onClick={() => setAttachmentTarget(attachment)}
                        >
                          <Trash2 className="text-destructive" />
                        </PermissionButton>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No receipts or invoices attached yet (PDF or images up to{" "}
                    {ATTACHMENT_MAX_MB} MB).
                  </p>
                )}
              </section>
            </>
          )}
        </div>

        <div className="border-t px-4 py-3">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>

        {expense ? (
          <ExpensePaymentDialog
            expenseId={expense.id}
            expenseTitle={expense.title}
            dueAmount={expense.dueAmount}
            open={paymentDialogOpen}
            onOpenChange={setPaymentDialogOpen}
          />
        ) : null}

        <ConfirmDeleteDialog
          open={voidTarget !== null}
          onOpenChange={(next) => {
            if (!next) setVoidTarget(null);
          }}
          title="Void this payment?"
          description={`The settlement of ${formatCurrency(voidTarget?.amount ?? 0)} will be removed and the expense balance restored. This is recorded in the audit log.`}
          entityName="Payment"
          onConfirm={async () => {
            if (!voidTarget || !expense) return;
            await voidPayment.mutateAsync({
              expenseId: expense.id,
              paymentId: voidTarget.id,
            });
            setVoidTarget(null);
          }}
        />

        <ConfirmDeleteDialog
          open={attachmentTarget !== null}
          onOpenChange={(next) => {
            if (!next) setAttachmentTarget(null);
          }}
          title="Delete this attachment?"
          description={`"${attachmentTarget?.fileName ?? ""}" will be removed from this expense. The deletion is recorded in the audit log.`}
          entityName="Attachment"
          onConfirm={async () => {
            if (!attachmentTarget) return;
            await deleteAttachment.mutateAsync(attachmentTarget.id);
            setAttachmentTarget(null);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}
