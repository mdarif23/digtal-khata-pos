import { Button } from "@/components/ui/button";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import "@/i18n/index.js";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useCustomersQuery } from "@/features/customers/hooks/useCustomers.js";
import type { InputValue } from "@/types/customers.types.js";
import { Controller, UseFormReturn, useWatch } from "react-hook-form";
import { CartSchemaType, PaymentSchemaType } from "../../schemas/cart.schema";
import { useCartStore } from "@/features/pos/stores/useCartStore";
import { useEffect, useState } from "react";
import { formatCurrency, formatNumber } from "@/lib/format";
import { Kbd } from "@/components/common/Kbd";
import {
  Banknote,
  Clock3,
  Coins,
  CreditCard,
  Gift,
  Layers,
  QrCode,
  Trash2,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import axios from "../../../../api/axios.js";

import type { PaymentMode } from "./paymentHelpers.js";
import { QR_NUMBER } from "./paymentHelpers.js";
import {
  buildPayments,
  EMPTY_CUSTOMER_LIST,
  getMode,
  money,
  toNum,
  type TenderBalances,
} from "./paymentHelpers.js";
import {
  isPaymentValid,
  loyaltyIssue,
  storeCreditIssue,
} from "./paymentValidation.js";
import { useTenderBalances } from "./useTenderBalances.js";

export function PaymentModal({
  finalTotal: quotedFinalTotal,
  form,
  isPaymentDialogOpen,
  setIsPaymentDialogOpen,
}: {
  finalTotal: number;
  form: UseFormReturn<CartSchemaType>;
  isPaymentDialogOpen: boolean;
  setIsPaymentDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { t } = useTranslation();
  const cart = useCartStore((state) => state.cart);
  // The server quote is the authoritative charge target: it already includes
  // the coupon discount and the exclusive/inclusive tax split. Deriving the
  // charge from subTotal + vat here double-counts inclusive tax and misses
  // the coupon entirely.
  const finalTotal = money(quotedFinalTotal);

  const payments = useWatch({ control: form.control, name: "payments" });
  const customerId = useWatch({ control: form.control, name: "customerId" });

  // Balance tenders need the customer's live store-credit / loyalty numbers.
  const tender = useTenderBalances(customerId, isPaymentDialogOpen);

  const mode = getMode(payments);
  const valid = isPaymentValid(payments ?? [], finalTotal, customerId, tender);
  const isSubmitting = form.formState.isSubmitting;
  return (
    <Dialog
      open={isPaymentDialogOpen}
      onOpenChange={(open: boolean) => {
        setIsPaymentDialogOpen(open);
        // Always start fresh with the CURRENT total when the modal opens
        if (open) form.setValue("payments", buildPayments("cash", finalTotal));
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            disabled={cart.length === 0}
            className="h-14 w-full justify-between px-4 text-base font-semibold"
          >
            <span className="flex items-center gap-2">
              {t("payment:chargeCustomer", {
                defaultValue: "Charge customer",
              })}
              <Kbd keys={["F6"]} className="opacity-70" />
            </span>
            <span className="tabular-nums">{formatCurrency(finalTotal)}</span>
          </Button>
        }
      />
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t("payment:paymentTitle", { defaultValue: "Payment" })}
          </DialogTitle>
          <DialogDescription className="text-base font-semibold text-foreground">
            {t("payment:totalDue", { defaultValue: "Total due:" })}{" "}
            <span className="tabular-nums">{formatCurrency(finalTotal)}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 sm:flex-row sm:justify-between">
          <PaymentMethod
            form={form}
            finalTotal={finalTotal}
            mode={mode}
            customerId={customerId}
          />

          <div className="flex min-w-0 flex-1 flex-col gap-5">
            {mode === "cash" && (
              <CashPayment finalTotal={finalTotal} form={form} />
            )}
            {mode === "bangla_qr" && (
              <DigitalCashPayment
                finalTotal={finalTotal}
                form={form}
                sendTo
                paymentInstruction={t("payment:banglaQrInstruction", {
                  defaultValue: "Bangla QR: {{number}}",
                  number: QR_NUMBER,
                })}
              />
            )}
            {mode === "card" && (
              <DigitalCashPayment
                finalTotal={finalTotal}
                form={form}
                paymentInstruction={t("payment:instructionCard", {
                  defaultValue: "Insert / tap card on POS terminal",
                })}
              />
            )}
            {mode === "gift_card" && (
              <DigitalCashPayment
                finalTotal={finalTotal}
                form={form}
                paymentInstruction={t("payment:instructionGiftCard", {
                  defaultValue: "Enter the customer's gift card code",
                })}
              />
            )}
            {mode === "store_credit" && (
              <StoreCreditPayment
                finalTotal={finalTotal}
                customerId={customerId}
                tender={tender}
              />
            )}
            {mode === "loyalty_points" && (
              <LoyaltyPointsPayment
                finalTotal={finalTotal}
                customerId={customerId}
                tender={tender}
              />
            )}
            {mode === "split" && (
              <SplitPayment
                finalTotal={finalTotal}
                form={form}
                customerId={customerId}
                tender={tender}
              />
            )}
            {mode === "due" && (
              <Due form={form} finalTotal={finalTotal} tender={tender} />
            )}
          </div>
        </div>

        <DialogFooter>
          <DialogClose
            render={
              <Button type="button" variant="outline">
                {t("common:cancel", { defaultValue: "Cancel" })}
              </Button>
            }
          />
          <Button
            form="cart-form"
            type="submit"
            disabled={!valid || isSubmitting}
          >
            {t("payment:confirmPayment", { defaultValue: "Confirm Payment" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- method selector ----------
function PaymentMethod({
  form,
  finalTotal,
  mode,
  customerId,
}: {
  form: UseFormReturn<CartSchemaType>;
  finalTotal: number;
  mode: string | undefined;
  customerId: number | null;
}) {
  const { t } = useTranslation();
  const options = [
    { label: "Cash", labelKey: "payment:method.cash", value: "cash", icon: Banknote },
    { label: "Bangla QR", labelKey: "payment:method.banglaQr", value: "bangla_qr", icon: QrCode },
    { label: "Card", labelKey: "payment:method.card", value: "card", icon: CreditCard },
    { label: "Store credit", labelKey: "payment:method.storeCredit", value: "store_credit", icon: Wallet },
    { label: "Loyalty points", labelKey: "payment:method.loyaltyPoints", value: "loyalty_points", icon: Coins },
    { label: "Gift card", labelKey: "payment:method.giftCard", value: "gift_card", icon: Gift },
    { label: "Due", labelKey: "payment:method.due", value: "due", icon: Clock3 },
    { label: "Split", labelKey: "payment:method.split", value: "split", icon: Layers },
  ];

  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium">
        {t("payment:selectMethod", { defaultValue: "Select method" })}
      </span>
      <ToggleGroup
        value={mode ? [mode] : []}
        onValueChange={(value: string[]) => {
          const selected = value[0] as PaymentMode;
          if (!selected) return; // don't allow "no method"
          // Replace the WHOLE array -> no ghost amounts/references left behind
          form.setValue("payments", buildPayments(selected, finalTotal));
        }}
        size="lg"
        variant="outline"
        className="grid grid-cols-2 max-h-50"
      >
        {options.map((m) => (
          <ToggleGroupItem
            key={m.value}
            value={m.value}
            disabled={
              customerId == null &&
              (m.value === "due" ||
                m.value === "store_credit" ||
                m.value === "loyalty_points")
            }
            className="col-span-1 justify-start gap-2 px-3 data-pressed:bg-primary data-pressed:text-primary-foreground"
          >
            <m.icon className="size-4" aria-hidden="true" />
            {t(m.labelKey, { defaultValue: m.label })}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

// ---------- cash ----------
function CashPayment({
  finalTotal,
  form,
}: {
  finalTotal: number;
  form: UseFormReturn<CartSchemaType>;
}) {
  const { t } = useTranslation();
  // amount = what is applied to the sale (always finalTotal)
  // tendered = what the customer handed over
  const tendered = useWatch({
    control: form.control,
    name: "payments.0.tendered",
  });
  const paid = money(tendered);
  const change = Math.max(0, money(paid - finalTotal));
  const owed = Math.max(0, money(finalTotal - paid));
  const isOwed = owed > 0;

  const shortcuts = [
    { label: t("payment:cashExact", { defaultValue: "Exact" }), value: finalTotal },
    { label: "100", value: 100 },
    { label: "200", value: 200 },
    { label: "300", value: 300 },
    { label: "500", value: 500 },
    { label: "1000", value: 1000 },
  ];

  return (
    <>
      <Controller
        name="payments.0.tendered"
        control={form.control}
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor={field.name}>
              {t("payment:cashReceive", { defaultValue: "Cash Receive" })}
            </FieldLabel>
            <Input
              id={field.name}
              type="number"
              {...field}
              value={field.value ?? ""}
              onChange={(e) => field.onChange(toNum(e))}
              placeholder="0.00"
            />
          </Field>
        )}
      />

      <div className="grid grid-cols-3 gap-2">
        {shortcuts.map((s) => (
          <Button
            key={s.label}
            type="button"
            variant="outline"
            onClick={() => form.setValue("payments.0.tendered", s.value)}
          >
            {s.label}
          </Button>
        ))}
      </div>

      <Card
        className={cn(
          "ring-1",
          isOwed ? "ring-destructive/30" : "ring-success/30",
        )}
      >
        <CardContent className="flex flex-col items-center gap-0.5 py-4">
          <span className="text-sm text-muted-foreground">
            {isOwed
              ? t("payment:stillOwed", { defaultValue: "Still owed" })
              : t("payment:changeToGive", { defaultValue: "Change to give" })}
          </span>
          <span
            className={cn(
              "text-2xl font-bold tabular-nums",
              isOwed ? "text-destructive" : "text-success",
            )}
          >
            {formatCurrency(isOwed ? owed : change)}
          </span>
        </CardContent>
      </Card>
    </>
  );
}

// ---------- Bangla QR / Card ----------
function DigitalCashPayment({
  paymentInstruction,
  finalTotal,
  form,
  sendTo = false,
}: {
  paymentInstruction: string;
  finalTotal: number;
  form: UseFormReturn<CartSchemaType>;
  /** Bangla QR carries a merchant number to pay TO; other methods show an
   *  instruction. Explicit flag — the old startsWith("Bangla QR") string
   *  sniffing breaks once the instruction is translated. */
  sendTo?: boolean;
}) {
  const { t } = useTranslation();
  // amount is already set to finalTotal by buildPayments, no useEffect needed
  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-1 py-4">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {sendTo
              ? t("payment:sendTo", { defaultValue: "Send to" })
              : t("payment:instruction", { defaultValue: "Instruction" })}
          </span>
          <span className="font-medium">{paymentInstruction}</span>
        </CardContent>
      </Card>

      <Controller
        name="payments.0.reference"
        control={form.control}
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor={field.name}>
              {t("payment:transactionId", {
                defaultValue: "Transaction ID (last 6+ chars)",
              })}
            </FieldLabel>
            <Input
              id={field.name}
              {...field}
              value={field.value ?? ""}
              type="text"
              placeholder="e.g. 9AD98ADFAF"
            />
          </Field>
        )}
      />

      <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
        <span className="text-sm text-muted-foreground">
          {t("payment:amountToCharge", { defaultValue: "Amount to charge" })}
        </span>
        <span className="text-base font-semibold tabular-nums">
          {formatCurrency(finalTotal)}
        </span>
      </div>
    </>
  );
}

// ---------- store credit ----------
function StoreCreditPayment({
  finalTotal,
  customerId,
  tender,
}: {
  finalTotal: number;
  customerId: number | null;
  tender: TenderBalances;
}) {
  const { t } = useTranslation();
  const issue = storeCreditIssue(finalTotal, customerId, tender);
  const available = tender.storeCredit;

  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 py-4">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("payment:method.storeCredit", { defaultValue: "Store credit" })}
        </span>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {t("payment:available", { defaultValue: "Available" })}
          </span>
          <span className="font-medium tabular-nums">
            {available === null
              ? t("payment:checking", { defaultValue: "checking…" })
              : formatCurrency(available)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {t("payment:amountApplied", { defaultValue: "Amount applied" })}
          </span>
          <span className="font-semibold tabular-nums">
            {formatCurrency(finalTotal)}
          </span>
        </div>
        {issue && (
          <span className="text-sm text-destructive">{issue}</span>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- loyalty points ----------
function LoyaltyPointsPayment({
  finalTotal,
  customerId,
  tender,
}: {
  finalTotal: number;
  customerId: number | null;
  tender: TenderBalances;
}) {
  const { t } = useTranslation();
  const config = tender.loyaltyConfig;
  const points =
    config && config.redeemValue > 0
      ? money(finalTotal / config.redeemValue)
      : null;
  const balance = tender.loyaltyBalance;
  const issue = loyaltyIssue(finalTotal, customerId, tender);

  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 py-4">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("payment:method.loyaltyPoints", { defaultValue: "Loyalty points" })}
        </span>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {t("payment:balance", { defaultValue: "Balance" })}
          </span>
          <span className="font-medium tabular-nums">
            {balance === null
              ? t("payment:checking", { defaultValue: "checking…" })
              : formatNumber(balance)}
          </span>
        </div>
        {points !== null && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {t("payment:redeems", {
                defaultValue: "Redeems {{amount}}{{rate}}",
                amount: formatCurrency(finalTotal),
                rate: config
                  ? t("payment:ratePerPoint", {
                      defaultValue: " (৳{{value}}/point)",
                      value: config.redeemValue,
                    })
                  : "",
              })}
            </span>
            <span className="font-semibold tabular-nums">
              {t("payment:pointsSuffix", {
                defaultValue: "{{points}} pts",
                points: formatNumber(points),
              })}
            </span>
          </div>
        )}
        {config && config.maxRedemptionPointsPerSale !== null && (
          <span className="text-xs text-muted-foreground">
            {t("payment:maxPointsPerSale", {
              defaultValue: "Max {{points}} points per sale",
              points: formatNumber(config.maxRedemptionPointsPerSale),
            })}
          </span>
        )}
        {issue && (
          <span className="text-sm text-destructive">{issue}</span>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- split ----------
// P3 Phase 1 (F5): an arbitrary ordered list of tender rows over ALL backend
// methods. The old positional cash/digital/due builder is gone — rows are
// added, switched, filled and removed individually; the backend's
// distinct-method constraint is preserved by the row picker (no duplicates).
const SPLIT_METHODS: {
  value: PaymentSchemaType["method"];
  label: string;
  labelKey: string;
}[] = [
  { value: "cash", label: "Cash", labelKey: "payment:method.cash" },
  { value: "bangla_qr", label: "Bangla QR", labelKey: "payment:method.banglaQr" },
  { value: "card", label: "Card", labelKey: "payment:method.card" },
  { value: "store_credit", label: "Store credit", labelKey: "payment:method.storeCredit" },
  { value: "loyalty_points", label: "Loyalty points", labelKey: "payment:method.loyaltyPoints" },
  { value: "gift_card", label: "Gift card", labelKey: "payment:method.giftCard" },
  { value: "due", label: "Due", labelKey: "payment:method.due" },
];

function SplitPayment({
  form,
  finalTotal,
  customerId,
  tender,
}: {
  form: UseFormReturn<CartSchemaType>;
  finalTotal: number;
  customerId: number | null;
  tender: TenderBalances;
}) {
  const { t } = useTranslation();
  // Localized method label — falls back to the raw enum (same as the old
  // methodLabel helper) for unknown methods.
  const methodLabel = (method: string | undefined): string => {
    const found = SPLIT_METHODS.find((m) => m.value === method);
    return found ? t(found.labelKey, { defaultValue: found.label }) : (method ?? "");
  };
  const payments = useWatch({ control: form.control, name: "payments" }) ?? [];
  const allocated = money(
    payments.reduce((acc, p) => acc + money(p?.amount), 0),
  );
  const remaining = money(finalTotal - allocated);

  // Put whatever is still unpaid into the given row
  const fill = (index: number) => {
    const current = money(payments[index]?.amount);
    form.setValue(`payments.${index}.amount`, Math.max(0, money(current + remaining)));
  };

  // Next unused method (due/store_credit/loyalty need a customer).
  const addRow = () => {
    if (payments.length >= SPLIT_METHODS.length) return;
    const used = new Set(payments.map((p) => p.method));
    const next =
      SPLIT_METHODS.find(
        (m) =>
          !used.has(m.value) &&
          (customerId != null || (m.value !== "due" && m.value !== "store_credit" && m.value !== "loyalty_points")),
      )?.value ?? "cash";
    form.setValue("payments", [
      ...payments,
      {
        method: next,
        amount: undefined,
        ...(next === "bangla_qr" || next === "card" || next === "gift_card"
          ? { reference: "" }
          : {}),
      },
    ]);
  };

  const removeRow = (index: number) => {
    if (payments.length <= 1) return;
    form.setValue(
      "payments",
      payments.filter((_, i) => i !== index),
    );
  };

  const changeRowMethod = (index: number, method: PaymentSchemaType["method"]) => {
    const rows = payments.map((p, i) =>
      i === index
        ? {
            method,
            amount: p.amount,
            ...(method === "bangla_qr" || method === "card" || method === "gift_card"
              ? { reference: "" }
              : {}),
          }
        : p,
    );
    form.setValue("payments", rows);
  };

  // Due rows over the available credit (display-only warning; the backend
  // authoritatively rejects a sale that exceeds the limit).
  const dueAmount = money(
    payments
      .filter((p) => p.method === "due")
      .reduce((acc, p) => acc + money(p.amount), 0),
  );
  const creditShort =
    dueAmount > 0 &&
    tender.creditLimit != null &&
    tender.creditAvailable != null &&
    dueAmount > tender.creditAvailable + 0.005;

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-1 py-4">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("payment:splitPayment", { defaultValue: "Split payment" })}
          </span>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {t("common:total", { defaultValue: "Total" })}
            </span>
            <span className="font-medium tabular-nums">
              {formatCurrency(finalTotal)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {t("payment:remaining", { defaultValue: "Remaining" })}
            </span>
            <span
              className={cn(
                "font-semibold tabular-nums",
                remaining === 0 ? "text-success" : "text-destructive",
              )}
            >
              {formatCurrency(remaining)}
            </span>
          </div>
        </CardContent>
      </Card>

      {payments.map((payment, index) => {
        const needsReference =
          payment.method === "bangla_qr" ||
          payment.method === "card" ||
          payment.method === "gift_card";
        const isDue = payment.method === "due";
        return (
          <div key={index} className="rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <select
                aria-label={t("payment:tenderMethodAria", {
                  defaultValue: "Tender method {{index}}",
                  index: index + 1,
                })}
                className="min-w-0 flex-1 rounded-md border bg-background p-2 text-sm"
                value={payment.method}
                onChange={(e) =>
                  changeRowMethod(
                    index,
                    e.target.value as PaymentSchemaType["method"],
                  )
                }
              >
                {SPLIT_METHODS.map((m) => (
                  <option
                    key={m.value}
                    value={m.value}
                    disabled={
                      // distinct methods (backend constraint) + customer-gated tenders
                      (m.value !== payment.method &&
                        payments.some((p) => p.method === m.value)) ||
                      (customerId == null &&
                        (m.value === "due" ||
                          m.value === "store_credit" ||
                          m.value === "loyalty_points"))
                    }
                  >
                    {t(m.labelKey, { defaultValue: m.label })}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("payment:removeRowAria", {
                  defaultValue: "Remove {{method}} row",
                  method: methodLabel(payment.method),
                })}
                disabled={payments.length <= 1}
                onClick={() => removeRow(index)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <Controller
                name={`payments.${index}.amount`}
                control={form.control}
                render={({ field }) => (
                  <Input
                    id={field.name}
                    type="number"
                    aria-label={t("payment:methodAmountAria", {
                      defaultValue: "{{method}} amount",
                      method: methodLabel(payment.method),
                    })}
                    {...field}
                    value={field.value ?? ""}
                    disabled={isDue && customerId == null}
                    onChange={(e) => field.onChange(toNum(e))}
                    placeholder="0.00"
                  />
                )}
              />
              <Button
                type="button"
                variant="outline"
                disabled={isDue && customerId == null}
                onClick={() => fill(index)}
              >
                {t("payment:fill", { defaultValue: "Fill" })}
              </Button>
            </div>
            {needsReference && (
              <Controller
                name={`payments.${index}.reference`}
                control={form.control}
                render={({ field }) => (
                  <Input
                    {...field}
                    className="mt-2"
                    id={field.name}
                    value={field.value ?? ""}
                    type="text"
                    placeholder={
                      payment.method === "gift_card"
                        ? t("payment:fullGiftCardCode", {
                            defaultValue: "Full gift card code",
                          })
                        : t("payment:referencePlaceholder", {
                            defaultValue: "Transaction ID (6+ chars)",
                          })
                    }
                  />
                )}
              />
            )}
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        onClick={addRow}
        disabled={payments.length >= SPLIT_METHODS.length}
      >
        {t("payment:addMethod", { defaultValue: "+ Add payment method" })}
      </Button>

      {creditShort && (
        <span className="text-sm text-destructive">
          {tender.creditAvailable != null
            ? t("payment:creditShortWith", {
                defaultValue:
                  "Due ৳{{due}} exceeds the customer's available credit (৳{{available}}).",
                due: dueAmount.toFixed(2),
                available: tender.creditAvailable.toFixed(2),
              })
            : t("payment:creditShortWithout", {
                defaultValue:
                  "Due ৳{{due}} exceeds the customer's available credit.",
                due: dueAmount.toFixed(2),
              })}
        </span>
      )}

      <Card>
        <CardContent className="flex flex-col gap-1 py-4">
          {payments.map((payment, index) => (
            <div key={index} className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {methodLabel(payment.method)}
              </span>
              <span className="font-medium tabular-nums">
                {formatCurrency(money(payment.amount))}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}

// ---------- due ----------
function Due({
  finalTotal,
  form,
  tender,
}: {
  finalTotal: number;
  form: UseFormReturn<CartSchemaType>;
  tender: TenderBalances;
}) {
  const { t } = useTranslation();
  const customerId = useWatch({ control: form.control, name: "customerId" });
  const customers = useCustomersQuery().data ?? EMPTY_CUSTOMER_LIST;
  const customer = customers.find((c) => c.id === customerId);
  // P3 Phase 1 (F2): display-only credit context — the backend rejects a due
  // over the limit with 409 and the message surfaces verbatim.
  const overLimit =
    tender.creditLimit != null &&
    tender.creditAvailable != null &&
    finalTotal > tender.creditAvailable + 0.005;

  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 py-4">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("payment:recordingAsDue", { defaultValue: "Recording as due (baki)" })}
        </span>
        <p className="text-sm">
          {t("payment:dueAddBefore", {
            defaultValue: "{{total}} will be added to",
            total: formatCurrency(finalTotal),
          })}{" "}
          <span className="font-medium">
            {customer?.name ?? t("payment:dueUnnamedCustomer", {
              defaultValue: "this customer's",
            })}
          </span>{" "}
          {t("payment:dueAddAfter", { defaultValue: "outstanding balance." })}
        </p>
        <span className="text-sm text-muted-foreground">
          {t("payment:duePhone", {
            defaultValue: "Phone: {{phone}}",
            phone: customer?.phone ?? "N/A",
          })}
        </span>
        {tender.creditLimit != null && (
          <span
            className={cn(
              "text-sm font-medium",
              overLimit ? "text-destructive" : "text-success",
            )}
          >
            {t("payment:dueCreditAvailable", {
              defaultValue: "Credit available: {{available}} / {{limit}}",
              available: formatCurrency(
                Math.max(0, tender.creditAvailable ?? 0),
              ),
              limit: formatCurrency(tender.creditLimit),
            })}
          </span>
        )}
        {overLimit && (
          <span className="text-sm text-destructive">
            {t("payment:dueOverLimit", {
              defaultValue:
                "This due exceeds the customer's credit limit and will be rejected.",
            })}
          </span>
        )}
      </CardContent>
    </Card>
  );
}