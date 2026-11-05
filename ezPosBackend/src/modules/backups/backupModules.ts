import { getTableColumns, sql, type SQL } from "drizzle-orm";
import { getTableName, type Table } from "drizzle-orm";
import * as b from "../../db/schema/brands.js";
import * as att from "../../db/schema/attendance.js";
import * as audit from "../../db/schema/auditLog.js";
import * as cat from "../../db/schema/categories.js";
import * as chal from "../../db/schema/channelInventoryAllocations.js";
import * as coupons from "../../db/schema/coupons.js";
import * as credits from "../../db/schema/customerCredits.js";
import * as cust from "../../db/schema/customers.js";
import * as docseq from "../../db/schema/documentSequences.js";
import * as docset from "../../db/schema/documentSettings.js";
import * as expAtt from "../../db/schema/expenseAttachments.js";
import * as expBud from "../../db/schema/expenseBudgets.js";
import * as expCat from "../../db/schema/expenseCategories.js";
import * as expPay from "../../db/schema/expensePayments.js";
import * as expTpl from "../../db/schema/expenseTemplates.js";
import * as exp from "../../db/schema/expenses.js";
import * as gift from "../../db/schema/giftCards.js";
import * as held from "../../db/schema/heldSales.js";
import * as intSync from "../../db/schema/integrationSync.js";
import * as integ from "../../db/schema/integrations.js";
import * as invB from "../../db/schema/inventoryBatches.js";
import * as invM from "../../db/schema/inventoryMovements.js";
import * as invR from "../../db/schema/inventoryReservations.js";
import * as invS from "../../db/schema/inventoryStock.js";
import * as landed from "../../db/schema/landedCosts.js";
import * as loc from "../../db/schema/locations.js";
import * as loy from "../../db/schema/loyalty.js";
import * as notif from "../../db/schema/notifications.js";
import * as oop from "../../db/schema/onlineOrderPayments.js";
import * as businesses from "../../db/schema/businesses.js";
import * as priceAlert from "../../db/schema/priceAlertSettings.js";
import * as priceObs from "../../db/schema/priceObservations.js";
import * as prodImg from "../../db/schema/productImages.js";
import * as prodTax from "../../db/schema/productTaxes.js";
import * as variants from "../../db/schema/productVariants.js";
import * as products from "../../db/schema/products.js";
import * as pItems from "../../db/schema/purchaseItems.js";
import * as pPays from "../../db/schema/purchasePayments.js";
import * as prItems from "../../db/schema/purchaseReturnItems.js";
import * as prs from "../../db/schema/purchaseReturns.js";
import * as purch from "../../db/schema/purchases.js";
import * as regs from "../../db/schema/registers.js";
import * as soe from "../../db/schema/saleOrderEvents.js";
import * as spk from "../../db/schema/salePackages.js";
import * as ship from "../../db/schema/saleShipments.js";
import * as sbc from "../../db/schema/saleItemBatchConsumptions.js";
import * as spi from "../../db/schema/salePaymentIntents.js";
import * as sp from "../../db/schema/salePayments.js";
import * as sri from "../../db/schema/saleRefundItems.js";
import * as sr from "../../db/schema/saleRefunds.js";
import * as si from "../../db/schema/saleItems.js";
import * as st from "../../db/schema/stockTransfers.js";
import * as sales from "../../db/schema/sales.js";
import * as serials from "../../db/schema/serialNumbers.js";
import * as supLedger from "../../db/schema/supplierLedger.js";
import * as sfAe from "../../db/schema/storefrontAnalyticsEvents.js";
import * as sfAk from "../../db/schema/storefrontApiKeys.js";
import * as sfDz from "../../db/schema/storefrontDeliveryZones.js";
import * as sfMedia from "../../db/schema/storefrontMedia.js";
import * as sfPages from "../../db/schema/storefrontPages.js";
import * as sfPm from "../../db/schema/storefrontPaymentMethods.js";
import * as sfPv from "../../db/schema/storefrontProductVisibility.js";
import * as sfPub from "../../db/schema/storefrontPublishVersions.js";
import * as sfs from "../../db/schema/storefronts.js";
import * as sc from "../../db/schema/stockCount.js";
import * as shoppers from "../../db/schema/shoppers.js";
import * as sup from "../../db/schema/suppliers.js";
import * as taxRates from "../../db/schema/taxRates.js";
import * as units from "../../db/schema/units.js";
import * as vba from "../../db/schema/variantBarcodeAliases.js";
import * as vimg from "../../db/schema/variantImages.js";
import * as vopt from "../../db/schema/variantOptions.js";
import * as vtypes from "../../db/schema/variantTypes.js";
import * as vvals from "../../db/schema/variantValues.js";
import * as hooks from "../../db/schema/webhooks.js";

/**
 * Backup module registry — the single source of truth for what goes into a
 * business backup package, in what order, and what is stripped.
 *
 * Exclusions (approved architecture, 2026-11-05):
 *  - Platform state NEVER leaves the platform: users, memberships, roles,
 *    permissions, invitations, subscriptions, SaaS billing, tokens, support
 *    tickets, integration_credentials, payment_provider_configs,
 *    pos_terminals/terminal_pairing_codes (bridge secrets), shopper sessions,
 *    per-user notification read/prefs state.
 *  - Sensitive COLUMNS are stripped (nulled) at export and marked
 *    preserveOnRestore so a same-business restore never clobbers the live
 *    secret: webhook signing secrets, storefront API-key hashes, shopper
 *    password hashes.
 *  - Generated columns are excluded from both export and restore
 *    (GENERATED ALWAYS rejects inserts).
 */

export interface BackupTableSpec {
  /** Physical table name (package file key). */
  name: string;
  table: Table;
  /** Property names stripped (nulled) from exported rows. */
  exportExclude?: string[];
  /**
   * Property names that a same-business restore must NOT overwrite when the
   * row already exists (used for stripped sensitive columns — the package
   * has null there but the live row still holds the real value).
   */
  preserveOnRestore?: string[];
  /** Property names excluded from insert entirely (generated columns). */
  generatedExclude?: string[];
  /**
   * Composite PK for ON CONFLICT when the table has no single id column
   * (property names).
   */
  conflictTarget?: string[];
  /** No PK at all (sale_refund_items) — update-by-id then insert. */
  strategy?: "default" | "updateOrInsert";
  /** No business_id column (join tables) — scoped via parents. */
  noBusinessId?: boolean;
}

const spec = (
  table: Table,
  extra: Partial<BackupTableSpec> = {},
): BackupTableSpec => ({
  name: getTableName(table),
  table,
  ...extra,
});

export const TABLE_SPECS: Record<string, BackupTableSpec> = {
  // --- configuration -------------------------------------------------------
  locations: spec(loc.locations),
  tax_rates: spec(taxRates.taxRates),
  expense_categories: spec(expCat.expenseCategories),
  document_sequences: spec(docseq.documentSequences),
  document_settings: spec(docset.documentSettings),
  price_alert_settings: spec(priceAlert.priceAlertSettings),

  // --- catalog -------------------------------------------------------------
  variant_types: spec(vtypes.variantTypes),
  variant_options: spec(vopt.variantOptions),
  brands: spec(b.brands),
  units: spec(units.units),
  categories: spec(cat.categories),
  products: spec(products.products),
  product_taxes: spec(prodTax.productTaxes, {
    conflictTarget: ["productId", "taxRateId"],
    noBusinessId: true,
  }),
  product_variants: spec(variants.productVariants),
  variant_values: spec(vvals.variantValues, {
    conflictTarget: ["variantId", "optionId"],
    noBusinessId: true,
  }),
  product_images: spec(prodImg.productImages),
  variant_images: spec(vimg.variantImages),
  variant_barcode_aliases: spec(vba.variantBarcodeAliases),

  // --- contacts ------------------------------------------------------------
  customers: spec(cust.customers),
  suppliers: spec(sup.suppliers),

  // --- purchasing ----------------------------------------------------------
  purchases: spec(purch.purchases),
  purchase_items: spec(pItems.purchaseItems, {
    generatedExclude: ["total"],
  }),
  purchase_payments: spec(pPays.purchasePayments),
  purchase_returns: spec(prs.purchaseReturns),
  purchase_return_items: spec(prItems.purchaseReturnItems, {
    generatedExclude: ["lineTotal"],
  }),
  supplier_ledger: spec(supLedger.supplierLedger),
  landed_costs: spec(landed.landedCosts),
  landed_cost_expenses: spec(landed.landedCostExpenses),
  landed_cost_allocations: spec(landed.landedCostAllocations),
  landed_cost_adjustments: spec(landed.landedCostAdjustments),
  landed_cost_audit_logs: spec(landed.landedCostAuditLogs),
  landed_cost_postings: spec(landed.landedCostPostings),

  // --- sales ---------------------------------------------------------------
  sales: spec(sales.sales),
  sale_items: spec(si.saleItems),
  sale_payments: spec(sp.salePayments),
  sale_payment_intents: spec(spi.salePaymentIntents),
  sale_refunds: spec(sr.saleRefunds),
  sale_refund_items: spec(sri.saleRefundItems, { strategy: "updateOrInsert" }),
  held_sales: spec(held.heldSales),
  customer_credits: spec(credits.customerCredits),
  loyalty_programs: spec(loy.loyaltyPrograms),
  loyalty_ledger: spec(loy.loyaltyLedger),
  gift_cards: spec(gift.giftCards),
  gift_card_transactions: spec(gift.giftCardTransactions),
  coupons: spec(coupons.coupons),
  coupon_redemptions: spec(coupons.couponRedemptions),
  online_order_payments: spec(oop.onlineOrderPayments),
  sale_order_events: spec(soe.saleOrderEvents),
  sale_packages: spec(spk.salePackages),
  sale_shipments: spec(ship.saleShipments),
  sale_item_batch_consumptions: spec(sbc.saleItemBatchConsumptions),

  // --- inventory -----------------------------------------------------------
  inventory_stock: spec(invS.inventoryStock),
  inventory_batches: spec(invB.inventoryBatches, {
    generatedExclude: ["landedCostPerUnit"],
  }),
  inventory_movements: spec(invM.inventoryMovements),
  inventory_reservations: spec(invR.inventoryReservations),
  stock_count_sessions: spec(sc.stockCountSessions),
  stock_count_lines: spec(sc.stockCountLines),
  stock_transfers: spec(st.stockTransfers),
  stock_transfer_items: spec(st.stockTransferItems),
  channel_inventory_allocations: spec(chal.channelInventoryAllocations),
  serial_numbers: spec(serials.serialNumbers),

  // --- expenses ------------------------------------------------------------
  expenses: spec(exp.expenses),
  expense_payments: spec(expPay.expensePayments),
  expense_attachments: spec(expAtt.expenseAttachments),
  expense_budgets: spec(expBud.expenseBudgets),
  expense_templates: spec(expTpl.expenseTemplates),

  // --- operations ----------------------------------------------------------
  registers: spec(regs.registers),
  register_sessions: spec(regs.registerSessions),
  register_transactions: spec(regs.registerTransactions),
  attendance_records: spec(att.attendanceRecords),
  attendance_breaks: spec(att.attendanceBreaks),
  price_observations: spec(priceObs.priceObservations),

  // --- channels ------------------------------------------------------------
  integrations: spec(integ.integrations, {
    exportExclude: ["webhookSecret"],
    preserveOnRestore: ["webhookSecret"],
  }),
  integration_product_mappings: spec(intSync.integrationProductMappings),
  integration_variant_mappings: spec(intSync.integrationVariantMappings),
  integration_order_mappings: spec(intSync.integrationOrderMappings),
  integration_sync_jobs: spec(intSync.integrationSyncJobs),
  integration_sync_logs: spec(intSync.integrationSyncLogs),

  // --- storefront ------------------------------------------------------------
  storefronts: spec(sfs.storefronts),
  storefront_pages: spec(sfPages.storefrontPages),
  storefront_payment_methods: spec(sfPm.storefrontPaymentMethods),
  storefront_delivery_zones: spec(sfDz.storefrontDeliveryZones),
  storefront_product_visibility: spec(sfPv.storefrontProductVisibility),
  storefront_publish_versions: spec(sfPub.storefrontPublishVersions),
  storefront_analytics_events: spec(sfAe.storefrontAnalyticsEvents),
  storefront_media: spec(sfMedia.storefrontMedia),
  storefront_api_keys: spec(sfAk.storefrontApiKeys, {
    exportExclude: ["secretKeyHash"],
    preserveOnRestore: ["secretKeyHash"],
  }),
  shoppers: spec(shoppers.shoppers, {
    exportExclude: ["passwordHash"],
    preserveOnRestore: ["passwordHash"],
  }),

  // --- engagement ----------------------------------------------------------
  notifications: spec(notif.notifications),
  webhook_endpoints: spec(hooks.webhookEndpoints, {
    exportExclude: ["secretEncrypted"],
    preserveOnRestore: ["secretEncrypted"],
  }),
  webhook_deliveries: spec(hooks.webhookDeliveries),
  audit_log: spec(audit.auditLog),
};

/** Tables that are platform state and NEVER enter a business package. */
export const EXCLUDED_TABLES: string[] = [
  "users",
  "businesses",
  "business_memberships",
  "business_invitations",
  "roles",
  "role_permissions",
  "user_roles",
  "user_location_assignments",
  "permissions",
  "subscription_plans",
  "subscriptions",
  "subscription_payments",
  "subscription_events",
  "saas_invoices",
  "saas_admin_audit",
  "refresh_tokens",
  "password_reset_tokens",
  "email_verification_tokens",
  "support_tickets",
  "support_ticket_messages",
  "integration_credentials",
  "payment_provider_configs",
  "pos_terminals",
  "terminal_pairing_codes",
  "hardware_commands",
  "shopper_sessions",
  "notification_reads",
  "notification_prefs",
];

/**
 * The businesses row itself is the "profile" module: business settings are
 * business data (name, currency, timezone, logo, invoice defaults), but the
 * slug and platform status are platform state and stripped.
 */
export const PROFILE_EXCLUDE = ["slug", "status"];

/**
 * Module groups, in RESTORE (dependency) order. `requires` gates selective
 * restores: a group can only be restored when its prerequisite groups are
 * present in the same restore.
 */
export interface BackupModuleGroup {
  key: string;
  label: string;
  tables: string[];
  requires: string[];
}

export const MODULE_GROUPS: BackupModuleGroup[] = [
  {
    key: "configuration",
    label: "Configuration & settings",
    tables: [
      "locations",
      "tax_rates",
      "expense_categories",
      "document_sequences",
      "document_settings",
      "price_alert_settings",
    ],
    requires: [],
  },
  {
    key: "catalog",
    label: "Products & catalog",
    tables: [
      "variant_types",
      "variant_options",
      "brands",
      "units",
      "categories",
      "products",
      "product_taxes",
      "product_variants",
      "variant_values",
      "product_images",
      "variant_images",
      "variant_barcode_aliases",
    ],
    requires: ["configuration"],
  },
  {
    key: "contacts",
    label: "Customers & suppliers",
    tables: ["customers", "suppliers"],
    requires: ["configuration"],
  },
  {
    key: "purchasing",
    label: "Purchases & landed costs",
    tables: [
      "purchases",
      "purchase_items",
      "purchase_payments",
      "purchase_returns",
      "purchase_return_items",
      "supplier_ledger",
      "landed_costs",
      "landed_cost_expenses",
      "landed_cost_allocations",
      "landed_cost_adjustments",
      "landed_cost_audit_logs",
      "landed_cost_postings",
    ],
    requires: ["configuration", "catalog", "contacts"],
  },
  {
    key: "sales",
    label: "Sales, payments & rewards",
    tables: [
      "sales",
      "sale_items",
      "sale_payments",
      "sale_payment_intents",
      "sale_refunds",
      "sale_refund_items",
      "held_sales",
      "customer_credits",
      "loyalty_programs",
      "loyalty_ledger",
      "gift_cards",
      "gift_card_transactions",
      "coupons",
      "coupon_redemptions",
      "online_order_payments",
      "sale_order_events",
      "sale_packages",
      "sale_shipments",
      "sale_item_batch_consumptions",
    ],
    requires: ["configuration", "catalog", "contacts"],
  },
  {
    key: "inventory",
    label: "Inventory & stock",
    tables: [
      "inventory_stock",
      "inventory_batches",
      "inventory_movements",
      "inventory_reservations",
      "stock_count_sessions",
      "stock_count_lines",
      "stock_transfers",
      "stock_transfer_items",
      "channel_inventory_allocations",
      "serial_numbers",
    ],
    requires: ["configuration", "catalog"],
  },
  {
    key: "expenses",
    label: "Expenses",
    tables: [
      "expenses",
      "expense_payments",
      "expense_attachments",
      "expense_budgets",
      "expense_templates",
    ],
    requires: ["configuration"],
  },
  {
    key: "operations",
    label: "Registers & attendance",
    tables: [
      "registers",
      "register_sessions",
      "register_transactions",
      "attendance_records",
      "attendance_breaks",
      "price_observations",
    ],
    requires: ["configuration"],
  },
  {
    key: "channels",
    label: "Integrations",
    tables: [
      "integrations",
      "integration_product_mappings",
      "integration_variant_mappings",
      "integration_order_mappings",
      "integration_sync_jobs",
      "integration_sync_logs",
    ],
    requires: [],
  },
  {
    key: "storefront",
    label: "Online store",
    tables: [
      "storefronts",
      "storefront_pages",
      "storefront_payment_methods",
      "storefront_delivery_zones",
      "storefront_product_visibility",
      "storefront_publish_versions",
      "storefront_analytics_events",
      "storefront_media",
      "storefront_api_keys",
      "shoppers",
    ],
    requires: ["catalog"],
  },
  {
    key: "engagement",
    label: "Notifications, webhooks & audit",
    tables: [
      "notifications",
      "webhook_endpoints",
      "webhook_deliveries",
      "audit_log",
    ],
    requires: [],
  },
];

export const ALL_MODULE_KEYS = MODULE_GROUPS.map((g) => g.key);

/** Polymorphic references without FKs — remapped on new-business restore. */
export interface PolyRefSpec {
  table: string;
  idCol: string;
  typeCol?: string;
  /** Reference-type value → registry table name; null = not remappable. */
  typeMap: Record<string, string | null>;
}

export const POLY_REFS: PolyRefSpec[] = [
  {
    table: "inventory_movements",
    idCol: "referenceId",
    typeCol: "referenceType",
    typeMap: {
      purchase: "purchases",
      sale: "sales",
      return: "sale_refunds",
      adjustment: null,
      transfer_in: "stock_transfers",
      transfer_out: "stock_transfers",
    },
  },
  {
    table: "supplier_ledger",
    idCol: "referenceId",
    typeCol: "referenceType",
    typeMap: {
      purchase: "purchases",
      payment: "purchase_payments",
      return: "purchase_returns",
    },
  },
  {
    table: "register_transactions",
    idCol: "referenceId",
    typeCol: "referenceType",
    typeMap: { sale: "sales", sale_refund: "sale_refunds" },
  },
  {
    table: "customer_credits",
    idCol: "sourceId",
    typeCol: "sourceType",
    typeMap: { sale: "sales", refund: "sale_refunds" },
  },
  {
    table: "loyalty_ledger",
    idCol: "sourceId",
    typeCol: "sourceType",
    typeMap: { sale: "sales", refund: "sale_refunds", redemption: null },
  },
  {
    table: "gift_card_transactions",
    idCol: "sourceId",
    typeCol: "sourceType",
    typeMap: { sale: "sales", refund: "sale_refunds", issue: null },
  },
  {
    table: "coupon_redemptions",
    idCol: "saleId",
    typeMap: { sale: "sales" },
  },
  {
    table: "audit_log",
    idCol: "entityId",
    typeCol: "entityType",
    typeMap: { sale: "sales", purchase: "purchases" },
  },
  {
    table: "landed_cost_adjustments",
    idCol: "referenceId",
    typeMap: {},
  },
  {
    table: "landed_cost_postings",
    idCol: "paymentReferenceId",
    typeMap: { expense_payment: "expense_payments" },
  },
];

/** Attachment-bearing tables: bytes live in object storage, not the DB. */
export const ATTACHMENT_TABLES: Record<
  string,
  { idCol: string; keyCol: string; tarPrefix: string }
> = {
  expense_attachments: {
    idCol: "id",
    keyCol: "objectKey",
    tarPrefix: "attachments/expenses",
  },
  storefront_media: {
    idCol: "id",
    keyCol: "objectKey",
    tarPrefix: "attachments/storefront",
  },
};

/** Column-property → DB-name map per table (built once at import). */
export const TABLE_COLUMNS: Record<string, Record<string, { name: string; notNull: boolean }>> = {};
for (const [name, s] of Object.entries(TABLE_SPECS)) {
  const cols = getTableColumns(s.table as never) as Record<
    string,
    { name: string; notNull: boolean }
  >;
  TABLE_COLUMNS[name] = { ...cols };
}

/** Generic expression for ON CONFLICT DO UPDATE SET for a spec. */
export function buildUpdateSet(
  s: BackupTableSpec,
): Record<string, SQL> {
  const cols = getTableColumns(s.table as never) as Record<
    string,
    { name: string }
  >;
  const set: Record<string, SQL> = {};
  for (const [prop, col] of Object.entries(cols)) {
    if (prop === "id") continue;
    if (s.generatedExclude?.includes(prop)) continue;
    if (s.preserveOnRestore?.includes(prop)) continue;
    set[prop] = sql.raw(`excluded."${col.name}"`);
  }
  return set;
}

/** Column list used for INSERT payloads (generated columns removed). */
export function insertableProps(s: BackupTableSpec): Set<string> {
  const cols = getTableColumns(s.table as never) as Record<string, unknown>;
  const skip = new Set([...(s.generatedExclude ?? []), ...(s.exportExclude ?? [])]);
  return new Set(Object.keys(cols).filter((p) => !skip.has(p)));
}

export { sql };
