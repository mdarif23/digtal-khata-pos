import { and, eq, isNull } from "drizzle-orm";
import { chartOfAccounts } from "../../db/schema/chartOfAccounts.js";
import { paymentAccounts as paymentAccountsTable } from "../../db/schema/paymentAccounts.js";
import type { Tx } from "../../services/audit.js";

/**
 * System chart of accounts (approved architecture §7.4). Seeded per
 * business at Finance activation — idempotent, never re-coded. Users may
 * add their own accounts on top; system accounts are edit/archival-only
 * (never deletable — posted history references them).
 *
 * Normal balances follow standard accounting: assets/expenses are debit,
 * liabilities/equity/revenue are credit. 1090 Accumulated Depreciation is
 * a contra-asset (credit) and 4020 Sales Returns a contra-revenue (debit).
 */
export interface SystemAccountDefinition {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  normalBalance: "debit" | "credit";
  isCash?: boolean;
  description?: string;
}

export const SYSTEM_ACCOUNTS: SystemAccountDefinition[] = [
  // --- 1000 Assets ---
  { code: "1010", name: "Cash on Hand (Drawers)", type: "asset", normalBalance: "debit", isCash: true },
  { code: "1020", name: "Bank Accounts", type: "asset", normalBalance: "debit", isCash: true },
  { code: "1030", name: "MFS Wallets", type: "asset", normalBalance: "debit", isCash: true },
  { code: "1040", name: "Accounts Receivable", type: "asset", normalBalance: "debit" },
  { code: "1045", name: "VAT Input", type: "asset", normalBalance: "debit" },
  { code: "1050", name: "Inventory", type: "asset", normalBalance: "debit" },
  { code: "1060", name: "Employee Salary Advances", type: "asset", normalBalance: "debit" },
  { code: "1070", name: "Prepaid Expenses", type: "asset", normalBalance: "debit" },
  { code: "1080", name: "Equipment", type: "asset", normalBalance: "debit" },
  { code: "1081", name: "Furniture", type: "asset", normalBalance: "debit" },
  { code: "1082", name: "Vehicles", type: "asset", normalBalance: "debit" },
  { code: "1090", name: "Accumulated Depreciation", type: "asset", normalBalance: "credit", description: "Contra-asset" },
  // --- 2000 Liabilities ---
  { code: "2010", name: "Accounts Payable (Suppliers)", type: "liability", normalBalance: "credit" },
  { code: "2020", name: "VAT Payable", type: "liability", normalBalance: "credit" },
  { code: "2030", name: "Salary Payable", type: "liability", normalBalance: "credit" },
  { code: "2040", name: "Gift Card Liability", type: "liability", normalBalance: "credit" },
  { code: "2050", name: "Store Credit Liability", type: "liability", normalBalance: "credit" },
  { code: "2060", name: "Loyalty Points Liability", type: "liability", normalBalance: "credit" },
  { code: "2070", name: "Customer Advances", type: "liability", normalBalance: "credit" },
  { code: "2080", name: "Loans Payable", type: "liability", normalBalance: "credit" },
  // --- 3000 Equity ---
  { code: "3010", name: "Owner Contributions", type: "equity", normalBalance: "credit" },
  { code: "3020", name: "Owner Drawings", type: "equity", normalBalance: "debit", description: "Contra-equity: withdrawals and profit distributions" },
  { code: "3030", name: "Retained Earnings", type: "equity", normalBalance: "credit" },
  { code: "3040", name: "Reserve: Reinvestment", type: "equity", normalBalance: "credit" },
  { code: "3050", name: "Reserve: Emergency", type: "equity", normalBalance: "credit" },
  { code: "3060", name: "Reserve: Expansion", type: "equity", normalBalance: "credit" },
  { code: "3070", name: "Reserve: Debt Repayment", type: "equity", normalBalance: "credit" },
  { code: "3080", name: "Reserve: Other", type: "equity", normalBalance: "credit" },
  // --- 4000 Revenue ---
  { code: "4010", name: "Sales Revenue", type: "revenue", normalBalance: "credit" },
  { code: "4020", name: "Sales Returns", type: "revenue", normalBalance: "debit", description: "Contra-revenue" },
  { code: "4030", name: "Delivery Income", type: "revenue", normalBalance: "credit" },
  { code: "4040", name: "Other Operating Income", type: "revenue", normalBalance: "credit" },
  // --- 5000 Expenses ---
  { code: "5010", name: "Cost of Goods Sold", type: "expense", normalBalance: "debit" },
  { code: "5020", name: "Salaries & Wages", type: "expense", normalBalance: "debit" },
  { code: "5030", name: "Rent", type: "expense", normalBalance: "debit" },
  { code: "5040", name: "Utilities", type: "expense", normalBalance: "debit" },
  { code: "5050", name: "Marketing & Advertising", type: "expense", normalBalance: "debit" },
  { code: "5060", name: "Transportation", type: "expense", normalBalance: "debit" },
  { code: "5070", name: "Inventory Shrinkage", type: "expense", normalBalance: "debit" },
  { code: "5080", name: "Bank & Gateway Fees", type: "expense", normalBalance: "debit" },
  { code: "5090", name: "Loan Interest", type: "expense", normalBalance: "debit" },
  { code: "5100", name: "Depreciation", type: "expense", normalBalance: "debit" },
  { code: "5900", name: "Other Expenses", type: "expense", normalBalance: "debit" },
];

/**
 * Seed the system chart of accounts for a business — idempotent (unique on
 * (business_id, code), conflicting rows are skipped). Called inside the
 * activation transaction. Safe to call again (e.g. re-activation attempts
 * fail before reaching here, but tests may re-seed freely).
 */
export async function ensureChartOfAccountsInTx(
  tx: Tx,
  businessId: number,
): Promise<void> {
  await tx
    .insert(chartOfAccounts)
    .values(
      SYSTEM_ACCOUNTS.map((account) => ({
        businessId,
        code: account.code,
        name: account.name,
        type: account.type,
        normalBalance: account.normalBalance,
        isSystem: true,
        isCash: account.isCash ?? false,
        description: account.description ?? null,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Default payment accounts: one per type the business asked for, mapped to
 * the matching system GL account and marked default. Idempotent per type.
 */
export async function ensureDefaultPaymentAccountsInTx(
  tx: Tx,
  businessId: number,
  wanted: { cash: boolean; bank: boolean; mfs: boolean },
): Promise<void> {
  const typeToCode: Record<"cash" | "bank" | "mfs", string> = {
    cash: "1010",
    bank: "1020",
    mfs: "1030",
  };
  const names: Record<"cash" | "bank" | "mfs", string> = {
    cash: "Cash on Hand",
    bank: "Bank Account",
    mfs: "Mobile Wallet (bKash/Nagad)",
  };
  for (const type of ["cash", "bank", "mfs"] as const) {
    if (!wanted[type]) continue;
    const [existing] = await tx
      .select({ id: paymentAccountsTable.id })
      .from(paymentAccountsTable)
      .where(
        and(
          eq(paymentAccountsTable.businessId, businessId),
          eq(paymentAccountsTable.type, type),
          eq(paymentAccountsTable.isDefault, true),
          eq(paymentAccountsTable.isActive, true),
        ),
      )
      .limit(1);
    if (existing) continue;
    const [gl] = await tx
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.businessId, businessId),
          eq(chartOfAccounts.code, typeToCode[type]),
          isNull(chartOfAccounts.archivedAt),
        ),
      )
      .limit(1);
    if (!gl) continue;
    await tx.insert(paymentAccountsTable).values({
      businessId,
      name: names[type],
      type,
      glAccountId: gl.id,
      isDefault: true,
    });
  }
}
