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

  // Inventory
  { key: "inventory.view", module: "inventory", description: "View stock levels, batches and serials" },
  { key: "inventory.adjust", module: "inventory", description: "Adjust stock quantities" },
  { key: "inventory.transfer", module: "inventory", description: "Transfer stock between locations" },

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
    "purchases.return",
    "inventory.view",
    "inventory.adjust",
    "inventory.transfer",
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
  ],

  cashier: [
    "pos.view",
    "pos.create_sale",
    "sales.view",
    "products.view",
    "inventory.view",
    "customers.view",
    "customers.create",
  ],

  accountant: [
    "dashboard.view",
    "sales.view",
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
    "reports.sales.view",
    "reports.purchase.view",
    "reports.profit.view",
    "reports.expense.view",
    "reports.financial.view",
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
