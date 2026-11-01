import { and, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { paymentProviderConfigs } from "../../db/schema/paymentProviderConfigs.js";
import { decryptSecret } from "../../utils/encryption.js";
import { BadRequestError } from "../../utils/handleError.js";
import { env } from "../../config/env.js";
import type { PaymentProvider } from "./provider.js";
import { mockProvider } from "./mockProvider.js";
import { sslcommerzProviderFor } from "./sslcommerzProvider.js";

/**
 * Provider resolution for SALE payment intents. Unlike the platform-level
 * subscription gateway (env-selected singleton), sale payments use each
 * business's own merchant account from payment_provider_configs.
 *
 * bKash / Nagad / ShurjoPay are named in the architecture but intentionally
 * NOT implemented: writing calls against their APIs without official
 * documentation access and merchant credentials would be fake
 * implementation. They fail loudly here until real adapters land
 * (POS_GAP_CLOSURE_TRACKER.md, Module 3).
 */

export const SALE_PAYMENT_PROVIDER_NAMES = [
  "mock",
  "sslcommerz",
  // Adapters pending official API docs + merchant credentials:
  "bkash",
  "nagad",
  "shurjopay",
] as const;

export type SalePaymentProviderName = (typeof SALE_PAYMENT_PROVIDER_NAMES)[number];

export interface SaleProviderRuntimeConfig {
  provider: SalePaymentProviderName;
  mode: "sandbox" | "live";
  /** Decrypted credential bag, shape depends on the provider. */
  credentials: Record<string, string>;
}

export function getSalePaymentProvider(
  config: SaleProviderRuntimeConfig,
): PaymentProvider {
  switch (config.provider) {
    case "mock":
      if (env.isProduction) {
        throw new BadRequestError(
          "The mock payment provider is not allowed in production.",
        );
      }
      return mockProvider;
    case "sslcommerz":
      return sslcommerzProviderFor({
        storeId: config.credentials.storeId ?? "",
        storePassword: config.credentials.storePassword ?? "",
        sandbox: config.mode === "sandbox",
      });
    case "bkash":
    case "nagad":
    case "shurjopay":
      throw new BadRequestError(
        `The ${config.provider} adapter is not implemented yet. Configure SSLCommerz or contact support.`,
      );
  }
}

/**
 * Resolves the provider for an intent row: loads the business's enabled
 * config for that provider and decrypts its credentials. Returns null when
 * the config is missing/disabled so callers can decide the fallback
 * (verification must NOT silently fall back to another provider).
 */
export async function resolveIntentProvider(
  businessId: number,
  providerName: string,
): Promise<{ provider: PaymentProvider } | { error: string }> {
  const [config] = await db
    .select({
      provider: paymentProviderConfigs.provider,
      mode: paymentProviderConfigs.mode,
      credentialsEncrypted: paymentProviderConfigs.credentialsEncrypted,
      enabled: paymentProviderConfigs.enabled,
    })
    .from(paymentProviderConfigs)
    .where(
      and(
        eq(paymentProviderConfigs.businessId, businessId),
        eq(paymentProviderConfigs.provider, providerName),
      ),
    )
    .limit(1);

  if (!config || !config.enabled) {
    // The mock provider needs no merchant credentials: it runs without a
    // config row for development and the test harness. getSalePaymentProvider
    // still rejects it in production.
    if (providerName === "mock") {
      return { provider: getSalePaymentProvider({
        provider: "mock",
        mode: "sandbox",
        credentials: {},
      }) };
    }
    return {
      error: `The ${providerName} payment provider is not configured or is disabled.`,
    };
  }
  const credentials = decryptSecret(
    config.credentialsEncrypted,
  ) as unknown as Record<string, string>;
  const provider = getSalePaymentProvider({
    provider: config.provider as SalePaymentProviderName,
    mode: config.mode as "sandbox" | "live",
    credentials,
  });
  return { provider };
}
