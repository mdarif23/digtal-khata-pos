/**
 * Central permission catalog — the single source of truth for RBAC.
 *
 * Every permission key used anywhere in the backend (middleware, route
 * wiring, role templates) must be defined here. The catalog is seeded
 * idempotently into the `permissions` table by `ensureRbacSeed()` at server
 * startup (see src/rbac/seed.ts), so no SQL copy of this list exists.
 *
 * Key convention: `<module>[.<submodule>].<action>`.
 */

export interface PermissionDefinition {
  key: string;
  module: string;
  description: string;
}

export const PERMISSION_CATALOG: PermissionDefinition[] = [
  // Dashboard
  { key: "dashboard.view", module: "dashboard", description: "View the dashboard summary" },

  // POS
  { key: "pos.view", module: "pos", description: "Access the POS screen" },
  { key: "pos.create_sale", module: "pos", description: "Create sales at the register" },
  { key: "pos.apply_discount", module: "pos", description: "Apply discounts to sales" },
  { key: "pos.process_return", module: "pos", description: "Process sale returns at the register" },

  // Cash registers & drawer
  { key: "cash_register.view", module: "cash_register", description: "View registers and register sessions" },
  { key: "cash_register.open", module: "cash_register", description: "Open a register session" },
  { key: "cash_register.close", module: "cash_register", description: "Close and reconcile a register session" },
  { key: "cash_register.manage", module: "cash_register", description: "Create, rename and deactivate registers" },
  { key: "cash_movement.create", module: "cash_register", description: "Record cash in/out, safe deposits/withdrawals and adjustments" },
  { key: "cash_drawer.open", module: "cash_register", description: "Open the physical cash drawer (e.g. after a cash sale)" },
  { key: "cash_drawer.open_without_sale", module: "cash_register", description: "Open the physical cash drawer without an associated sale" },

  // POS terminals (hardware bridge)
  { key: "pos_terminal.view", module: "pos_terminal", description: "View POS terminals and their hardware status" },
  { key: "pos_terminal.manage", module: "pos_terminal", description: "Pair, edit and remove POS terminals" },

  // Sales
  { key: "sales.view", module: "sales", description: "View sales records" },
  { key: "sales.edit", module: "sales", description: "Edit sales records" },
  { key: "sales.return", module: "sales", description: "Process sale returns and refunds" },

  // Products
  { key: "products.view", module: "products", description: "View products and variants" },
  { key: "products.create", module: "products", description: "Create products" },
  { key: "products.edit", module: "products", description: "Edit products, categories, brands and units" },
  { key: "products.delete", module: "products", description: "Delete products and catalog entries" },
  { key: "products.view_cost", module: "products", description: "View purchase cost and cost-based valuations" },
  { key: "products.manage_variants", module: "products", description: "Manage product variants and variant options" },

  // Purchases
  { key: "purchases.view", module: "purchases", description: "View purchase orders and purchase records" },
  { key: "purchases.create", module: "purchases", description: "Create purchase orders" },
  { key: "purchases.edit", module: "purchases", description: "Edit purchase orders" },
  { key: "purchases.receive", module: "purchases", description: "Receive purchased items into inventory" },
  { key: "purchases.return", module: "purchases", description: "Create and manage purchase returns" },
  { key: "purchases.price_check", module: "purchases", description: "Record, edit and delete market price check observations" },
  { key: "purchases.manage_price_alerts", module: "purchases", description: "Configure price increase alert thresholds" },
  // Landed Cost Management (Part J)
  { key: "landed_cost.view", module: "landed_cost", description: "View landed-cost documents and allocations" },
  { key: "landed_cost.create", module: "landed_cost", description: "Create landed-cost documents" },
  { key: "landed_cost.edit", module: "landed_cost", description: "Edit draft landed-cost documents" },
  { key: "landed_cost.calculate", module: "landed_cost", description: "Run landed-cost allocation previews" },
  { key: "landed_cost.post", module: "landed_cost", description: "Post landed-cost allocations to inventory" },
  { key: "landed_cost.adjust", module: "landed_cost", description: "Adjust posted landed-cost documents" },
  { key: "landed_cost.reverse", module: "landed_cost", description: "Reverse posted landed-cost documents" },

  // Inventory
  { key: "inventory.view", module: "inventory", description: "View stock levels, batches and serials" },
  { key: "inventory.adjust", module: "inventory", description: "Adjust stock quantities" },
  { key: "inventory.transfer", module: "inventory", description: "Transfer stock between locations" },
  { key: "taxes.view", module: "taxes", description: "View tax rates and product tax assignments" },
  { key: "taxes.manage", module: "taxes", description: "Manage tax rates and product tax assignments" },
  { key: "loyalty.view", module: "loyalty", description: "View customer loyalty balances and history" },
  { key: "loyalty.manage", module: "loyalty", description: "Configure the loyalty program (earn/redeem rates)" },
  { key: "promotions.view", module: "promotions", description: "View coupons and promotions" },
  { key: "promotions.manage", module: "promotions", description: "Manage coupons and promotions" },
  { key: "attendance.view", module: "attendance", description: "Clock in/out and view own attendance" },
  { key: "attendance.manage", module: "attendance", description: "View all attendance, approve records, read summaries" },

  // Customers
  { key: "customers.view", module: "customers", description: "View customers" },
  { key: "customers.create", module: "customers", description: "Create customers" },
  { key: "customers.edit", module: "customers", description: "Edit customers and record their payments" },
  { key: "customers.delete", module: "customers", description: "Delete customers" },
  { key: "customers.view_ledger", module: "customers", description: "View customer ledgers and dues" },

  // Suppliers
  { key: "suppliers.view", module: "suppliers", description: "View suppliers" },
  { key: "suppliers.create", module: "suppliers", description: "Create suppliers" },
  { key: "suppliers.edit", module: "suppliers", description: "Edit suppliers and record their payments" },
  { key: "suppliers.delete", module: "suppliers", description: "Delete suppliers" },
  { key: "suppliers.view_ledger", module: "suppliers", description: "View supplier ledgers and payables" },

  // Expenses
  { key: "expenses.view", module: "expenses", description: "View expenses" },
  { key: "expenses.create", module: "expenses", description: "Record expenses" },
  { key: "expenses.edit", module: "expenses", description: "Edit expenses" },
  { key: "expenses.delete", module: "expenses", description: "Delete expenses" },
  { key: "expenses.pay", module: "expenses", description: "Record expense payments" },

  // Reports
  { key: "reports.sales.view", module: "reports", description: "View sales reports" },
  { key: "reports.purchase.view", module: "reports", description: "View purchase and payables reports" },
  { key: "reports.profit.view", module: "reports", description: "View profit and margin reports" },
  { key: "reports.expense.view", module: "reports", description: "View expense reports" },
  { key: "reports.inventory.view", module: "reports", description: "View inventory and valuation reports" },
  { key: "reports.financial.view", module: "reports", description: "View receivables, tax and financial reports" },

  // Users & Roles
  { key: "users.view", module: "users", description: "View business users" },
  { key: "users.create", module: "users", description: "Create users and assign their roles" },
  { key: "users.edit", module: "users", description: "Edit users, roles, status and passwords" },
  { key: "roles.view", module: "users", description: "View roles and the permission matrix" },
  { key: "roles.create", module: "users", description: "Create custom roles" },
  { key: "roles.edit", module: "users", description: "Edit roles and their permissions" },
  { key: "roles.delete", module: "users", description: "Delete custom roles" },

  // Settings
  { key: "settings.view", module: "settings", description: "View business settings" },
  { key: "settings.edit", module: "settings", description: "Edit business settings" },

  // Locations
  { key: "locations.view", module: "settings", description: "View business locations" },
  { key: "locations.manage", module: "settings", description: "Create, edit and deactivate locations" },

  // Receipt & Invoice Customization
  { key: "receipt_settings.view", module: "settings", description: "View receipt and invoice template settings" },
  { key: "receipt_settings.edit", module: "settings", description: "Edit receipt and invoice template settings" },
  { key: "receipt_settings.manage_logo", module: "settings", description: "Upload, replace or remove the business logo" },
  { key: "receipt_settings.print_test", module: "settings", description: "Print test receipts and invoices" },

  // Online Store (hosted storefront platform)
  { key: "storefront.view", module: "storefront", description: "View the online store, its settings and orders" },
  { key: "storefront.manage", module: "storefront", description: "Create and manage the online store, domains and publishing" },

  // Online Orders (order management & fulfillment)
  { key: "orders.view", module: "orders", description: "View online orders, their details and timelines" },
  { key: "orders.confirm", module: "orders", description: "Confirm or reject incoming online orders" },
  { key: "orders.process", module: "orders", description: "Start processing and progress order fulfillment" },
  { key: "orders.pack", module: "orders", description: "Record and edit order packages" },
  { key: "orders.ready_to_ship", module: "orders", description: "Mark packed orders as ready to ship" },
  { key: "orders.ship", module: "orders", description: "Record shipments and mark orders shipped" },
  { key: "orders.deliver", module: "orders", description: "Record delivery and COD collection" },
  { key: "orders.cancel", module: "orders", description: "Cancel online orders" },
  { key: "orders.return", module: "orders", description: "Process online order returns and refunds" },
  { key: "orders.manage_shipping", module: "orders", description: "Update courier and tracking information" },
  { key: "orders.mark_paid", module: "orders", description: "Record payment collection for unpaid orders" },

  // Reports (online channel)
  { key: "reports.online_profitability.view", module: "reports", description: "View online store profitability, costs and fees" },
];

export const ALL_PERMISSION_KEYS: string[] = PERMISSION_CATALOG.map((p) => p.key);

/** Wildcard permission granted to the Owner role; matches every key. */
export const WILDCARD_PERMISSION = "*";

export function isValidPermissionKey(key: string): boolean {
  return ALL_PERMISSION_KEYS.includes(key);
}

/**
 * Default permission templates for the four system roles created with every
 * business. The Owner template is informational (the owner also holds the
 * wildcard) but is seeded so the UI shows the role's full matrix.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<
  "owner" | "manager" | "cashier" | "accountant",
  string[]
> = {
  owner: ALL_PERMISSION_KEYS,

  manager: [
    "dashboard.view",
    "pos.view",
    "pos.create_sale",
    "pos.apply_discount",
    "pos.process_return",
    "cash_register.view",
    "cash_register.open",
    "cash_register.close",
    "cash_register.manage",
    "cash_movement.create",
    "cash_drawer.open",
    "cash_drawer.open_without_sale",
    "pos_terminal.view",
    "pos_terminal.manage",
    "sales.view",
    "sales.edit",
    "sales.return",
    "products.view",
    "products.create",
    "products.edit",
    "products.delete",
    "products.manage_variants",
    "purchases.view",
    "purchases.create",
    "purchases.edit",
    "purchases.receive",
    "landed_cost.view",
    "landed_cost.calculate",
    "purchases.return",
    "purchases.price_check",
    "inventory.view",
    "inventory.adjust",
    "inventory.transfer",
    "taxes.view",
    "taxes.manage",
    "loyalty.view",
    "loyalty.manage",
    "promotions.view",
    "promotions.manage",
    "attendance.view",
    "attendance.manage",
    "customers.view",
    "customers.create",
    "customers.edit",
    "customers.delete",
    "customers.view_ledger",
    "suppliers.view",
    "suppliers.create",
    "suppliers.edit",
    "suppliers.view_ledger",
    "reports.sales.view",
    "reports.purchase.view",
    "reports.inventory.view",
    "storefront.view",
    "storefront.manage",
    "orders.view",
    "orders.confirm",
    "orders.process",
    "orders.pack",
    "orders.ready_to_ship",
    "orders.ship",
    "orders.deliver",
    "orders.cancel",
    "orders.return",
    "orders.manage_shipping",
    "orders.mark_paid",
    "reports.online_profitability.view",
    "receipt_settings.view",
    "receipt_settings.edit",
    "receipt_settings.manage_logo",
    "receipt_settings.print_test",
  ],

  cashier: [
    "pos.view",
    "pos.create_sale",
    "cash_register.view",
    "cash_register.open",
    "cash_register.close",
    "cash_movement.create",
    "cash_drawer.open",
    "sales.view",
    "products.view",
    "inventory.view",
    "taxes.view",
    "attendance.view",
    "customers.view",
    "customers.create",
    "orders.view",
    "orders.process",
    "orders.pack",
    "receipt_settings.view",
  ],

  accountant: [
    "dashboard.view",
    "sales.view",
    "cash_register.view",
    "pos_terminal.view",
    "purchases.view",
    "products.view",
    "products.view_cost",
    "customers.view",
    "customers.view_ledger",
    "customers.edit",
    "suppliers.view",
    "suppliers.view_ledger",
    "suppliers.edit",
    "expenses.view",
    "expenses.create",
    "expenses.edit",
    "expenses.pay",
    "reports.sales.view",
    "reports.purchase.view",
    "reports.profit.view",
    "reports.expense.view",
    "reports.financial.view",
    "reports.online_profitability.view",
    "orders.view",
    "receipt_settings.view",
  ],
};

export type DefaultRoleSlug = keyof typeof DEFAULT_ROLE_PERMISSIONS;

/** Slugs of the system roles (besides owner) created for every business. */
export const STAFF_ROLE_SLUGS: DefaultRoleSlug[] = [
  "manager",
  "cashier",
  "accountant",
];

export const STAFF_ROLE_NAMES: Record<DefaultRoleSlug, string> = {
  owner: "Owner",
  manager: "Manager",
  cashier: "Cashier",
  accountant: "Accountant",
};
