import api from "@/api/axios";
import type { AccountBalance } from "./finance.types";
import type {
  AccountingPeriod,
  ActivationAccount,
  BalanceSheet,
  BusinessAsset,
  BusinessLoan,
  CapitalTransaction,
  CapitalSummary,
  CashFlowReport,
  Employee,
  EmployeeSalaryStructure,
  FinanceReportTable,
  FinanceStatus,
  FinancialOverview,
  GrowthReport,
  JournalEntry,
  LoanRepayment,
  OwnerProfile,
  PayrollPeriod,
  Payslip,
  PaymentAccount,
  PnlReport,
  ProfitAllocation,
  ReconciliationReport,
  RetainedEarningsReport,
  SalaryAdvance,
  SalaryAllowance,
} from "./finance.types";

/**
 * Finance & Growth API layer — one function per backend endpoint
 * (/api/finance/*, /api/payroll/*). The shared axios instance already
 * carries Authorization, X-Business-Id, X-Location-Id.
 */

export interface CapitalTransactionFilters {
  type?: "investment" | "withdrawal" | "distribution";
  ownerId?: number;
  dateFrom?: string;
  dateTo?: string;
}

// --- Status & activation ------------------------------------------------------

export async function getFinanceStatusApi() {
  const { data } = await api.get<FinanceStatus>("/finance/status");
  return data;
}

export async function activateFinanceApi(payload: {
  accounts: ActivationAccount[];
  inventoryValue?: number;
  receivablesTotal?: number;
  vatInputTotal?: number;
  payablesTotal?: number;
  vatPayableTotal?: number;
  loansPayableTotal?: number;
  ownerCapital?: number;
  entryDate?: string;
  memo?: string | null;
}) {
  const { data } = await api.post<{ activated: boolean; openingEntry: JournalEntry }>(
    "/finance/activation",
    payload,
  );
  return data;
}

// --- Accounts & journal ---------------------------------------------------------

export async function getAccountsApi(includeArchived = false) {
  const { data } = await api.get<{ rows: FinanceAccount[] }>("/finance/accounts", {
    params: includeArchived ? { include_archived: true } : undefined,
  });
  return data.rows;
}

export async function getPaymentAccountsApi() {
  const { data } = await api.get<{ rows: PaymentAccount[] }>("/finance/payment-accounts");
  return data.rows;
}

export async function getBalancesApi(fromDate?: string, toDate?: string) {
  const { data } = await api.get<{ rows: AccountBalance[] }>(
    "/finance/accounts/balances",
    { params: { from_date: fromDate, to_date: toDate } },
  );
  return data.rows;
}

export async function getJournalEntriesApi(filters: {
  status?: string;
  sourceType?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}) {
  const { data } = await api.get<{
    rows: JournalEntry[];
    meta: { page: number; pageSize: number; total: number; totalPages: number };
  }>("/finance/journal-entries", {
    params: {
      status: filters.status,
      source_type: filters.sourceType,
      date_from: filters.dateFrom,
      date_to: filters.dateTo,
      search: filters.search,
      page: filters.page,
      page_size: filters.pageSize,
    },
  });
  return data;
}

export async function getJournalEntryApi(id: number) {
  const { data } = await api.get<JournalEntry & { lines: JournalEntry["lines"] }>(
    `/finance/journal-entries/${id}`,
  );
  return data;
}

export async function createJournalEntryApi(payload: {
  entryDate?: string;
  memo?: string | null;
  status: "draft" | "posted";
  lines: {
    accountCode?: string;
    accountId?: number;
    debit?: number;
    credit?: number;
    description?: string | null;
  }[];
}) {
  const { data } = await api.post<{ entry: JournalEntry; lines: unknown[]; reused: boolean }>(
    "/finance/journal-entries",
    payload,
  );
  return data;
}

export async function reverseJournalEntryApi(id: number, reason: string, entryDate?: string) {
  const { data } = await api.post(`/finance/journal-entries/${id}/reverse`, {
    reason,
    entryDate,
  });
  return data;
}

export async function postDraftEntryApi(id: number) {
  const { data } = await api.post(`/finance/journal-entries/${id}/post`);
  return data;
}

export async function deleteDraftEntryApi(id: number) {
  const { data } = await api.delete(`/finance/journal-entries/${id}`);
  return data;
}

export async function getPeriodsApi() {
  const { data } = await api.get<{ rows: AccountingPeriod[] }>("/finance/periods");
  return data.rows;
}

export async function closePeriodApi(id: number) {
  const { data } = await api.post(`/finance/periods/${id}/close`);
  return data;
}

export async function reopenPeriodApi(id: number) {
  const { data } = await api.post(`/finance/periods/${id}/reopen`);
  return data;
}

export async function getTrialBalanceApi(toDate?: string) {
  const { data } = await api.get<{
    sections: {
      type: string;
      accounts: { code: string; name: string; debit: string; credit: string }[];
      totalDebit: string;
      totalCredit: string;
    }[];
    totalDebit: string;
    totalCredit: string;
    balanced: boolean;
  }>("/finance/trial-balance", { params: { to_date: toDate } });
  return data;
}

// --- Dashboards -------------------------------------------------------------------

export async function getOverviewApi(from: string, to: string) {
  const { data } = await api.get<FinancialOverview>("/finance/overview", {
    params: { from, to },
  });
  return data;
}

export async function getCashFlowApi(from: string, to: string) {
  const { data } = await api.get<CashFlowReport>("/finance/cash-flow", {
    params: { from, to },
  });
  return data;
}

export async function getGrowthApi(period?: string, from?: string, to?: string) {
  const { data } = await api.get<GrowthReport>("/finance/growth", {
    params: period ? { period } : { from, to },
  });
  return data;
}

export async function getBalanceSheetApi(asOf?: string) {
  const { data } = await api.get<BalanceSheet>("/finance/balance-sheet", {
    params: { asOf },
  });
  return data;
}

// --- Owner finance ------------------------------------------------------------------

export async function getOwnersApi(includeInactive = false) {
  const { data } = await api.get<{ rows: OwnerProfile[] }>("/finance/owners", {
    params: includeInactive ? { include_inactive: true } : undefined,
  });
  return data.rows;
}

export async function createOwnerApi(payload: {
  name: string;
  userId?: number | null;
  phone?: string | null;
  email?: string | null;
  ownershipPercent?: number | null;
  notes?: string | null;
}) {
  const { data } = await api.post<OwnerProfile>("/finance/owners", payload);
  return data;
}

export async function updateOwnerApi(
  id: number,
  payload: {
    name?: string;
    ownershipPercent?: number | null;
    notes?: string | null;
    isActive?: boolean;
  },
) {
  const { data } = await api.patch<OwnerProfile>(`/finance/owners/${id}`, payload);
  return data;
}

export async function getCapitalTransactionsApi(filters: CapitalTransactionFilters) {
  const { data } = await api.get<{
    rows: CapitalTransaction[];
    meta: { page: number; pageSize: number; total: number; totalPages: number };
  }>("/finance/capital-transactions", {
    params: {
      type: filters.type,
      owner_id: filters.ownerId,
      date_from: filters.dateFrom,
      date_to: filters.dateTo,
    },
  });
  return data;
}

export async function recordCapitalTransactionApi(payload: {
  ownerProfileId: number;
  type: "investment" | "withdrawal" | "distribution";
  amount: number;
  txnDate?: string;
  method?: string | null;
  sourceOfFunds?: string | null;
  reference?: string | null;
  description?: string | null;
}) {
  const { data } = await api.post<{ transaction: CapitalTransaction; duplicate: boolean }>(
    "/finance/capital-transactions",
    payload,
  );
  return data;
}

export async function getCapitalSummaryApi() {
  const { data } = await api.get<CapitalSummary>("/finance/capital-summary");
  return data;
}

export async function getProfitApi(from: string, to: string) {
  const { data } = await api.get<FinancialOverview["profit"]>("/finance/profit", {
    params: { from, to },
  });
  return data;
}

// --- Profit allocations -----------------------------------------------------------

export async function getProfitAllocationsApi() {
  const { data } = await api.get<{ rows: ProfitAllocation[] }>("/finance/profit-allocations");
  return data.rows;
}

export async function createAllocationApi(payload: {
  periodStart: string;
  periodEnd: string;
  periodLabel?: string | null;
  lines: {
    category: string;
    basisType: "percent" | "fixed";
    basisValue?: number | null;
    amount?: number | null;
  }[];
}) {
  const { data } = await api.post<ProfitAllocation>("/finance/profit-allocations", payload);
  return data;
}

export async function reverseAllocationApi(id: number, reason: string) {
  const { data } = await api.post(`/finance/profit-allocations/${id}/reverse`, { reason });
  return data;
}

export async function realizeAllocationApi(
  lineId: number,
  payload: {
    ownerProfileId: number;
    amount?: number | null;
    method?: string | null;
    reference?: string | null;
    txnDate?: string;
  },
) {
  const { data } = await api.post<{
    line: ProfitAllocation["lines"] extends (infer L)[] | undefined ? L : never;
    transaction: CapitalTransaction;
  }>(`/finance/profit-allocations/lines/${lineId}/realize`, payload);
  return data;
}

// --- Payroll ------------------------------------------------------------------------

export async function getEmployeesApi(filters: {
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}) {
  const { data } = await api.get<{
    rows: Employee[];
    meta: { page: number; pageSize: number; total: number; totalPages: number };
  }>("/payroll/employees", {
    params: {
      status: filters.status,
      search: filters.search,
      page: filters.page,
      page_size: filters.pageSize,
    },
  });
  return data;
}

export async function getEmployeeApi(id: number) {
  const { data } = await api.get<Employee & { structures: EmployeeSalaryStructure[] }>(
    `/payroll/employees/${id}`,
  );
  return data;
}

export async function createEmployeeApi(payload: {
  fullName: string;
  userId?: number | null;
  phone?: string | null;
  email?: string | null;
  designation?: string | null;
  department?: string | null;
  joiningDate?: string | null;
  paymentMethod?: string | null;
  salaryStructure?: {
    payType: "monthly" | "daily" | "hourly";
    basicAmount: number;
    allowances?: SalaryAllowance[];
    overtimeRate?: number | null;
  } | null;
}) {
  const { data } = await api.post<Employee>("/payroll/employees", payload);
  return data;
}

export async function updateEmployeeApi(
  id: number,
  payload: Partial<{
    fullName: string;
    phone: string | null;
    designation: string | null;
    department: string | null;
    employmentStatus: "active" | "inactive" | "terminated";
    paymentMethod: string | null;
    notes: string | null;
  }>,
) {
  const { data } = await api.patch<Employee>(`/payroll/employees/${id}`, payload);
  return data;
}

export async function createSalaryStructureApi(
  employeeId: number,
  payload: {
    payType: "monthly" | "daily" | "hourly";
    basicAmount: number;
    allowances?: SalaryAllowance[];
    overtimeRate?: number | null;
  },
) {
  const { data } = await api.post<EmployeeSalaryStructure>(
    `/payroll/employees/${employeeId}/salary-structures`,
    payload,
  );
  return data;
}

export async function giveAdvanceApi(payload: {
  employeeId: number;
  amount: number;
  reason?: string | null;
  method?: string | null;
}) {
  const { data } = await api.post<{ advance: SalaryAdvance; duplicate: boolean }>(
    `/payroll/employees/${payload.employeeId}/advances`,
    payload,
  );
  return data;
}

export async function listAdvancesApi(employeeId: number) {
  const { data } = await api.get<{ rows: SalaryAdvance[] }>(
    `/payroll/employees/${employeeId}/advances`,
  );
  return data.rows;
}

export async function getPayrollPeriodsApi() {
  const { data } = await api.get<{ rows: PayrollPeriod[] }>("/payroll/periods");
  return data.rows;
}

export async function getPayrollPeriodApi(id: number) {
  const { data } = await api.get<PayrollPeriod>(`/payroll/periods/${id}`);
  return data;
}

export async function createPayrollPeriodApi(payload: {
  periodStart: string;
  employeeIds: number[];
  records?: {
    employeeId: number;
    workedDays?: number;
    absentDays?: number;
    leaveDays?: number;
    halfDays?: number;
    overtimeHours?: number;
    workedHours?: number | null;
    bonusAmount?: number;
    commissionAmount?: number;
    otherDeductions?: number;
    advanceDeduction?: number;
  }[];
}) {
  const { data } = await api.post<PayrollPeriod>("/payroll/periods", payload);
  return data;
}

export async function updatePayrollRecordApi(
  periodId: number,
  recordId: number,
  payload: Partial<{
    workedDays: number;
    absentDays: number;
    leaveDays: number;
    halfDays: number;
    overtimeHours: number;
    workedHours: number | null;
    bonusAmount: number;
    commissionAmount: number;
    otherDeductions: number;
    advanceDeduction: number;
  }>,
) {
  const { data } = await api.patch<PayrollRecord>(
    `/payroll/periods/${periodId}/records/${recordId}`,
    payload,
  );
  return data;
}

export async function approvePayrollPeriodApi(id: number) {
  const { data } = await api.post<PayrollPeriod>(`/payroll/periods/${id}/approve`);
  return data;
}

export async function cancelPayrollPeriodApi(id: number, reason: string) {
  const { data } = await api.post<PayrollPeriod>(`/payroll/periods/${id}/cancel`, { reason });
  return data;
}

export async function reopenPayrollPeriodApi(id: number) {
  const { data } = await api.post<PayrollPeriod>(`/payroll/periods/${id}/reopen`);
  return data;
}

export async function recordSalaryPaymentApi(
  recordId: number,
  payload: { amount: number; method?: string | null; reference?: string | null },
) {
  const { data } = await api.post<{ payment: PayrollPayment; duplicate: boolean }>(
    `/payroll/records/${recordId}/payments`,
    payload,
  );
  return data;
}

export async function getPayslipApi(recordId: number) {
  const { data } = await api.get<Payslip>(`/payroll/records/${recordId}/payslip`);
  return data;
}

// --- Loans & assets -------------------------------------------------------------------

export async function getLoansApi() {
  const { data } = await api.get<{ rows: BusinessLoan[] }>("/finance/loans");
  return data.rows;
}

export async function createLoanApi(payload: {
  lenderType: "bank" | "mfs" | "owner" | "other";
  lenderName: string;
  principal: number;
  interestRate?: number | null;
  loanDate?: string;
  dueDate?: string | null;
  method?: string | null;
  installmentCount?: number | null;
}) {
  const { data } = await api.post<BusinessLoan>("/finance/loans", payload);
  return data;
}

export async function getLoanRepaymentsApi(loanId: number) {
  const { data } = await api.get<{ rows: LoanRepayment[] }>(
    `/finance/loans/${loanId}/repayments`,
  );
  return data.rows;
}

export async function recordLoanRepaymentApi(
  loanId: number,
  payload: { principalAmount: number; interestAmount?: number; method?: string | null },
) {
  const { data } = await api.post<{ repayment: LoanRepayment; duplicate: boolean }>(
    `/finance/loans/${loanId}/repayments`,
    payload,
  );
  return data;
}

export async function getAssetsApi() {
  const { data } = await api.get<{ rows: BusinessAsset[] }>("/finance/assets");
  return data.rows;
}

export async function createAssetApi(payload: {
  name: string;
  category: "equipment" | "furniture" | "vehicle" | "other";
  acquiredAt: string;
  cost: number;
  usefulLifeMonths: number;
  method?: string | null;
}) {
  const { data } = await api.post<BusinessAsset>("/finance/assets", payload);
  return data;
}

export async function runDepreciationApi(periodMonth?: string) {
  const { data } = await api.post<{ posted: number; totalAmount: string }>(
    "/finance/assets/depreciation/run",
    periodMonth ? { periodMonth } : {},
  );
  return data;
}

// --- Reports (CSV via format=csv) ------------------------------------------------------

export type FinanceReportKey =
  | "owner-investments"
  | "owner-withdrawals"
  | "profit-allocations"
  | "payroll"
  | "salary-outstanding"
  | "loan-outstanding"
  | "budget-variance"
  | "transactions";

export async function getPnlReportApi(from: string, to: string) {
  const { data } = await api.get<PnlReport>("/finance/reports/pnl", {
    params: { from, to },
  });
  return data;
}

export async function getRetainedEarningsReportApi(from: string, to: string) {
  const { data } = await api.get<RetainedEarningsReport>(
    "/finance/reports/retained-earnings",
    { params: { from, to } },
  );
  return data;
}

export async function getFinanceReportApi(
  key: FinanceReportKey,
  from?: string,
  to?: string,
) {
  const params: Record<string, string> = {};
  if (from) params.from = from;
  if (to) params.to = to;
  const { data } = await api.get<FinanceReportTable>(`/finance/reports/${key}`, { params });
  return data;
}

// --- Reconciliation & audit ------------------------------------------------------------

export async function getReconciliationApi() {
  const { data } = await api.get<ReconciliationReport>("/finance/reconciliation");
  return data;
}

export async function getAuditLogApi(filters: {
  action?: string;
  page?: number;
  pageSize?: number;
}) {
  const { data } = await api.get<{
    rows: { id: number; action: string; entityType: string; entityId: number | null; createdAt: string; metadata: Record<string, unknown> }[];
    meta: { page: number; pageSize: number; total: number; totalPages: number };
  }>("/finance/audit-log", {
    params: {
      action: filters.action,
      page: filters.page,
      page_size: filters.pageSize,
    },
  });
  return data;
}
