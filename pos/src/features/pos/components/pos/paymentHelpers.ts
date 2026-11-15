import type { CartSchemaType, PaymentSchemaType } from "../../schemas/cart.schema.js";
import type { InputValue } from "@/types/customers.types.js";

/**
 * Pure payment-modal helpers (Phase 6 Feature 2, extracted verbatim from
 * PaymentModal.tsx): the Bangla QR destination, money rounding, the tender
 * array builders and shared balance types. No behavior change.
 */

// Bangla QR destination: runtime config (public/config.js) → env → legacy
// default. Was hardcoded; shops have different merchant numbers.
export const QR_NUMBER =
  (typeof window !== "undefined" &&
    (window as { ezposConfig?: { qrNumber?: string } }).ezposConfig?.qrNumber) ||
  (import.meta.env.VITE_QR_NUMBER as string | undefined) ||
  "01870707900";

export const EMPTY_CUSTOMER_LIST: InputValue[] = [];

// ---------- helpers ----------
export const money = (n: number | undefined) =>
  Math.round((Number(n) || 0) * 100) / 100;

export type PaymentMode = PaymentSchemaType["method"] | "split";

// Fresh payments array for each method. This is what removes stale data.
export function buildPayments(
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
export function getMode(payments: PaymentSchemaType[] = []) {
  return payments.length > 1 ? "split" : payments[0]?.method;
}

// ---------- balance tenders (store credit / loyalty points) ----------
// The backend is authoritative: it re-checks the customer, the caps and the
// row-locked balance inside the sale transaction. These checks exist so the
// Confirm button reflects reality BEFORE the cashier commits — a rejected
// redemption aborts the whole sale.

export interface LoyaltyPosConfig {
  redeemValue: number;
  earnRate: number;
  minRedemptionPoints: number;
  maxRedemptionPointsPerSale: number | null;
}

export interface TenderBalances {
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

export const EMPTY_TENDER: TenderBalances = {
  storeCredit: null,
  loyaltyBalance: null,
  loyaltyConfig: null,
  creditLimit: null,
  creditAvailable: null,
};

export const toNum = (e: React.ChangeEvent<HTMLInputElement, HTMLInputElement>) =>
  e.target.value === "" ? undefined : Number(e.target.value);

