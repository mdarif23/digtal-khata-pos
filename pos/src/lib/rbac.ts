/**
 * Client-side mirror of the backend permission catalog (ezPosBackend
 * src/rbac/permissions.ts). Used for UX shaping only; the backend remains
 * the source of truth and re-verifies every request.
 */

export const WILDCARD_PERMISSION = "*";

export interface PermissionDefinition {
  key: string;
  module: string;
  description: string;
}

export const PERMISSION_CATALOG: PermissionDefinition[] = [
  { key: "dashboard.view", module: "dashboard", description: "View the dashboard summary" },

  { key: "pos.view", module: "pos", description: "Access the POS screen" },
  { key: "pos.create_sale", module: "pos", description: "Create sales at the register" },
  { key: "pos.apply_discount", module: "pos", description: "Apply discounts to sales" },
  { key: "pos.process_return", module: "pos", description: "Process sale returns at the register" },

  { key: "sales.view", module: "sales", description: "View sales records" },
  { key: "sales.edit", module: "sales", description: "Edit sales records" },
  { key: "sales.return", module: "sales", description: "Process sale returns and refunds" },

  { key: "products.view", module: "products", description: "View products and variants" },
  { key: "products.create", module: "products", description: "Create products" },
  { key: "products.edit", module: "products", description: "Edit products, categories, brands and units" },
  { key: "products.delete", module: "products", description: "Delete products and catalog entries" },
  { key: "products.view_cost", module: "products", description: "View purchase cost and cost-based valuations" },
  { key: "products.manage_variants", module: "products", description: "Manage product variants and variant options" },

  { key: "purchases.view", module: "purchases", description: "View purchase orders and purchase records" },
  { key: "purchases.create", module: "purchases", description: "Create purchase orders" },
  { key: "purchases.edit", module: "purchases", description: "Edit purchase orders" },
  { key: "purchases.receive", module: "purchases", description: "Receive purchased items into inventory" },
  { key: "purchases.return", module: "purchases", description: "Create and manage purchase returns" },
  { key: "purchases.price_check", module: "purchases", description: "Record, edit and delete market price check observations" },
  { key: "purchases.manage_price_alerts", module: "purchases", description: "Configure price increase alert thresholds" },

  { key: "inventory.view", module: "inventory", description: "View stock levels, batches and serials" },
  { key: "inventory.adjust", module: "inventory", description: "Adjust stock quantities" },
  { key: "inventory.transfer", module: "inventory", description: "Transfer stock between locations" },

  // Pricing (percentage-based pricing management; cost visibility reuses
  // products.view_cost — mirrors the backend catalog).
  { key: "pricing.view", module: "pricing", description: "View pricing settings, rules and price previews" },
  { key: "pricing.manage", module: "pricing", description: "Manage pricing settings and pricing rules" },
  { key: "pricing.product.manage", module: "pricing", description: "Set product/variant pricing overrides and apply price changes" },
  { key: "pricing.customer_groups.manage", module: "pricing", description: "Manage customer groups and group pricing" },
  { key: "pricing.price_override", module: "pricing", description: "Override unit prices at the point of sale" },
  { key: "pricing.below_minimum_override", module: "pricing", description: "Approve sales below the minimum price" },
  { key: "pricing.history.view", module: "pricing", description: "View price change history and proposals" },
  { key: "pricing.bulk_update", module: "pricing", description: "Perform bulk price updates" },

  { key: "customers.view", module: "customers", description: "View customers" },
  { key: "customers.create", module: "customers", description: "Create customers" },
  { key: "customers.edit", module: "customers", description: "Edit customers and record their payments" },
  { key: "customers.delete", module: "customers", description: "Delete customers" },
  { key: "customers.view_ledger", module: "customers", description: "View customer ledgers and dues" },

  { key: "suppliers.view", module: "suppliers", description: "View suppliers" },
  { key: "suppliers.create", module: "suppliers", description: "Create suppliers" },
  { key: "suppliers.edit", module: "suppliers", description: "Edit suppliers and record their payments" },
  { key: "suppliers.delete", module: "suppliers", description: "Delete suppliers" },
  { key: "suppliers.view_ledger", module: "suppliers", description: "View supplier ledgers and payables" },

  { key: "expenses.view", module: "expenses", description: "View expenses" },
  { key: "expenses.create", module: "expenses", description: "Record expenses" },
  { key: "expenses.edit", module: "expenses", description: "Edit expenses" },
  { key: "expenses.delete", module: "expenses", description: "Delete expenses" },

  { key: "reports.sales.view", module: "reports", description: "View sales reports" },
  { key: "reports.purchase.view", module: "reports", description: "View purchase and payables reports" },
  { key: "reports.profit.view", module: "reports", description: "View profit and margin reports" },
  { key: "reports.expense.view", module: "reports", description: "View expense reports" },
  { key: "reports.inventory.view", module: "reports", description: "View inventory and valuation reports" },
  { key: "reports.financial.view", module: "reports", description: "View receivables, tax and financial reports" },

  // Finance & Growth (backend catalog: src/rbac/permissions.ts)
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
  { key: "finance.assets.view", module: "finance", description: "View business assets and depreciation" },
  { key: "finance.assets.manage", module: "finance", description: "Manage business assets and run depreciation" },
  { key: "payroll.view", module: "payroll", description: "View employees, payroll periods and payslips" },
  { key: "payroll.manage", module: "payroll", description: "Manage employees and salary structures" },
  { key: "payroll.process", module: "payroll", description: "Run payroll calculations for a period" },
  { key: "payroll.approve", module: "payroll", description: "Approve payroll periods" },
  { key: "payroll.pay", module: "payroll", description: "Record salary payments" },
  { key: "budget.view", module: "budget", description: "View budgets and budget variance" },
  { key: "budget.manage", module: "budget", description: "Create and edit budgets" },
  { key: "loans.view", module: "loans", description: "View loans and repayment schedules" },
  { key: "loans.manage", module: "loans", description: "Manage loans and record repayments" },

  { key: "users.view", module: "users", description: "View business users" },
  { key: "users.create", module: "users", description: "Create users and assign their roles" },
  { key: "users.edit", module: "users", description: "Edit users, roles, status and passwords" },
  { key: "roles.view", module: "users", description: "View roles and the permission matrix" },
  { key: "roles.create", module: "users", description: "Create custom roles" },
  { key: "roles.edit", module: "users", description: "Edit roles and their permissions" },
  { key: "roles.delete", module: "users", description: "Delete custom roles" },

  { key: "settings.view", module: "settings", description: "View business settings" },
  { key: "settings.edit", module: "settings", description: "Edit business settings" },

  { key: "locations.view", module: "settings", description: "View business locations" },
  { key: "locations.manage", module: "settings", description: "Create, edit and deactivate locations" },

  // Warranty management (backend catalog: src/rbac/permissions.ts)
  { key: "warranty.view", module: "warranty", description: "View the warranty registry and warranty details" },
  { key: "warranty.claim.create", module: "warranty", description: "Create customer warranty claims" },
  { key: "warranty.claim.manage", module: "warranty", description: "Manage claim lifecycle: inspect, approve/reject, repair, replace, ready, pickup" },
  { key: "warranty.claim.close", module: "warranty", description: "Close or cancel warranty claims" },
  { key: "warranty.supplier.view", module: "warranty", description: "View supplier warranties and supplier claims" },
  { key: "warranty.supplier.manage", module: "warranty", description: "Create and manage supplier warranties and supplier claims" },
  { key: "warranty.reports.view", module: "warranty", description: "View warranty reports and statistics" },
  { key: "warranty.config.manage", module: "warranty", description: "Manage product and variant warranty configuration" },
];

export const ALL_PERMISSION_KEYS: string[] = PERMISSION_CATALOG.map(
  (p) => p.key,
);

/** Permissions grouped by module key, preserving catalog order. */
export const PERMISSIONS_BY_MODULE: Record<string, PermissionDefinition[]> =
  PERMISSION_CATALOG.reduce<Record<string, PermissionDefinition[]>>(
    (acc, permission) => {
      (acc[permission.module] ??= []).push(permission);
      return acc;
    },
    {},
  );
