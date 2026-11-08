/**
 * Finance & Growth types — mirrors the backend contracts
 * (ezPosBackend/src/modules/finance/*). Money arrives as strings
 * (numeric(14,2) mapped as strings server-side).
 */

export type FinanceAccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type PaymentAccountType = "cash" | "bank" | "mfs";
export type JournalStatus = "draft" | "posted" | "reversed";
export type CapitalTransactionType = "investment" | "withdrawal" | "distribution";
export type AllocationCategory =
  | "reinvestment"
  | "owner_distribution"
  | "emergency_reserve"
  | "expansion"
  | "debt_repayment"
  | "other";
export type EmployeeStatus = "active" | "inactive" | "terminated";
export type SalaryPayType = "monthly" | "daily" | "hourly";
export type PayrollPeriodStatus = "draft" | "approved" | "paid" | "partial" | "cancelled";
export type BudgetPeriodType = "monthly" | "quarterly" | "yearly";
export type LoanLenderType = "bank" | "mfs" | "owner" | "other";
export type AssetCategory = "equipment" | "furniture" | "vehicle" | "other";
export type CashFlowCategory = "none" | "operating" | "investing" | "financing";

export interface FinanceStatus {
  activated: boolean;
  activatedAt: string | null;
  accountCount: number;
  paymentAccountCount: number;
  journalEntryCount: number;
}

export interface ActivationAccount {
  name: string;
  type: PaymentAccountType;
  provider?: string | null;
  openingBalance: number;
}

export interface FinanceAccount {
  id: number;
  code: string;
  name: string;
  type: FinanceAccountType;
  normalBalance: "debit" | "credit";
  isSystem: boolean;
  isCash: boolean;
  description: string | null;
  archivedAt: string | null;
}

export interface PaymentAccount {
  id: number;
  name: string;
  type: PaymentAccountType;
  provider: string | null;
  glAccountId: number;
  currency: string;
  isDefault: boolean;
  isActive: boolean;
}

export interface AccountBalance {
  accountId: number;
  code: string;
  name: string;
  type: string;
  normalBalance: string;
  balance: string;
}

export interface JournalEntryLine {
  id: number;
  accountId: number;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  locationId: number | null;
  description: string | null;
}

export interface JournalEntry {
  id: number;
  entryNo: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  sourceId: number | null;
  cashFlowCategory: CashFlowCategory;
  status: JournalStatus;
  reversalOfEntryId: number | null;
  createdAt: string;
  lines?: JournalEntryLine[];
  totalDebit?: string;
}

export interface AccountingPeriod {
  id: number;
  periodStart: string;
  periodEnd: string;
  status: "open" | "closed";
}

export interface FinancialOverview {
  range: { from: string; to: string };
  profit: {
    netRevenue: string;
    cogs: string;
    grossProfit: string;
    operatingExpenses: string;
    operatingProfit: string;
    interest: string;
    netProfit: string;
  };
  balances: {
    cash: string;
    bank: string;
    mfs: string;
    accountsReceivable: string;
    inventory: string;
    accountsPayable: string;
    vatPayable: string;
    salaryPayable: string;
    loansPayable: string;
    ownerContributions: string;
    ownerDrawings: string;
    retainedEarnings: string;
  };
  owner: {
    contributed: string;
    returned: string;
    distributed: string;
    position: string;
  };
  inventoryBatchValuation: string;
}

export interface CashFlowTotals {
  inflow: string;
  outflow: string;
  net: string;
}

export interface CashFlowReport {
  range: { from: string; to: string };
  totals: CashFlowTotals;
  byCategory: Record<"operating" | "investing" | "financing", CashFlowTotals>;
  bySource: { sourceType: string; category: string } & CashFlowTotals[];
  series: { date: string } & CashFlowTotals[];
  reconciliation: {
    openingBalance: string;
    closingBalance: string;
    netMovement: string;
  };
}

export interface GrowthMetrics {
  from: string;
  to: string;
  partial: boolean;
  netRevenue: string;
  cogs: string;
  grossProfit: string;
  grossMarginPercent: number | null;
  operatingExpenses: string;
  netProfit: string;
  netMarginPercent: number | null;
  expensesTotal: string;
  expenseToRevenueRatioPercent: number | null;
  employeeCost: string;
  employeeCostRatioPercent: number | null;
  salesCount: number;
  averageOrderValue: string;
  newCustomers: number;
  inventoryTurnover: number | null;
  stockHoldingDays: number | null;
  returnOnInvestedCapitalPercent: number | null;
}

export interface GrowthReport {
  period: string;
  current: GrowthMetrics;
  previous: GrowthMetrics;
  changes: Record<string, number | null>;
  insights: { type: "positive" | "warning"; message: string; evidence: string }[];
}

export interface BalanceSheet {
  asOf: string;
  assets: { lines: BalanceLine[]; netFixedAssets: string; total: string };
  liabilities: { lines: BalanceLine[]; total: string };
  equity: { lines: BalanceLine[]; currentEarnings: string; total: string };
  netWorth: string;
  balanced: boolean;
}

export interface BalanceLine {
  code: string;
  name: string;
  balance: string;
}

export interface OwnerProfile {
  id: number;
  userId: number | null;
  name: string;
  phone: string | null;
  email: string | null;
  ownershipPercent: string | null;
  isActive: boolean;
  notes: string | null;
  totals: { invested: string; withdrawn: string; distributed: string };
  capitalPosition: string;
}

export interface CapitalTransaction {
  id: number;
  ownerProfileId: number;
  ownerName: string;
  type: CapitalTransactionType;
  amount: string;
  txnDate: string;
  method: string | null;
  reference: string | null;
  description: string | null;
  createdAt: string;
}

export interface CapitalSummary {
  totals: {
    contributed: string;
    returned: string;
    distributed: string;
    position: string;
  };
  perOwner: {
    ownerProfileId: number;
    ownerName: string;
    invested: string;
    withdrawn: string;
    distributed: string;
    position: string;
  }[];
}

export interface ProfitAllocationLine {
  id: number;
  category: AllocationCategory;
  basisType: "percent" | "fixed";
  basisValue: string | null;
  amount: string;
  realizedAmount: string;
  realizedAt: string | null;
  realizedReference: string | null;
}

export interface ProfitAllocation {
  id: number;
  periodStart: string;
  periodEnd: string;
  periodLabel: string | null;
  basisMetrics: Record<string, unknown>;
  totalDistributable: string;
  totalAllocated: string;
  status: "confirmed" | "reversed";
  reversalReason: string | null;
  lines?: ProfitAllocationLine[];
}

export interface SalaryAllowance {
  name: string;
  amount: number;
}

export interface Employee {
  id: number;
  employeeCode: string;
  userId: number | null;
  fullName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  designation: string | null;
  department: string | null;
  joiningDate: string | null;
  employmentStatus: EmployeeStatus;
  locationId: number | null;
  paymentMethod: string | null;
  notes: string | null;
  payType?: SalaryPayType;
  basicAmount?: string;
  advanceOutstanding?: string;
  structures?: EmployeeSalaryStructure[];
}

export interface EmployeeSalaryStructure {
  id: number;
  payType: SalaryPayType;
  basicAmount: string;
  allowances: SalaryAllowance[];
  overtimeRate: string | null;
  effectiveFrom: string;
  isActive: boolean;
}

export interface SalaryAdvance {
  id: number;
  employeeId: number;
  amount: string;
  advanceDate: string;
  outstandingAmount: string;
  reason: string | null;
}

export interface PayrollRecord {
  id: number;
  employeeId: number;
  employeeName?: string;
  employeeCode?: string;
  workedDays: number;
  absentDays: number;
  leaveDays: number;
  halfDays: number;
  overtimeHours: string;
  workedHours: string | null;
  basicAmount: string;
  allowancesTotal: string;
  overtimeAmount: string;
  bonusAmount: string;
  commissionAmount: string;
  otherDeductions: string;
  advanceDeduction: string;
  grossAmount: string;
  netAmount: string;
  paidAmount?: string;
  payments?: PayrollPayment[];
}

export interface PayrollPayment {
  id: number;
  amount: string;
  method: string | null;
  paymentDate: string;
  reference: string | null;
}

export interface PayrollPeriod {
  id: number;
  periodStart: string;
  periodEnd: string;
  status: PayrollPeriodStatus;
  grossTotal: string;
  netTotal: string;
  advanceRecoveryTotal: string;
  records?: PayrollRecord[];
}

export interface Payslip {
  period: { id: number; periodStart: string; periodEnd: string; status: string };
  employee: {
    id: number;
    employeeCode: string;
    fullName: string;
    designation: string | null;
    department: string | null;
    joiningDate: string | null;
  };
  earnings: {
    workedDays: number;
    absentDays: number;
    leaveDays: number;
    halfDays: number;
    overtimeHours: string;
    basicAmount: string;
    allowancesTotal: string;
    overtimeAmount: string;
    bonusAmount: string;
    commissionAmount: string;
    grossAmount: string;
  };
  deductions: { otherDeductions: string; advanceDeduction: string };
  netAmount: string;
  paidAmount: string;
  paymentStatus: "unpaid" | "partial" | "paid";
  payments: PayrollPayment[];
}

export interface BusinessLoan {
  id: number;
  lenderType: LoanLenderType;
  lenderName: string;
  principal: string;
  interestRate: string | null;
  loanDate: string;
  dueDate: string | null;
  installmentCount: number | null;
  installmentAmount: string | null;
  status: "active" | "closed" | "written_off";
  principalRepaid?: string;
  interestPaid?: string;
  outstanding?: string;
}

export interface LoanRepayment {
  id: number;
  loanId: number;
  paymentDate: string;
  principalAmount: string;
  interestAmount: string;
  totalAmount: string;
  method: string | null;
  reference: string | null;
}

export interface BusinessAsset {
  id: number;
  name: string;
  category: AssetCategory;
  acquiredAt: string;
  cost: string;
  salvageValue: string;
  usefulLifeMonths: number;
  accumulatedDepreciation: string;
  status: "active" | "sold" | "written_off";
  bookValue?: string;
}

export interface ReconciliationCheck {
  key: string;
  glAccount: string;
  glBalance: string;
  operational: string;
  variance: string;
  reconciled: boolean;
}

export interface ReconciliationReport {
  checks: ReconciliationCheck[];
  allReconciled: boolean;
  note: string;
}

export interface AuditLogRow {
  id: number;
  action: string;
  entityType: string;
  entityId: number | null;
  actorUserId: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Tabular report shape from /api/finance/reports/*. */
export interface FinanceReportTable<T = Record<string, unknown>> {
  rows: T[];
  columns?: { key: string; label: string }[];
  totals?: Record<string, string>;
  total?: string;
  totalOutstanding?: string;
  totalAllocated?: string;
  totalRealized?: string;
  totalDebit?: string;
  totalCredit?: string;
  balanced?: boolean;
  truncated?: boolean;
  range?: { from: string; to: string };
}

export interface PnlLine {
  code: string;
  name: string;
  balance: string;
}

export interface PnlReport {
  range: { from: string; to: string };
  revenue: { lines: PnlLine[]; net: string };
  cogs: string;
  grossProfit: string;
  operatingExpenses: { lines: PnlLine[]; total: string };
  operatingProfit: string;
  interest: string;
  netProfit: string;
}

export interface RetainedEarningsReport {
  range: { from: string; to: string };
  openingRetainedEarnings: string;
  netProfit: string;
  lessProfitDistributions: string;
  closingRetainedEarnings: string;
  note: string;
}
