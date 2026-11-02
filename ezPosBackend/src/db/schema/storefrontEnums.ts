import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Hosted storefront platform enums.
 *
 * `draft`/`preview` storefronts are only visible through preview links;
 * `published` storefronts serve live traffic; `suspended` is the platform/
 * subscription-expiry state (data retained, serving stopped); `archived`
 * is a customer-initiated soft delete.
 */
export const storefrontStatusEnum = pgEnum("storefront_status", [
  "draft",
  "preview",
  "published",
  "suspended",
  "archived",
]);

export const storefrontDomainKindEnum = pgEnum("storefront_domain_kind", [
  "subdomain",
  "custom",
]);

export const storefrontDomainStatusEnum = pgEnum("storefront_domain_status", [
  "pending",
  "verified",
  "failed",
  "removed",
]);

export const storefrontSslStatusEnum = pgEnum("storefront_ssl_status", [
  "pending",
  "issued",
  "failed",
]);

/** Storefront checkout payment methods (config-level; capture lands later). */
export const storefrontPaymentMethodEnum = pgEnum("storefront_payment_method", [
  "cod",
  "sslcommerz",
]);

export const storefrontAnalyticsEventTypeEnum = pgEnum(
  "storefront_analytics_event_type",
  ["visit", "product_view", "add_to_cart", "checkout_start"],
);
