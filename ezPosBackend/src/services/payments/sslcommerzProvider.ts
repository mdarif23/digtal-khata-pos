import { env } from "../../config/env.js";
import type {
  GatewaySession,
  GatewaySessionInput,
  PaymentProvider,
  VerificationInput,
  VerificationResult,
} from "./provider.js";

/**
 * SSLCommerz payment provider (session-based checkout + server-side
 * validation). No official Node SDK exists — a small direct HTTPS client
 * keeps the provider self-contained.
 *
 * Security model:
 * - Session init happens server-side with the store credentials; the browser
 *   only ever receives the GatewayPageURL.
 * - Activation NEVER happens because of a redirect. Every payment is
 *   verified server-side against the validator API using val_id — via the
 *   IPN callback and/or the verify endpoint after the success redirect.
 * - Amounts reported by the gateway are compared against the server-stored
 *   amount before anything is marked paid.
 */

export interface SslcommerzCredentials {
  storeId: string;
  storePassword: string;
  sandbox: boolean;
}

function baseUrl(sandbox: boolean): string {
  return sandbox
    ? "https://sandbox.sslcommerz.com"
    : "https://securepay.sslcommerz.com";
}

function assertConfigured(creds: SslcommerzCredentials): void {
  if (!creds.storeId || !creds.storePassword) {
    throw new Error(
      "SSLCommerz requires a store id and password (payment provider config).",
    );
  }
}

interface InitResponse {
  status?: string;
  failedreason?: string;
  GatewayPageURL?: string;
  sessionkey?: string;
}

interface ValidationResponse {
  status?: string;
  tran_id?: string;
  val_id?: string;
  amount?: string | number;
  currency?: string;
  card_type?: string;
}

/**
 * Builds a provider bound to one merchant's credentials. The platform-level
 * subscription gateway uses the env-config singleton below; sale payments
 * construct one per business from payment_provider_configs.
 */
export function sslcommerzProviderFor(
  creds: SslcommerzCredentials,
): PaymentProvider {
  return {
    name: "sslcommerz",

    async initiateSession(input: GatewaySessionInput): Promise<GatewaySession> {
      assertConfigured(creds);
      const form = new URLSearchParams({
        store_id: creds.storeId,
        store_passwd: creds.storePassword,
        total_amount: input.amount.toFixed(2),
        currency: input.currency,
        tran_id: input.tranId,
        success_url: input.urls.success,
        fail_url: input.urls.fail,
        cancel_url: input.urls.cancel,
        ipn_url: input.ipnUrl,
        shipping_method: "No",
        product_name: input.description.slice(0, 250),
        product_category: "Software",
        product_profile: "general",
        cus_name: input.customer.name.slice(0, 250),
        cus_email: input.customer.email,
        ...(input.customer.phone
          ? { cus_phone: input.customer.phone.slice(0, 50) }
          : { cus_phone: "N/A" }),
        cus_add1: "N/A",
        cus_city: "N/A",
        cus_country: "Bangladesh",
        value_a: input.tranId,
      });

      const response = await fetch(
        `${baseUrl(creds.sandbox)}/gwprocess/v4/api.php`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        },
      );
      const body = (await response
        .json()
        .catch(() => null)) as InitResponse | null;
      if (!body || body.status !== "SUCCESS" || !body.GatewayPageURL) {
        throw new Error(
          `SSLCommerz session init failed: ${body?.failedreason ?? `HTTP ${response.status}`}`,
        );
      }
      return {
        gatewayUrl: body.GatewayPageURL,
        sessionId: body.sessionkey ?? "",
      };
    },

    async verifyPayment(
      input: VerificationInput,
    ): Promise<VerificationResult> {
      assertConfigured(creds);
      const url = new URL(
        `${baseUrl(creds.sandbox)}/validator/api/validationserverAPI.php`,
      );
      url.searchParams.set("val_id", input.valId);
      url.searchParams.set("store_id", creds.storeId);
      url.searchParams.set("store_passwd", creds.storePassword);
      url.searchParams.set("format", "json");

      const response = await fetch(url, { method: "GET" });
      const body = (await response.json().catch(() => null)) as
        | ValidationResponse
        | ValidationResponse[]
        | null;
      // The validator returns an object for a single val_id (an array only
      // for batch requests).
      const result = Array.isArray(body) ? body[0] : body;
      if (!result) {
        return {
          valid: false,
          status: "UNREACHABLE",
          amount: null,
          currency: null,
          transactionId: null,
          raw: {},
        };
      }
      const valid =
        result.status === "VALIDATED" ||
        result.status === "VALID" ||
        result.status === "COMPLETED";
      return {
        valid,
        status: result.status ?? "UNKNOWN",
        amount: result.amount !== undefined ? Number(result.amount) : null,
        currency: result.currency ?? null,
        transactionId: result.val_id ?? null,
        raw: result as Record<string, unknown>,
      };
    },
  };
}

/** Platform-level subscription gateway, configured via environment. */
export const sslcommerzProvider: PaymentProvider = sslcommerzProviderFor({
  storeId: env.sslcommerzStoreId,
  storePassword: env.sslcommerzStorePassword,
  sandbox: env.sslcommerzSandbox,
});
