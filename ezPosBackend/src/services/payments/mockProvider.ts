import type {
  GatewaySession,
  GatewaySessionInput,
  PaymentProvider,
  VerificationInput,
  VerificationResult,
} from "./provider.js";

/**
 * Mock gateway for development and tests. Deterministic val_id contract:
 *   "MOCK-VALID"             → valid, no amount reported
 *   "MOCK-VALID-<amount>"    → valid, reports the given amount
 *   anything else            → invalid
 * The sessions it issues redirect to the website's /payment pages — the
 * same flow as a real gateway, minus real money. NEVER selected in
 * production (startup guard in config/env.ts).
 */
export const mockProvider: PaymentProvider = {
  name: "mock",
  supportsRefund: true,

  async initiateSession(input: GatewaySessionInput): Promise<GatewaySession> {
    const sessionId = `mock-session-${input.tranId}`;
    // The "gateway" page exists only in dev; tests bypass it and call the
    // verify endpoint directly with a deterministic val_id. The val_id is
    // TRANSACTION-keyed (unique per session) — real gateways issue unique
    // val_ids, and the ledger's reference uniqueness depends on that.
    const base = input.urls.success;
    const sep = base.includes("?") ? "&" : "?";
    const gatewayUrl = `${base}${sep}mock-gateway=1&tran_id=${encodeURIComponent(
      input.tranId,
    )}&val_id=${encodeURIComponent(`MOCK-VALID-T-${input.tranId}-${input.amount}`)}`;
    return { gatewayUrl, sessionId };
  },

  async verifyPayment(input: VerificationInput): Promise<VerificationResult> {
    const valId = input.valId;
    if (valId === "MOCK-VALID") {
      return {
        valid: true,
        status: "VALID",
        amount: null,
        currency: null,
        transactionId: valId,
        raw: { provider: "mock" },
      };
    }
    const amountMatch = /^MOCK-VALID-(\d+(?:\.\d{1,2})?)$/.exec(valId);
    if (amountMatch) {
      return {
        valid: true,
        status: "VALID",
        amount: Number(amountMatch[1]),
        currency: "BDT",
        transactionId: valId,
        raw: { provider: "mock" },
      };
    }
    // Transaction-keyed form issued by initiateSession (unique per order).
    const tranMatch = /^MOCK-VALID-T-(.+)-(\d+(?:\.\d{1,2})?)$/.exec(valId);
    if (tranMatch) {
      return {
        valid: true,
        status: "VALID",
        amount: Number(tranMatch[2]),
        currency: "BDT",
        transactionId: valId,
        raw: { provider: "mock" },
      };
    }
    return {
      valid: false,
      status: "INVALID",
      amount: null,
      currency: null,
      transactionId: valId,
      raw: { provider: "mock" },
    };
  },

  // Deterministic refund: accepted unless the transaction id is the
  // "MOCK-REFUND-REJECT" sentinel, so tests can exercise both outcomes.
  async refundPayment(input) {
    if (input.transactionId === "MOCK-REFUND-REJECT") {
      return { accepted: false, refundId: null, status: "REJECTED", raw: { provider: "mock" } };
    }
    return {
      accepted: true,
      refundId: `mock-refund-${input.transactionId}-${Math.round(input.amount * 100)}`,
      status: "REFUNDED",
      raw: { provider: "mock", amount: input.amount },
    };
  },
};
