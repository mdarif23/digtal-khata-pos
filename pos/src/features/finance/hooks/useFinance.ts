import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import * as financeApi from "../finance.api";
import type { CapitalTransactionFilters } from "../finance.api";

/**
 * TanStack Query hooks for Finance & Growth. Key factories per resource
 * (mutations invalidate the `all` root, mirroring the expense hooks).
 */

export const financeKeys = {
  all: ["finance"] as const,
  status: () => [...financeKeys.all, "status"] as const,
  overview: (from: string, to: string) => [...financeKeys.all, "overview", from, to] as const,
  cashFlow: (from: string, to: string) => [...financeKeys.all, "cash-flow", from, to] as const,
  growth: (key: string) => [...financeKeys.all, "growth", key] as const,
  balanceSheet: (asOf: string | undefined) =>
    [...financeKeys.all, "balance-sheet", asOf ?? "now"] as const,
  accounts: () => [...financeKeys.all, "accounts"] as const,
  balances: (from?: string, to?: string) =>
    [...financeKeys.all, "balances", from ?? "", to ?? ""] as const,
  journal: (filters: Record<string, unknown>) =>
    [...financeKeys.all, "journal", filters] as const,
  journalEntry: (id: number) => [...financeKeys.all, "journal-entry", id] as const,
  periods: () => [...financeKeys.all, "periods"] as const,
  trialBalance: (toDate?: string) => [...financeKeys.all, "trial-balance", toDate ?? ""] as const,
  owners: () => [...financeKeys.all, "owners"] as const,
  capital: (filters: Record<string, unknown>) =>
    [...financeKeys.all, "capital", filters] as const,
  capitalSummary: () => [...financeKeys.all, "capital-summary"] as const,
  profit: (from: string, to: string) => [...financeKeys.all, "profit", from, to] as const,
  allocations: () => [...financeKeys.all, "allocations"] as const,
  employees: (filters: Record<string, unknown>) =>
    [...financeKeys.all, "employees", filters] as const,
  employee: (id: number) => [...financeKeys.all, "employee", id] as const,
  advances: (employeeId: number) => [...financeKeys.all, "advances", employeeId] as const,
  payrollPeriods: () => [...financeKeys.all, "payroll-periods"] as const,
  payrollPeriod: (id: number) => [...financeKeys.all, "payroll-period", id] as const,
  payslip: (recordId: number) => [...financeKeys.all, "payslip", recordId] as const,
  loans: () => [...financeKeys.all, "loans"] as const,
  loanRepayments: (loanId: number) => [...financeKeys.all, "loan-repayments", loanId] as const,
  assets: () => [...financeKeys.all, "assets"] as const,
  reconciliation: () => [...financeKeys.all, "reconciliation"] as const,
  auditLog: (filters: Record<string, unknown>) =>
    [...financeKeys.all, "audit-log", filters] as const,
  report: (key: string, from?: string, to?: string) =>
    [...financeKeys.all, "report", key, from ?? "", to ?? ""] as const,
};

export function useFinanceStatus() {
  return useQuery({
    queryKey: financeKeys.status(),
    queryFn: financeApi.getFinanceStatusApi,
  });
}

export function useOverview(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: financeKeys.overview(from, to),
    queryFn: () => financeApi.getOverviewApi(from, to),
    enabled,
  });
}

export function useCashFlow(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: financeKeys.cashFlow(from, to),
    queryFn: () => financeApi.getCashFlowApi(from, to),
    enabled,
  });
}

export function useGrowth(periodKey: string, period?: string, from?: string, to?: string) {
  return useQuery({
    queryKey: financeKeys.growth(periodKey),
    queryFn: () => financeApi.getGrowthApi(period, from, to),
  });
}

export function useBalanceSheet(asOf?: string) {
  return useQuery({
    queryKey: financeKeys.balanceSheet(asOf),
    queryFn: () => financeApi.getBalanceSheetApi(asOf),
  });
}

export function useJournalEntries(filters: {
  status?: string;
  sourceType?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  page: number;
  pageSize: number;
}) {
  return useQuery({
    queryKey: financeKeys.journal(filters as unknown as Record<string, unknown>),
    queryFn: () => financeApi.getJournalEntriesApi(filters),
    placeholderData: keepPreviousData,
  });
}

export function useJournalEntry(id: number | null): UseQueryResult<
  JournalEntry & { lines: JournalEntry["lines"] }
> {
  return useQuery({
    queryKey: financeKeys.journalEntry(id ?? 0),
    queryFn: () => financeApi.getJournalEntryApi(id!),
    enabled: id != null,
  });
}

export function usePeriods() {
  return useQuery({ queryKey: financeKeys.periods(), queryFn: financeApi.getPeriodsApi });
}

export function useTrialBalance(toDate?: string) {
  return useQuery({
    queryKey: financeKeys.trialBalance(toDate),
    queryFn: () => financeApi.getTrialBalanceApi(toDate),
  });
}

export function useOwners() {
  return useQuery({ queryKey: financeKeys.owners(), queryFn: financeApi.getOwnersApi });
}

export function useCapitalTransactions(filters: CapitalTransactionFilters) {
  return useQuery({
    queryKey: financeKeys.capital(filters as unknown as Record<string, unknown>),
    queryFn: () => financeApi.getCapitalTransactionsApi(filters),
    placeholderData: keepPreviousData,
  });
}

export function useCapitalSummary() {
  return useQuery({
    queryKey: financeKeys.capitalSummary(),
    queryFn: financeApi.getCapitalSummaryApi,
  });
}

export function useProfit(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: financeKeys.profit(from, to),
    queryFn: () => financeApi.getProfitApi(from, to),
    enabled,
  });
}

export function useProfitAllocations() {
  return useQuery({
    queryKey: financeKeys.allocations(),
    queryFn: financeApi.getProfitAllocationsApi,
  });
}

export function useEmployees(filters: {
  status?: string;
  search?: string;
  page: number;
  pageSize: number;
}) {
  return useQuery({
    queryKey: financeKeys.employees(filters as unknown as Record<string, unknown>),
    queryFn: () => financeApi.getEmployeesApi(filters),
    placeholderData: keepPreviousData,
  });
}

export function useEmployee(id: number | null) {
  return useQuery({
    queryKey: financeKeys.employee(id ?? 0),
    queryFn: () => financeApi.getEmployeeApi(id!),
    enabled: id != null,
  });
}

export function useAdvances(employeeId: number | null) {
  return useQuery({
    queryKey: financeKeys.advances(employeeId ?? 0),
    queryFn: () => financeApi.listAdvancesApi(employeeId!),
    enabled: employeeId != null,
  });
}

export function usePayrollPeriods() {
  return useQuery({
    queryKey: financeKeys.payrollPeriods(),
    queryFn: financeApi.getPayrollPeriodsApi,
  });
}

export function usePayrollPeriod(id: number | null) {
  return useQuery({
    queryKey: financeKeys.payrollPeriod(id ?? 0),
    queryFn: () => financeApi.getPayrollPeriodApi(id!),
    enabled: id != null,
  });
}

export function usePayslip(recordId: number | null) {
  return useQuery({
    queryKey: financeKeys.payslip(recordId ?? 0),
    queryFn: () => financeApi.getPayslipApi(recordId!),
    enabled: recordId != null,
  });
}

export function useLoans() {
  return useQuery({ queryKey: financeKeys.loans(), queryFn: financeApi.getLoansApi });
}

export function useLoanRepayments(loanId: number | null) {
  return useQuery({
    queryKey: financeKeys.loanRepayments(loanId ?? 0),
    queryFn: () => financeApi.getLoanRepaymentsApi(loanId!),
    enabled: loanId != null,
  });
}

export function useAssets() {
  return useQuery({ queryKey: financeKeys.assets(), queryFn: financeApi.getAssetsApi });
}

export function useReconciliation() {
  return useQuery({
    queryKey: financeKeys.reconciliation(),
    queryFn: financeApi.getReconciliationApi,
  });
}

export function useFinanceReport(key: financeApi.FinanceReportKey, from?: string, to?: string) {
  return useQuery({
    queryKey: financeKeys.report(key, from, to),
    queryFn: () => financeApi.getFinanceReportApi(key, from, to),
  });
}

/** Invalidate the whole finance subtree after any mutation. */
export function useInvalidateFinance() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: financeKeys.all });
}

export function useFinanceMutation<
  TArgs extends unknown[],
  TResult,
>(mutationFn: (...args: TArgs) => Promise<TResult>) {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: async (args: TArgs) => {
      const result = await mutationFn(...args);
      invalidate();
      return result;
    },
  });
}
