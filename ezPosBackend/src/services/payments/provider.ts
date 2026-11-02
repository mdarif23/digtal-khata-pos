/**
 * Payment-provider abstraction. The subscription/business logic never talks
 * to a gateway directly — it goes through this interface, so additional
 * providers (bKash, Nagad) slot in without touching the flow.
 */

export interface GatewaySessionInput {
  /** Unique transaction id for the gateway — our payment idempotency key. */
  tranId: string;
  amount: number;
  currency: string;
  customer: { name: string; email: string; phone?: string | null };
  description: string;
  /** Browser redirect targets (website pages, NOT activation logic). */
  urls: { success: string; fail: string; cancel: string };
  /** Server-to-server callback (IPN) the gateway posts payment results to. */
  ipnUrl: string;
}

export interface GatewaySession {
  /** Where to send the customer's browser. */
  gatewayUrl: string;
  /** Provider session reference, stored for reconciliation. */
  sessionId: string;
}

export interface VerificationInput {
  /** Provider's validation id (val_id for SSLCommerz), from the IPN or the
   * success redirect's query — verified SERVER-side either way. */
  valId: string;
}

export interface VerificationResult {
  valid: boolean;
  status: string;
  /** Gateway-reported amount; compared against our stored amount when present. */
  amount: number | null;
  currency: string | null;
  transactionId: string | null;
  raw: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly name: string;
  initiateSession(input: GatewaySessionInput): Promise<GatewaySession>;
  verifyPayment(input: VerificationInput): Promise<VerificationResult>;
}
