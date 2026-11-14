import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { useCustomerStore } from "@/store/useCustomerStore";
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

// Bangla QR destination: runtime config (public/config.js) → env → legacy
// default. Was hardcoded; shops have different merchant numbers.
const QR_NUMBER =
  (typeof window !== "undefined" &&
    (window as { ezposConfig?: { qrNumber?: string } }).ezposConfig?.qrNumber) ||
  (import.meta.env.VITE_QR_NUMBER as string | undefined) ||
  "01870707900";

// ---------- helpers ----------
const money = (n: number | undefined) =>
  Math.round((Number(n) || 0) * 100) / 100;

type PaymentMode = PaymentSchemaType["method"] | "split";

// Fresh payments array for each method. This is what removes stale data.
function buildPayments(
  method: PaymentMode,
  finalTotal: number,
): PaymentSchemaType[] {
  switch (method) {
    case "cash":
      return [{ method: "cash", amount: finalTotal, tendered: undefined }];
    case "bangla_qr":
    case "card":
      return [{ method, amount: finalTotal, reference: "" }];
    case "store_credit":
      return [{ method: "store_credit", amount: finalTotal }];
    case "loyalty_points":
      return [{ method: "loyalty_points", amount: finalTotal }];
    case "gift_card":
      return [{ method: "gift_card", amount: finalTotal, reference: "" }];
    case "due":
      return [{ method: "due", amount: finalTotal }];
    // P3 Phase 1 (F5): split is now an arbitrary ordered list of tender rows
    // over ALL backend methods — the old fixed cash+bangla_qr+due trio is
    // gone. Seeded with cash + Bangla QR; rows are added/removed/switched in
    // the builder.
    case "split":
      return [
        { method: "cash", amount: undefined },
        { method: "bangla_qr", amount: undefined, reference: "" },
      ];
    default:
      return [];
  }
}

// Which UI mode are we in? (split = 3 rows, otherwise 1 row)
function getMode(payments: PaymentSchemaType[] = []) {
  return payments.length > 1 ? "split" : payments[0]?.method;
}

// ---------- balance tenders (store credit / loyalty points) ----------
// The backend is authoritative: it re-checks the customer, the caps and the
// row-locked balance inside the sale transaction. These checks exist so the
// Confirm button reflects reality BEFORE the cashier commits — a rejected
// redemption aborts the whole sale.

interface LoyaltyPosConfig {
  redeemValue: number;
  earnRate: number;
  minRedemptionPoints: number;
  maxRedemptionPointsPerSale: number | null;
}

interface TenderBalances {
  /** Currency balance, null = unknown (loading / fetch failed). */
  storeCredit: number | null;
  /** Points balance, null = unknown (loading / fetch failed). */
  loyaltyBalance: number | null;
  /** POS redemption config, null = program inactive / not readable. */
  loyaltyConfig: LoyaltyPosConfig | null;
  /** P3 Phase 1 (F2): credit-limit context (null limit = unlimited). */
  creditLimit: number | null;
  creditAvailable: number | null;
}

const EMPTY_TENDER: TenderBalances = {
  storeCredit: null,
  loyaltyBalance: null,
  loyaltyConfig: null,
  creditLimit: null,
  creditAvailable: null,
};

/** Balance-tender data for the selected customer (fetched while open). */
function useTenderBalances(
  customerId: number | null,
  open: boolean,
): TenderBalances {
  const [tender, setTender] = useState<TenderBalances>(EMPTY_TENDER);

  useEffect(() => {
    if (!open || customerId == null || customerId <= 0) {
      setTender(EMPTY_TENDER);
      return;
    }
    let ignore = false;
    const apply = (patch: Partial<TenderBalances>) =>
      setTender((current) => ({ ...current, ...patch }));
    // Balance unknown while loading — the Confirm button stays disabled
    // until the real numbers arrive (never guess a balance).
    axios
      .get(`/customers/${customerId}/store-credit`)
      .then((res) => {
        if (!ignore)
          apply({ storeCredit: Number(res.data?.data?.balance ?? 0) });
      })
      .catch(() => {
        if (!ignore) apply({ storeCredit: null });
      });
    axios
      .get(`/customers/${customerId}/loyalty`)
      .then((res) => {
        if (!ignore)
          apply({ loyaltyBalance: Number(res.data?.data?.balance ?? 0) });
      })
      .catch(() => {
        if (!ignore) apply({ loyaltyBalance: null });
      });
    axios
      .get("/loyalty/config")
      .then((res) => {
        if (!ignore) apply({ loyaltyConfig: res.data?.data ?? null });
      })
      .catch(() => {
        if (!ignore) apply({ loyaltyConfig: null });
      });
    // P3 Phase 1 (F2): credit-limit context for the due tender (display only
    // — the backend re-checks authoritatively inside the sale transaction).
    axios
      .get(`/customers/${customerId}/credit-summary`)
      .then((res) => {
        if (!ignore)
          apply({
            creditLimit: res.data?.data?.creditLimit ?? null,
            creditAvailable: res.data?.data?.available ?? null,
          });
      })
      .catch(() => {
        if (!ignore) apply({ creditLimit: null, creditAvailable: null });
      });
    return () => {
      ignore = true;
    };
  }, [customerId, open]);

  return tender;
}

/** Why the store-credit tender cannot be confirmed right now (null = valid). */
function storeCreditIssue(
  amount: number,
  customerId: number | null,
  tender: TenderBalances,
): string | null {
  if (customerId == null || customerId <= 0)
    return "Select a customer to pay with store credit.";
  if (!(amount > 0)) return "Nothing to pay.";
  if (tender.storeCredit === null)
    return "Store credit balance unavailable — check the connection.";
  if (amount > tender.storeCredit + 0.005)
    return `Insufficient store credit — ৳${(amount - tender.storeCredit).toFixed(2)} short.`;
  return null;
}

/** Why the loyalty tender cannot be confirmed right now (null = valid). */
function loyaltyIssue(
  amount: number,
  customerId: number | null,
  tender: TenderBalances,
): string | null {
  if (customerId == null || customerId <= 0)
    return "Select a customer to pay with points.";
  const config = tender.loyaltyConfig;
  if (!config || !(config.redeemValue > 0))
    return "Loyalty redemption is not available for this business.";
  const points = money(amount / config.redeemValue);
  if (points <= 0) return "This total converts to zero points.";
  if (
    config.maxRedemptionPointsPerSale !== null &&
    points > config.maxRedemptionPointsPerSale
  )
    return `Capped at ${config.maxRedemptionPointsPerSale} points per sale (needs ${points.toFixed(2)}).`;
  if (config.minRedemptionPoints > 0 && points < config.minRedemptionPoints)
    return `Redemption needs at least ${config.minRedemptionPoints} points (this is ${points.toFixed(2)}).`;
  if (tender.loyaltyBalance === null)
    return "Points balance unavailable — check the connection.";
  if (points > tender.loyaltyBalance + 0.01)
    return `Insufficient points — balance ${tender.loyaltyBalance.toFixed(2)}, needs ${points.toFixed(2)}.`;
  return null;
}

function isPaymentValid(
  payments: PaymentSchemaType[],
  finalTotal: number,
  customerId: number | null,
  tender: TenderBalances,
) {
  const mode = getMode(payments);
  const p0 = payments?.[0];

  if (mode === "cash") return money(p0?.tendered) >= finalTotal;

  if (mode === "bangla_qr" || mode === "card")
    return (p0?.reference ?? "").trim().length >= 6;

  if (mode === "gift_card") return (p0?.reference ?? "").trim().length >= 8;

  if (mode === "due") return customerId != null;

  if (mode === "store_credit")
    return storeCreditIssue(money(p0?.amount ?? 0), customerId, tender) === null;

  if (mode === "loyalty_points")
    return loyaltyIssue(money(p0?.amount ?? 0), customerId, tender) === null;

  if (mode === "split") {
    // P3 Phase 1 (F5): arbitrary tender rows — every row must be individually
    // valid and the rows must sum to exactly the quoted total. Distinct
    // methods stay enforced (UI prevents duplicates; the backend rejects
    // them authoritatively).
    const sum = money(
      payments.reduce((acc, p) => acc + money(p?.amount), 0),
    );
    if (money(sum) !== money(finalTotal)) return false;
    for (const p of payments) {
      const amount = money(p?.amount);
      if (
        (p?.method === "bangla_qr" || p?.method === "card") &&
        amount > 0 &&
        (p?.reference ?? "").trim().length < 6
      )
        return false;
      if (p?.method === "gift_card" && amount > 0 && (p?.reference ?? "").trim().length < 8)
        return false;
      if (p?.method === "due" && amount > 0 && customerId == null) return false;
      if (
        p?.method === "store_credit" &&
        amount > 0 &&
        storeCreditIssue(amount, customerId, tender) !== null
      )
        return false;
      if (
        p?.method === "loyalty_points" &&
        amount > 0 &&
        loyaltyIssue(amount, customerId, tender) !== null
      )
        return false;
    }
    return true;
  }
  return false;
}

// number input -> undefined when empty
const toNum = (e: React.ChangeEvent<HTMLInputElement, HTMLInputElement>) =>
  e.target.value === "" ? undefined : Number(e.target.value);

// ---------- main modal ----------
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
              Charge customer
              <Kbd keys={["F6"]} className="opacity-70" />
            </span>
            <span className="tabular-nums">{formatCurrency(finalTotal)}</span>
          </Button>
        }
      />
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Payment</DialogTitle>
          <DialogDescription className="text-base font-semibold text-foreground">
            Total due: <span className="tabular-nums">{formatCurrency(finalTotal)}</span>
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
                paymentInstruction={`Bangla QR: ${QR_NUMBER}`}
              />
            )}
            {mode === "card" && (
              <DigitalCashPayment
                finalTotal={finalTotal}
                form={form}
                paymentInstruction="Insert / tap card on POS terminal"
              />
            )}
            {mode === "gift_card" && (
              <DigitalCashPayment
                finalTotal={finalTotal}
                form={form}
                paymentInstruction="Enter the customer's gift card code"
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
                Cancel
              </Button>
            }
          />
          <Button
            form="cart-form"
            type="submit"
            disabled={!valid || isSubmitting}
          >
            Confirm Payment
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
  const options = [
    { label: "Cash", value: "cash", icon: Banknote },
    { label: "Bangla QR", value: "bangla_qr", icon: QrCode },
    { label: "Card", value: "card", icon: CreditCard },
    { label: "Store credit", value: "store_credit", icon: Wallet },
    { label: "Loyalty points", value: "loyalty_points", icon: Coins },
    { label: "Gift card", value: "gift_card", icon: Gift },
    { label: "Due", value: "due", icon: Clock3 },
    { label: "Split", value: "split", icon: Layers },
  ];

  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium">Select method</span>
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
            {m.label}
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
    { label: "Exact", value: finalTotal },
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
            <FieldLabel htmlFor={field.name}>Cash Receive</FieldLabel>
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
            {isOwed ? "Still owed" : "Change to give"}
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
}: {
  paymentInstruction: string;
  finalTotal: number;
  form: UseFormReturn<CartSchemaType>;
}) {
  // amount is already set to finalTotal by buildPayments, no useEffect needed
  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-1 py-4">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {paymentInstruction.startsWith("Bangla QR") ? "Send to" : "Instruction"}
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
              Transaction ID (last 6+ chars)
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
          Amount to charge
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
  const issue = storeCreditIssue(finalTotal, customerId, tender);
  const available = tender.storeCredit;

  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 py-4">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Store credit
        </span>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Available</span>
          <span className="font-medium tabular-nums">
            {available === null ? "checking…" : formatCurrency(available)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Amount applied</span>
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
          Loyalty points
        </span>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Balance</span>
          <span className="font-medium tabular-nums">
            {balance === null ? "checking…" : formatNumber(balance)}
          </span>
        </div>
        {points !== null && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Redeems {formatCurrency(finalTotal)}
              {config ? ` (৳${config.redeemValue}/point)` : ""}
            </span>
            <span className="font-semibold tabular-nums">
              {formatNumber(points)} pts
            </span>
          </div>
        )}
        {config && config.maxRedemptionPointsPerSale !== null && (
          <span className="text-xs text-muted-foreground">
            Max {formatNumber(config.maxRedemptionPointsPerSale)} points per sale
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
const SPLIT_METHODS: { value: PaymentSchemaType["method"]; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "bangla_qr", label: "Bangla QR" },
  { value: "card", label: "Card" },
  { value: "store_credit", label: "Store credit" },
  { value: "loyalty_points", label: "Loyalty points" },
  { value: "gift_card", label: "Gift card" },
  { value: "due", label: "Due" },
];

function methodLabel(method: string | undefined): string {
  return SPLIT_METHODS.find((m) => m.value === method)?.label ?? method ?? "";
}

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
            Split payment
          </span>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Total</span>
            <span className="font-medium tabular-nums">
              {formatCurrency(finalTotal)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Remaining</span>
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
                aria-label={`Tender method ${index + 1}`}
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
                    {m.label}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${methodLabel(payment.method)} row`}
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
                    aria-label={`${methodLabel(payment.method)} amount`}
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
                Fill
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
                        ? "Full gift card code"
                        : "Transaction ID (6+ chars)"
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
        + Add payment method
      </Button>

      {creditShort && (
        <span className="text-sm text-destructive">
          Due ৳{dueAmount.toFixed(2)} exceeds the customer's available credit
          {tender.creditAvailable != null
            ? ` (৳${tender.creditAvailable.toFixed(2)})`
            : ""}
          .
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
  const customerId = useWatch({ control: form.control, name: "customerId" });
  const { customers } = useCustomerStore();
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
          Recording as due (baki)
        </span>
        <p className="text-sm">
          {formatCurrency(finalTotal)} will be added to{" "}
          <span className="font-medium">
            {customer?.name ?? "this customer's"}
          </span>{" "}
          outstanding balance.
        </p>
        <span className="text-sm text-muted-foreground">
          Phone: {customer?.phone ?? "N/A"}
        </span>
        {tender.creditLimit != null && (
          <span
            className={cn(
              "text-sm font-medium",
              overLimit ? "text-destructive" : "text-success",
            )}
          >
            Credit available: {formatCurrency(Math.max(0, tender.creditAvailable ?? 0))}{" "}
            / {formatCurrency(tender.creditLimit)}
          </span>
        )}
        {overLimit && (
          <span className="text-sm text-destructive">
            This due exceeds the customer's credit limit and will be rejected.
          </span>
        )}
      </CardContent>
    </Card>
  );
}
