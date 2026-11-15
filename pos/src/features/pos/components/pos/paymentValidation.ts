import i18next from "i18next";
import "@/i18n/index.js";
import { getMode, money, type TenderBalances } from "./paymentHelpers.js";
import type { PaymentSchemaType } from "../../schemas/cart.schema.js";

/**
 * Payment validation (Phase 6 Feature 2, extracted verbatim from
 * PaymentModal.tsx). The factories translate at call time (i18next.t);
 * isPaymentValid only null-checks their results. No behavior change.
 */

export function storeCreditIssue(
  amount: number,
  customerId: number | null,
  tender: TenderBalances,
): string | null {
  if (customerId == null || customerId <= 0)
    return i18next.t("payment:storeCredit.noCustomer", {
      defaultValue: "Select a customer to pay with store credit.",
    });
  if (!(amount > 0))
    return i18next.t("payment:storeCredit.nothing", { defaultValue: "Nothing to pay." });
  if (tender.storeCredit === null)
    return i18next.t("payment:storeCredit.balanceUnavailable", {
      defaultValue: "Store credit balance unavailable — check the connection.",
    });
  if (amount > tender.storeCredit + 0.005)
    return i18next.t("payment:storeCredit.insufficient", {
      defaultValue: "Insufficient store credit — ৳{{short}} short.",
      short: (amount - tender.storeCredit).toFixed(2),
    });
  return null;
}

/** Why the loyalty tender cannot be confirmed right now (null = valid). */
export function loyaltyIssue(
  amount: number,
  customerId: number | null,
  tender: TenderBalances,
): string | null {
  if (customerId == null || customerId <= 0)
    return i18next.t("payment:loyalty.noCustomer", {
      defaultValue: "Select a customer to pay with points.",
    });
  const config = tender.loyaltyConfig;
  if (!config || !(config.redeemValue > 0))
    return i18next.t("payment:loyalty.unavailable", {
      defaultValue: "Loyalty redemption is not available for this business.",
    });
  const points = money(amount / config.redeemValue);
  if (points <= 0)
    return i18next.t("payment:loyalty.zeroPoints", {
      defaultValue: "This total converts to zero points.",
    });
  if (
    config.maxRedemptionPointsPerSale !== null &&
    points > config.maxRedemptionPointsPerSale
  )
    return i18next.t("payment:loyalty.capped", {
      defaultValue:
        "Capped at {{max}} points per sale (needs {{points}}).",
      max: config.maxRedemptionPointsPerSale,
      points: points.toFixed(2),
    });
  if (config.minRedemptionPoints > 0 && points < config.minRedemptionPoints)
    return i18next.t("payment:loyalty.min", {
      defaultValue:
        "Redemption needs at least {{min}} points (this is {{points}}).",
      min: config.minRedemptionPoints,
      points: points.toFixed(2),
    });
  if (tender.loyaltyBalance === null)
    return i18next.t("payment:loyalty.balanceUnavailable", {
      defaultValue: "Points balance unavailable — check the connection.",
    });
  if (points > tender.loyaltyBalance + 0.01)
    return i18next.t("payment:loyalty.insufficient", {
      defaultValue: "Insufficient points — balance {{balance}}, needs {{points}}.",
      balance: tender.loyaltyBalance.toFixed(2),
      points: points.toFixed(2),
    });
  return null;
}

export function isPaymentValid(
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

