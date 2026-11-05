import { useWatch, type UseFormReturn } from "react-hook-form";
import { Controller } from "react-hook-form";
import { Wallet } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { ReceiveItemsFormValues } from "../../schemas/receiveItem.schema";
import { ReceivingCostSummary } from "./ReceivingCostSummary";

const paymentMethods = [
  { label: "Cash", value: "cash" },
  { label: "Bank transfer", value: "bank_transfer" },
  { label: "Cheque", value: "cheque" },
  { label: "Card", value: "card" },
  { label: "Other", value: "other" },
] as const;

/**
 * Payment fieldset for a receipt: the money summary cards, the amount input
 * (clamped to the page-computed limit — the backend re-validates and is
 * authoritative), the method, and optional notes.
 */
export function ReceivingPaymentSection({
  form,
  paymentLimit,
  receivingTotal,
  paidAmount,
  dueAmount,
  formatCurrency,
}: {
  form: UseFormReturn<ReceiveItemsFormValues>;
  paymentLimit: number;
  receivingTotal: number;
  paidAmount: number;
  dueAmount: number;
  formatCurrency: (value: number) => string;
}) {
  const paymentAmount =
    useWatch({ control: form.control, name: "paymentAmount" }) ?? 0;

  const paymentSummary = [
    {
      bg: "bg-amber-50",
      circleBg: "bg-amber-500",
      title: "Receiving now",
      total: receivingTotal,
    },
    {
      bg: "bg-emerald-50",
      circleBg: "bg-emerald-500",
      title: "Previously paid",
      total: paidAmount,
    },
    {
      bg: "bg-blue-50",
      circleBg: "bg-blue-500",
      title: "Maximum payable now",
      total: paymentLimit,
    },
  ];

  return (
    <section className="space-y-4 rounded-xl border bg-background p-4 shadow-sm md:p-5">
      <div className="flex items-center gap-3">
        <Wallet className="size-5 text-primary" />
        <div>
          <h2 className="font-semibold">Payment for this receipt</h2>
          <p className="text-sm text-muted-foreground">
            Payment is optional. The amount is limited to the received value
            and outstanding balance.
          </p>
        </div>
      </div>

      <ReceivingCostSummary
        cards={paymentSummary}
        dueAmount={dueAmount}
        paymentAmount={Number(paymentAmount) || 0}
        formatCurrency={formatCurrency}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1.5 text-sm font-medium">
          Payment amount
          <Controller
            control={form.control}
            name="paymentAmount"
            render={({ field, fieldState }) => (
              <>
                <Input
                  {...field}
                  value={field.value ?? 0}
                  type="number"
                  min={0}
                  max={paymentLimit}
                  step="0.01"
                  onChange={(event) => {
                    const amount = Number(event.target.value);
                    field.onChange(
                      Number.isFinite(amount)
                        ? Math.min(Math.max(0, amount), paymentLimit)
                        : 0,
                    );
                  }}
                  aria-invalid={fieldState.invalid}
                />
                <span className="text-xs text-muted-foreground">
                  Maximum payable: ৳ {formatCurrency(paymentLimit)}
                </span>
                {fieldState.error && (
                  <span className="block text-xs text-destructive">
                    {fieldState.error.message}
                  </span>
                )}
              </>
            )}
          />
        </label>

        <label className="space-y-1.5 text-sm font-medium">
          Payment method
          <select
            {...form.register("paymentMethod")}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {paymentMethods.map((method) => (
              <option key={method.value} value={method.value}>
                {method.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block space-y-1.5 text-sm font-medium">
        Payment notes{" "}
        <span className="font-normal text-muted-foreground">(optional)</span>
        <textarea
          {...form.register("paymentNotes")}
          rows={2}
          maxLength={300}
          placeholder="Reference number or payment note"
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
        />
      </label>
    </section>
  );
}
