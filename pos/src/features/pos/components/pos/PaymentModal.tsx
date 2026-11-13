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
    case "split":
      return [
        { method: "cash", amount: undefined },
        { method: "bangla_qr", amount: undefined, reference: "" },
        { method: "due", amount: undefined },
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
}

const EMPTY_TENDER: TenderBalances = {
  storeCredit: null,
  loyaltyBalance: null,
  loyaltyConfig: null,
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
    const [cash, digital, due] = payments;
    const sum =
      money(cash?.amount) + money(digital?.amount) + money(due?.amount);
    if (money(sum) !== money(finalTotal)) return false;
    if (
      money(digital?.amount) > 0 &&
      (digital?.reference ?? "").trim().length < 6
    )
      return false;
    if (money(due?.amount) > 0 && customerId == null) return false;
    return true;
  }
  return false;
}

// number input -> undefined when empty
const toNum = (e: React.ChangeEvent<HTMLInputElement, HTMLInputElement>) =>
  e.target.value === "" ? undefined : Number(e.target.value);

// ---------- main modal ----------
export function PaymentModal({
  subTotal,
  vat,
  form,
  isPaymentDialogOpen,
  setIsPaymentDialogOpen,
}: {
  subTotal: number;
  vat: number;
  form: UseFormReturn<CartSchemaType>;
  isPaymentDialogOpen: boolean;
  setIsPaymentDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const cart = useCartStore((state) => state.cart);
  const finalTotal = money(subTotal + vat);

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
            <span>Charge customer</span>
            <span>৳{finalTotal.toFixed(2)}</span>
          </Button>
        }
      />
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Payment</DialogTitle>
          <DialogDescription>
            Total Due : {finalTotal.toFixed(2)}
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
              />
            )}
            {mode === "due" && <Due form={form} finalTotal={finalTotal} />}
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
    { label: "Cash", value: "cash" },
    { label: "Bangla QR", value: "bangla_qr" },
    { label: "Card", value: "card" },
    { label: "Store credit", value: "store_credit" },
    { label: "Loyalty points", value: "loyalty_points" },
    { label: "Gift card", value: "gift_card" },
    { label: "Due", value: "due" },
    { label: "Split", value: "split" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <span>Select method</span>
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
            className="col-span-1 data-pressed:bg-primary data-pressed:text-primary-foreground"
          >
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

      <div className="flex flex-wrap gap-3">
        {shortcuts.map((s) => (
          <Button
            key={s.label}
            type="button"
            variant="outline"
            size="lg"
            onClick={() => form.setValue("payments.0.tendered", s.value)}
          >
            {s.label}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className="flex flex-col items-center gap-1">
          <span className="text-sm text-muted-foreground">
            {isOwed ? "Still owed" : "Change to Give"}
          </span>
          <span
            className={`text-xl font-bold ${isOwed ? "text-red-500" : "text-green-500"}`}
          >
            {(isOwed ? owed : change).toFixed(2)}
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
        <CardContent className="flex flex-col">
          <span>Send To</span>
          <span>{paymentInstruction}</span>
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

      <Card>
        <CardContent className="flex flex-col">
          <span>Amount to charge digitally:</span>
          <span>{finalTotal.toFixed(2)}</span>
        </CardContent>
      </Card>
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
      <CardContent className="flex flex-col gap-1">
        <span>Store credit</span>
        <span>
          Available:{" "}
          {available === null ? "checking…" : `৳${available.toFixed(2)}`}
        </span>
        <span>Amount applied: ৳{finalTotal.toFixed(2)}</span>
        {issue && (
          <span className="text-sm text-red-500">{issue}</span>
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
      <CardContent className="flex flex-col gap-1">
        <span>Loyalty points</span>
        <span>
          Balance:{" "}
          {balance === null ? "checking…" : `${balance.toFixed(2)} points`}
        </span>
        {points !== null && (
          <span>
            Redeems ৳{finalTotal.toFixed(2)} for {points.toFixed(2)} points
            {config ? ` (৳${config.redeemValue} per point)` : ""}
          </span>
        )}
        {config && config.maxRedemptionPointsPerSale !== null && (
          <span className="text-xs text-muted-foreground">
            Max {config.maxRedemptionPointsPerSale} points per sale
          </span>
        )}
        {issue && (
          <span className="text-sm text-red-500">{issue}</span>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- split ----------
// payments.0 = cash, payments.1 = digital, payments.2 = due
function SplitPayment({
  form,
  finalTotal,
  customerId,
}: {
  form: UseFormReturn<CartSchemaType>;
  finalTotal: number;
  customerId: number | null;
}) {
  const payments = useWatch({ control: form.control, name: "payments" });
  const cash = money(payments?.[0]?.amount);
  const digital = money(payments?.[1]?.amount);
  const due = money(payments?.[2]?.amount);
  const remaining = money(finalTotal - cash - digital - due);

  // Put whatever is still unpaid into the given row
  const fill = (index: number) => {
    const current = money(payments?.[index]?.amount);
    const value = Math.max(0, money(current + remaining));
    form.setValue(`payments.${index}.amount`, value);
  };

  return (
    <>
      <Card>
        <CardContent className="flex flex-col">
          <span>Split Payment</span>
          <div className="flex justify-between">
            <span>Total: ৳{finalTotal.toFixed(2)}</span>
            <span
              className={remaining === 0 ? "text-green-500" : "text-red-500"}
            >
              Remaining: ৳{remaining.toFixed(2)}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Cash part */}
      <Controller
        name="payments.0.amount"
        control={form.control}
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor={field.name}>Cash Part</FieldLabel>
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

      {/* Digital method */}
      <div className="flex flex-col gap-3">
        <span>Digital method</span>
        <Controller
          name="payments.1.method"
          control={form.control}
          render={({ field }) => (
            <ToggleGroup
              value={field.value ? [field.value] : []}
              onValueChange={(value: string[]) => {
                if (value[0]) field.onChange(value[0]); // keep one always selected
              }}
              size="lg"
              variant="outline"
              className="grid grid-cols-2 max-h-50"
            >
              <ToggleGroupItem value="bangla_qr">Bangla QR</ToggleGroupItem>
              <ToggleGroupItem value="card">Card</ToggleGroupItem>
            </ToggleGroup>
          )}
        />
      </div>

      {/* Digital part */}
      <Controller
        name="payments.1.amount"
        control={form.control}
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor={field.name}>Digital part</FieldLabel>
            <div className="flex items-center gap-3">
              <Input
                id={field.name}
                type="number"
                {...field}
                value={field.value ?? ""}
                onChange={(e) => field.onChange(toNum(e))}
                placeholder="0.00"
              />
              <Button type="button" onClick={() => fill(1)}>
                Fill digital
              </Button>
            </div>
          </Field>
        )}
      />

      <Controller
        name="payments.1.reference"
        control={form.control}
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor={field.name}>
              Transaction ID (required if digital part)
            </FieldLabel>
            <Input
              {...field}
              id={field.name}
              value={field.value ?? ""}
              type="text"
              placeholder="for the digital part"
            />
          </Field>
        )}
      />

      {/* Due part (only with a customer) */}
      <Controller
        name="payments.2.amount"
        control={form.control}
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor={field.name}>Due part</FieldLabel>
            <div className="flex items-center gap-3">
              <Input
                id={field.name}
                type="number"
                {...field}
                value={field.value ?? ""}
                disabled={customerId == null}
                onChange={(e) => field.onChange(toNum(e))}
                placeholder="0.00"
              />
              <Button
                type="button"
                disabled={customerId == null}
                onClick={() => fill(2)}
              >
                Fill Due
              </Button>
            </div>
          </Field>
        )}
      />

      <Card>
        <CardContent className="flex flex-col">
          <div className="flex justify-between">
            <span>Cash</span>
            <span>৳{cash.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span>
              {payments?.[1]?.method === "card" ? "Card" : "Bangla QR"}
            </span>
            <span>৳{digital.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span>Due</span>
            <span>৳{due.toFixed(2)}</span>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

// ---------- due ----------
function Due({
  finalTotal,
  form,
}: {
  finalTotal: number;
  form: UseFormReturn<CartSchemaType>;
}) {
  const customerId = useWatch({ control: form.control, name: "customerId" });
  const { customers } = useCustomerStore();
  const customer = customers.find((c) => c.id === customerId);

  return (
    <Card>
      <CardContent>
        <DialogHeader>
          <DialogTitle>Recording as Due (Baki)</DialogTitle>
          <DialogDescription>
            ৳{finalTotal.toFixed(2)} will be added to{" "}
            {customer?.name ?? "this customer's"} outstanding balance.
          </DialogDescription>
        </DialogHeader>
        <span>Customer phone: {customer?.phone ?? "N/A"}</span>
      </CardContent>
    </Card>
  );
}
