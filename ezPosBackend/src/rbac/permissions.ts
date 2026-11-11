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
  { key: "products.print_labels", module: "products", description: "Print barcode labels and record print jobs" },

  // Purchases
  { key: "purchases.view", module: "purchases", description: "View purchase orders and purchase records" },
  { key: "purchases.create", module: "purchases", description: "Create purchase orders" },
  { key: "purchases.edit", module: "purchases", description: "Edit purchase orders" },
  { key: "purchases.receive", module: "purchases", description: "Receive purchased items into inventory" },
  { key: "purchases.over_receive", module: "purchases", description: "Accept delivered quantities above the ordered amount beyond the receiving tolerance" },
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
  // Pricing (percentage-based pricing management; migration 0063). Cost
  // visibility reuses products.view_cost — no separate pricing.cost.view.
  { key: "pricing.view", module: "pricing", description: "View pricing settings, rules and price previews" },
  { key: "pricing.manage", module: "pricing", description: "Manage pricing settings and pricing rules" },
  { key: "pricing.product.manage", module: "pricing", description: "Set product/variant pricing overrides and apply price changes" },
  { key: "pricing.customer_groups.manage", module: "pricing", description: "Manage customer groups and group pricing" },
  { key: "pricing.price_override", module: "pricing", description: "Override unit prices at the point of sale" },
  { key: "pricing.below_minimum_override", module: "pricing", description: "Approve sales below the minimum price" },
  { key: "pricing.history.view", module: "pricing", description: "View price change history and proposals" },
  { key: "pricing.bulk_update", module: "pricing", description: "Perform bulk price updates" },
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

  // Finance & Growth (ledger foundation; owner capital / payroll / loans
  // keys land with their phases but the catalog is defined once here).
  { key: "finance.view", module: "finance", description: "Access the Finance & Growth section" },
  { key: "finance.overview.view", module: "finance", description: "View the financial overview" },
  { key: "finance.accounts.manage", module: "finance", description: "Manage the chart of accounts and payment accounts" },
  { key: "finance.journal.view", module: "finance", description: "View journal entries and balances" },
  { key: "finance.journal.post", module: "finance", description: "Create, edit and post manual journal entries" },
  { key: "finance.journal.reverse", module: "finance", description: "Reverse posted journal entries" },
  { key: "finance.period.close", module: "finance", description: "Close accounting periods" },
  { key: "finance.period.reopen", module: "finance", description: "Reopen closed accounting periods" },
  { key: "finance.reconcile.manage", module: "finance", description: "Run reconciliation and record adjustments" },
  { key: "finance.activation.manage", module: "finance", description: "Activate the ledger and set opening balances" },
  { key: "finance.investment.view", module: "finance", description: "View owner investments" },
  { key: "finance.investment.manage", module: "finance", description: "Record owner investments" },
  { key: "finance.withdrawal.view", module: "finance", description: "View owner withdrawals and distributions" },
  { key: "finance.withdrawal.manage", module: "finance", description: "Record owner withdrawals and distributions" },
  { key: "finance.profit.view", module: "finance", description: "View profit figures and allocation status" },
  { key: "finance.profit.allocate", module: "finance", description: "Allocate distributable profit" },
  { key: "payroll.view", module: "payroll", description: "View employees, payroll periods and payslips" },
  { key: "payroll.manage", module: "payroll", description: "Manage employees and salary structures" },
  { key: "payroll.process", module: "payroll", description: "Run payroll calculations for a period" },
  { key: "payroll.approve", module: "payroll", description: "Approve payroll periods" },
  { key: "payroll.pay", module: "payroll", description: "Record salary payments" },
  { key: "budget.view", module: "budget", description: "View budgets and budget variance" },
  { key: "budget.manage", module: "budget", description: "Create and edit budgets" },
  { key: "loans.view", module: "loans", description: "View loans and repayment schedules" },
  { key: "loans.manage", module: "loans", description: "Manage loans and record repayments" },
  { key: "finance.assets.view", module: "finance", description: "View business assets and depreciation" },
  { key: "finance.assets.manage", module: "finance", description: "Manage business assets and run depreciation" },

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

  // Backup & Restore
  { key: "backups.view", module: "backup", description: "View backup history, schedules and storage usage" },
  { key: "backups.create", module: "backup", description: "Create manual backups and configure the backup schedule" },
  { key: "backups.download", module: "backup", description: "Download backup packages via short-lived links" },
  { key: "backups.verify", module: "backup", description: "Verify backup package integrity" },
  { key: "backups.delete", module: "backup", description: "Delete backups subject to retention rules" },
  { key: "backups.restore", module: "backup", description: "Restore business data from a backup package (owner-level)" },

  // Warranty management
  { key: "warranty.view", module: "warranty", description: "View the warranty registry and warranty details" },
  { key: "warranty.claim.create", module: "warranty", description: "Create customer warranty claims" },
  { key: "warranty.claim.manage", module: "warranty", description: "Manage claim lifecycle: inspect, approve/reject, repair, replace, ready, pickup" },
  { key: "warranty.claim.close", module: "warranty", description: "Close or cancel warranty claims" },
  { key: "warranty.supplier.view", module: "warranty", description: "View supplier warranties and supplier claims" },
  { key: "warranty.supplier.manage", module: "warranty", description: "Create and manage supplier warranties and supplier claims" },
  { key: "warranty.reports.view", module: "warranty", description: "View warranty reports and statistics" },
  { key: "warranty.config.manage", module: "warranty", description: "Manage product and variant warranty configuration" },
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
    "products.print_labels",
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
    "backups.view",
    "backups.create",
    "backups.download",
    "backups.verify",
    // Pricing: managers configure and operate the pricing system.
    "pricing.view",
    "pricing.manage",
    "pricing.product.manage",
    "pricing.customer_groups.manage",
    "pricing.price_override",
    "pricing.below_minimum_override",
    "pricing.history.view",
    "pricing.bulk_update",
    // Finance & Growth: managers see the overview and budgets only.
    "finance.view",
    "finance.overview.view",
    "budget.view",
    // Warranty: managers run the whole warranty program.
    "warranty.view",
    "warranty.claim.create",
    "warranty.claim.manage",
    "warranty.claim.close",
    "warranty.supplier.view",
    "warranty.supplier.manage",
    "warranty.reports.view",
    "warranty.config.manage",
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
    // Warranty: cashiers see warranty info and can register claims.
    "warranty.view",
    "warranty.claim.create",
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
    // Finance & Growth: accountant = authorized financial records & reports
    // (no withdrawals management, no payroll processing, no period reopen).
    "finance.view",
    "finance.overview.view",
    "finance.accounts.manage",
    "finance.journal.view",
    "finance.journal.post",
    "finance.reconcile.manage",
    "finance.investment.view",
    "finance.withdrawal.view",
    "finance.profit.view",
    "payroll.view",
    "budget.view",
    "budget.manage",
    "loans.view",
    "finance.assets.view",
    "reports.sales.view",
    "reports.purchase.view",
    "reports.profit.view",
    "reports.expense.view",
    "reports.financial.view",
    "reports.online_profitability.view",
    "orders.view",
    "receipt_settings.view",
    "backups.view",
    // Pricing: accountant sees settings/previews (cost still gated by
    // products.view_cost) and price history; no pricing management.
    "pricing.view",
    "pricing.history.view",
    // Warranty: accountant reads warranties and warranty costs.
    "warranty.view",
    "warranty.supplier.view",
    "warranty.reports.view",
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
