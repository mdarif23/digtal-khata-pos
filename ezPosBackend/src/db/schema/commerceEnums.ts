import { pgEnum } from "drizzle-orm/pg-core";

/** Phase 9 operating model. Default physical_only — existing businesses keep
 * working unchanged; modes gate feature surfaces, never permissions. */
export const businessModeEnum = pgEnum("business_mode", [
  "physical_only",
  "online_only",
  "omnichannel",
]);

/** Where a sale originated. 'pos' is the default for every legacy row. */
export const saleChannelEnum = pgEnum("sale_channel", [
  "pos",
  "woocommerce",
  "custom_storefront",
  /** Replica of a sale created on the shop's LAN server (Phase 2). */
  "offline",
]);

/**
 * Online order fulfillment workflow (online order management module).
 * Additive evolution of the original 4 values: POS rows keep
 * 'unfulfilled'/'shipped'/'delivered'; online orders walk
 * confirmed → processing → packed → ready_to_ship → shipped → delivered.
 * Return states are driven by the refund flow; money-side truth stays in
 * sale_refunds.
 */
export const fulfillmentStatusEnum = pgEnum("fulfillment_status", [
  "unfulfilled",
  "confirmed",
  "processing",
  "packed",
  "ready_to_ship",
  "shipped",
  "delivered",
  "return_requested",
  "partially_returned",
  "returned",
]);

export const integrationPlatformEnum = pgEnum("integration_platform", [
  "woocommerce",
  "custom_storefront",
]);

export const integrationStatusEnum = pgEnum("integration_status", [
  "connected",
  "error",
  "paused",
  "disconnected",
]);

export const reservationStatusEnum = pgEnum("reservation_status", [
  "active",
  "confirmed",
  "released",
  "expired",
]);

export const allocationModeEnum = pgEnum("allocation_mode", [
  "shared",
  "reserved",
]);
