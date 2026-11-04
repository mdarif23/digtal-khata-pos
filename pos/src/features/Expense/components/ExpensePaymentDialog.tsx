import { useEffect, useState, type ReactElement } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Banknote } from "lucide-react";
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
import { formatCurrency } from "@/features/reports/utils/reportUtils";
import {
  getCurrentRegisterSessionApi,
  type ExpensePaymentPayload,
} from "@/api/expenses.api";
import { useRecordExpensePayment } from "../hooks/useExpenses";

const paymentSchema = z.object({
  amount: z
    .number({ message: "Enter a payment amount" })
    .finite()
    .positive("Enter a payment amount greater than zero"),
  paymentMethod: z.enum(["Cash", "Mobile", "Card"]),
  paymentDate: z.string().min(1, "Choose a payment date"),
  referenceNo: z
    .string()
    .trim()
    .max(100, "Reference number is too long")
    .transform((value) => value || null),
  note: z
    .string()
    .trim()
    .max(500, "Note is too long")
    .transform((value) => value || null),
});

type PaymentFormInput = z.input<typeof paymentSchema>;
type PaymentFormOutput = z.output<typeof paymentSchema>;

interface ExpensePaymentDialogProps {
  expenseId: number;
  expenseTitle: string;
  dueAmount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactElement;
}

function localDateValue() {
  const date = new Date();
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 10);
}

export function ExpensePaymentDialog({
  expenseId,
  expenseTitle,
  dueAmount,
  open,
  onOpenChange,
  trigger,
}: ExpensePaymentDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const [registerSessionId, setRegisterSessionId] = useState<number | null>(
    null,
  );
  const recordPayment = useRecordExpensePayment();

  const form = useForm<PaymentFormInput, unknown, PaymentFormOutput>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      amount: dueAmount > 0 ? dueAmount : 0,
      paymentMethod: "Cash",
      paymentDate: localDateValue(),
      referenceNo: "",
      note: "",
    },
  });

  // Cash settlements auto-tie to the recorder's open register session so the
  // drawer's expected cash drops (decision D3 from the Phase 0 approval).
  useEffect(() => {
    if (!isOpen) return;
    form.reset({
      amount: dueAmount > 0 ? dueAmount : 0,
      paymentMethod: "Cash",
      paymentDate: localDateValue(),
      referenceNo: "",
      note: "",
    });
    const method = form.getValues("paymentMethod");
    if (method === "Cash") {
      void getCurrentRegisterSessionApi().then((session) => {
        setRegisterSessionId(session?.id ?? null);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, dueAmount]);

  useEffect(() => {
    if (!isOpen) return;
    const subscription = form.watch((_, { name }) => {
      if (name === "paymentMethod") {
        if (form.getValues("paymentMethod") === "Cash") {
          void getCurrentRegisterSessionApi().then((session) => {
            setRegisterSessionId(session?.id ?? null);
          });
        } else {
          setRegisterSessionId(null);
        }
      }
    });
    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  function handleOpenChange(nextOpen: boolean) {
    if (open === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
    if (!nextOpen) form.reset();
  }

  async function onSubmit(data: PaymentFormOutput) {
    if (data.amount > dueAmount + 0.005) {
      form.setError("amount", {
        message: `The payment cannot exceed the remaining balance of ${formatCurrency(dueAmount)}`,
      });
      return;
    }
    const payload: ExpensePaymentPayload = {
      amount: data.amount,
      paymentMethod: data.paymentMethod,
      paymentDate: data.paymentDate,
      referenceNo: data.referenceNo,
      note: data.note,
      registerSessionId,
      clientUuid: crypto.randomUUID(),
    };
    try {
      await createEntityPromiseToast({
        data: payload,
        apiCall: (p) =>
          recordPayment.mutateAsync({ expenseId, payload: p }),
        entityName: "Payment",
        displayName: formatCurrency(payload.amount),
      });
      handleOpenChange(false);
      form.reset();
    } catch {
      // The promise toast displays the API error (e.g. server-side
      // overpayment rejection) and keeps the form available for correction.
    }
  }

  const errors = form.formState.errors;

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger ? (
        <DialogTrigger render={trigger} />
      ) : null}
      <DialogContent className="sm:max-w-md">
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Record payment</DialogTitle>
            <DialogDescription>
              Settle part or all of “{expenseTitle}”. Remaining balance:{" "}
              <span className="font-medium text-foreground">
                {formatCurrency(dueAmount)}
              </span>
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.amount)}>
                <FieldLabel htmlFor="payment-amount">Amount (৳)</FieldLabel>
                <Input
                  id="payment-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  max={dueAmount}
                  aria-invalid={Boolean(errors.amount)}
                  {...form.register("amount", { valueAsNumber: true })}
                />
                <FieldError>{errors.amount?.message}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errors.paymentDate)}>
                <FieldLabel htmlFor="payment-date">Payment date</FieldLabel>
                <Input
                  id="payment-date"
                  type="date"
                  aria-invalid={Boolean(errors.paymentDate)}
                  {...form.register("paymentDate")}
                />
                <FieldError>{errors.paymentDate?.message}</FieldError>
              </Field>
            </div>
            <Field data-invalid={Boolean(errors.paymentMethod)}>
              <FieldLabel htmlFor="payment-method">Payment method</FieldLabel>
              <select
                id="payment-method"
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
            {registerSessionId && form.watch("paymentMethod") === "Cash" ? (
              <p className="rounded-lg bg-muted/50 p-2.5 text-xs text-muted-foreground">
                This cash payment will be deducted from your open register
                drawer.
              </p>
            ) : null}
            <Field data-invalid={Boolean(errors.referenceNo)}>
              <FieldLabel htmlFor="payment-reference">Reference</FieldLabel>
              <Input
                id="payment-reference"
                placeholder="Optional transaction ID"
                aria-invalid={Boolean(errors.referenceNo)}
                {...form.register("referenceNo")}
              />
              <FieldError>{errors.referenceNo?.message}</FieldError>
            </Field>
            <Field data-invalid={Boolean(errors.note)}>
              <FieldLabel htmlFor="payment-note">Note</FieldLabel>
              <Textarea
                id="payment-note"
                placeholder="Optional context"
                rows={2}
                aria-invalid={Boolean(errors.note)}
                {...form.register("note")}
              />
              <FieldError>{errors.note?.message}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline" disabled={recordPayment.isPending}>
                  Cancel
                </Button>
              }
            />
            <Button type="submit" disabled={recordPayment.isPending}>
              {recordPayment.isPending ? (
                <>
                  <Spinner />
                  Recording
                </>
              ) : (
                <>
                  <Banknote />
                  Record payment
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
