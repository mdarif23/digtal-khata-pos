import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import {
  useRecordCustomerPayment,
  useRecordSupplierPayment,
} from "../hooks/useDueManagement";
import { todayInputValue } from "../lib/format";
import { formatCurrency } from "@/lib/format";

export type CustomerPaymentTarget = {
  kind: "customer";
  saleId: number;
  customerName: string;
  invoiceNumber: string;
  outstandingAmount: number;
};

export type SupplierPaymentTarget = {
  kind: "supplier";
  purchaseId: number;
  supplierName: string;
  purchaseInvoice: string;
  outstandingAmount: number;
};

export type PaymentTarget = CustomerPaymentTarget | SupplierPaymentTarget;

const customerPaymentFormSchema = z
  .object({
    amount: z
      .number({ message: "Enter a valid amount." })
      .positive("Amount must be greater than zero."),
    paymentMethod: z.enum(["cash", "bangla_qr", "card"]),
    reference: z.string().trim().max(100).optional(),
    paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a valid date."),
    notes: z.string().trim().max(500).optional(),
  })
  .superRefine((values, ctx) => {
    if (
      (values.paymentMethod === "card" ||
        values.paymentMethod === "bangla_qr") &&
      (values.reference ?? "").trim().length < 6
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reference"],
        message:
          "Card and QR payments require a reference of at least 6 characters.",
      });
    }
  });

const supplierPaymentFormSchema = z.object({
  amount: z
    .number({ message: "Enter a valid amount." })
    .positive("Amount must be greater than zero."),
  method: z.enum(["cash", "bank_transfer", "cheque", "card", "other"]),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a valid date."),
  notes: z.string().trim().max(500).optional(),
});

type CustomerFormValues = z.infer<typeof customerPaymentFormSchema>;
type SupplierFormValues = z.infer<typeof supplierPaymentFormSchema>;

const CUSTOMER_METHOD_LABELS: Record<
  CustomerFormValues["paymentMethod"],
  string
> = {
  cash: "Cash",
  bangla_qr: "Mobile / QR (Bangla QR)",
  card: "Card",
};

const SUPPLIER_METHOD_LABELS: Record<SupplierFormValues["method"], string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  card: "Card",
  other: "Other",
};

type FormFieldError = { message?: string } | undefined;

function OutstandingSummary({
  outstanding,
  amount,
}: {
  outstanding: number;
  amount: number | undefined;
}) {
  const parsed = Number(amount ?? 0);
  const remainingAfter =
    Number.isFinite(parsed) && parsed > 0
      ? Math.max(0, outstanding - parsed)
      : outstanding;
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Outstanding</span>
        <span className="font-semibold tabular-nums">{formatCurrency(outstanding)}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">After this payment</span>
        <span className="font-semibold tabular-nums">{formatCurrency(remainingAfter)}</span>
      </div>
    </div>
  );
}

function CustomerPaymentForm({
  target,
  onDone,
  onCancel,
}: {
  target: CustomerPaymentTarget;
  onDone: () => void;
  onCancel: () => void;
}) {
  const mutation = useRecordCustomerPayment();
  const [serverError, setServerError] = useState("");

  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(customerPaymentFormSchema),
    defaultValues: {
      // exactOptionalPropertyTypes: omit `amount` instead of passing undefined.
      ...(target.outstandingAmount > 0
        ? { amount: target.outstandingAmount }
        : {}),
      paymentMethod: "cash",
      reference: "",
      paymentDate: todayInputValue(),
      notes: "",
    },
  });

  const amount = form.watch("amount");
  const method = form.watch("paymentMethod");
  const needsReference = method === "card" || method === "bangla_qr";

  async function onSubmit(values: CustomerFormValues) {
    setServerError("");
    try {
      await mutation.mutateAsync({
        saleId: target.saleId,
        amount: values.amount,
        paymentMethod: values.paymentMethod,
        reference: values.reference || null,
        notes: values.notes || null,
        paymentDate: values.paymentDate,
      });
      toast.add({
        type: "success",
        description: `Payment of ${formatCurrency(values.amount)} recorded for ${target.invoiceNumber}.`,
      });
      onDone();
    } catch (error) {
      setServerError(
        (error as { response?: { data?: { message?: string } } })?.response
          ?.data?.message ??
          (error instanceof Error
            ? error.message
            : "Could not record payment."),
      );
    }
  }

  return (
    <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
      <OutstandingSummary
        outstanding={target.outstandingAmount}
        amount={amount}
      />

      <Controller
        name="amount"
        control={form.control}
        render={({ field, fieldState }) => (
          <div className="space-y-2">
            <Label htmlFor="payment-amount">Amount</Label>
            <Input
              id="payment-amount"
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              placeholder="0.00"
              {...field}
              value={field.value ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                const parsed = Number(val);
                field.onChange(parsed);
              }}
            />
            <FieldErrorText error={fieldState.error as FormFieldError} />
          </div>
        )}
      />

      <Controller
        name="paymentMethod"
        control={form.control}
        render={({ field, fieldState }) => (
          <div className="space-y-2">
            <Label htmlFor="payment-method">Payment method</Label>
            <Select
              value={field.value}
              onValueChange={(value) =>
                field.onChange(value as CustomerFormValues["paymentMethod"])
              }
              items={(
                Object.keys(CUSTOMER_METHOD_LABELS) as Array<
                  CustomerFormValues["paymentMethod"]
                >
              ).map((key) => ({ value: key, label: CUSTOMER_METHOD_LABELS[key] }))}
            >
              <SelectTrigger id="payment-method" className="w-full">
                <SelectValue placeholder="Select method" />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.keys(CUSTOMER_METHOD_LABELS) as Array<
                    CustomerFormValues["paymentMethod"]
                  >
                ).map((key) => (
                  <SelectItem key={key} value={key}>
                    {CUSTOMER_METHOD_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldErrorText error={fieldState.error as FormFieldError} />
          </div>
        )}
      />

      {needsReference ? (
        <Controller
          name="reference"
          control={form.control}
          render={({ field, fieldState }) => (
            <div className="space-y-2">
              <Label htmlFor="payment-reference">Transaction reference</Label>
              <Input
                id="payment-reference"
                placeholder="TrxID / approval code"
                {...field}
                value={field.value ?? ""}
              />
              <FieldErrorText error={fieldState.error as FormFieldError} />
            </div>
          )}
        />
      ) : null}

      <Controller
        name="paymentDate"
        control={form.control}
        render={({ field, fieldState }) => (
          <div className="space-y-2">
            <Label htmlFor="payment-date">Payment date</Label>
            <Input id="payment-date" type="date" {...field} />
            <FieldErrorText error={fieldState.error as FormFieldError} />
          </div>
        )}
      />

      <Controller
        name="notes"
        control={form.control}
        render={({ field }) => (
          <div className="space-y-2">
            <Label htmlFor="payment-notes">Notes (optional)</Label>
            <Textarea
              id="payment-notes"
              rows={2}
              placeholder="e.g. Second installment"
              {...field}
              value={field.value ?? ""}
            />
          </div>
        )}
      />

      <ServerErrorText error={serverError} />

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={mutation.isPending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <SubmitButton
          isPending={mutation.isPending}
          disabled={target.outstandingAmount <= 0}
          label="Record payment"
        />
      </DialogFooter>
    </form>
  );
}

function SupplierPaymentForm({
  target,
  onDone,
  onCancel,
}: {
  target: SupplierPaymentTarget;
  onDone: () => void;
  onCancel: () => void;
}) {
  const mutation = useRecordSupplierPayment();
  const [serverError, setServerError] = useState("");

  const form = useForm<SupplierFormValues>({
    resolver: zodResolver(supplierPaymentFormSchema),
    defaultValues: {
      ...(target.outstandingAmount > 0
        ? { amount: target.outstandingAmount }
        : {}),
      method: "cash",
      paymentDate: todayInputValue(),
      notes: "",
    },
  });

  const amount = form.watch("amount");

  async function onSubmit(values: SupplierFormValues) {
    setServerError("");
    try {
      await mutation.mutateAsync({
        purchaseId: target.purchaseId,
        amount: values.amount,
        method: values.method,
        notes: values.notes || null,
        paymentDate: values.paymentDate,
      });
      toast.add({
        type: "success",
        description: `Payment of ${formatCurrency(values.amount)} recorded for ${target.purchaseInvoice}.`,
      });
      onDone();
    } catch (error) {
      setServerError(
        (error as { response?: { data?: { message?: string } } })?.response
          ?.data?.message ??
          (error instanceof Error
            ? error.message
            : "Could not record payment."),
      );
    }
  }

  return (
    <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
      <OutstandingSummary
        outstanding={target.outstandingAmount}
        amount={amount}
      />

      <Controller
        name="amount"
        control={form.control}
        render={({ field, fieldState }) => (
          <div className="space-y-2">
            <Label htmlFor="payment-amount">Amount</Label>
            <Input
              id="payment-amount"
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              placeholder="0.00"
              {...field}
              value={field.value ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                const parsed = Number(val);
                field.onChange(parsed);
              }}
            />
            <FieldErrorText error={fieldState.error as FormFieldError} />
          </div>
        )}
      />

      <Controller
        name="method"
        control={form.control}
        render={({ field, fieldState }) => (
          <div className="space-y-2">
            <Label htmlFor="payment-method">Payment method</Label>
            <Select
              value={field.value}
              onValueChange={(value) =>
                field.onChange(value as SupplierFormValues["method"])
              }
              items={(
                Object.keys(SUPPLIER_METHOD_LABELS) as Array<
                  SupplierFormValues["method"]
                >
              ).map((key) => ({ value: key, label: SUPPLIER_METHOD_LABELS[key] }))}
            >
              <SelectTrigger id="payment-method" className="w-full">
                <SelectValue placeholder="Select method" />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.keys(SUPPLIER_METHOD_LABELS) as Array<
                    SupplierFormValues["method"]
                  >
                ).map((key) => (
                  <SelectItem key={key} value={key}>
                    {SUPPLIER_METHOD_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldErrorText error={fieldState.error as FormFieldError} />
          </div>
        )}
      />

      <Controller
        name="paymentDate"
        control={form.control}
        render={({ field, fieldState }) => (
          <div className="space-y-2">
            <Label htmlFor="payment-date">Payment date</Label>
            <Input id="payment-date" type="date" {...field} />
            <FieldErrorText error={fieldState.error as FormFieldError} />
          </div>
        )}
      />

      <Controller
        name="notes"
        control={form.control}
        render={({ field }) => (
          <div className="space-y-2">
            <Label htmlFor="payment-notes">Notes (optional)</Label>
            <Textarea
              id="payment-notes"
              rows={2}
              placeholder="e.g. Cheque #12345"
              {...field}
              value={field.value ?? ""}
            />
          </div>
        )}
      />

      <ServerErrorText error={serverError} />

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={mutation.isPending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <SubmitButton
          isPending={mutation.isPending}
          disabled={target.outstandingAmount <= 0}
          label="Record payment"
        />
      </DialogFooter>
    </form>
  );
}

function FieldErrorText({ error }: { error: FormFieldError }) {
  if (!error?.message) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {error.message}
    </p>
  );
}

function ServerErrorText({ error }: { error: string }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );
}

function SubmitButton({
  isPending,
  disabled,
  label,
}: {
  isPending: boolean;
  disabled: boolean;
  label: string;
}) {
  return (
    <Button type="submit" disabled={isPending || disabled}>
      {isPending ? (
        <>
          <Loader2 className="animate-spin" />
          Recording…
        </>
      ) : (
        <>
          <Save />
          {label}
        </>
      )}
    </Button>
  );
}

export function RecordPaymentDialog({
  target,
  open,
  onOpenChange,
}: {
  target: PaymentTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Reset inner forms whenever the dialog closes, so reopening for a
  // different invoice never shows stale values.
  const [closedAt, setClosedAt] = useState(0);

  useEffect(() => {
    if (!open) setClosedAt(Date.now());
  }, [open]);

  if (!target) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Record{" "}
            {target.kind === "customer" ? "collection" : "supplier payment"}
          </DialogTitle>
          <DialogDescription>
            {target.kind === "customer"
              ? `Receive payment for invoice ${target.invoiceNumber} from ${target.customerName}.`
              : `Pay supplier ${target.supplierName} against purchase ${target.purchaseInvoice}.`}
          </DialogDescription>
        </DialogHeader>
        {target.kind === "customer" ? (
          <CustomerPaymentForm
            key={`customer-${target.saleId}-${closedAt}`}
            target={target}
            onDone={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        ) : (
          <SupplierPaymentForm
            key={`supplier-${target.purchaseId}-${closedAt}`}
            target={target}
            onDone={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
