import React, { useState } from "react";
import {
  Banknote,
  Calculator,
  CheckCircle2,
  AlertTriangle,
  Printer,
  Receipt,
  Wallet,
  CreditCard,
  QrCode,
} from "lucide-react";
import { reportsApi } from "../api/reports.api";
import { useReportData } from "../hooks/useReportData";
import type { ReportFilters } from "../types/report.types";
import {
  formatCurrency,
  formatDateTime,
  formatNumber,
} from "../utils/reportUtils";
import { ReportHeader } from "../components/ReportHeader";
import { ReportDateFilter } from "../components/ReportDateFilter";
import { ReportMetricCard } from "../components/ReportMetricCard";

export function RegisterCloseReport() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "today",
  });

  // Shift drawer state
  const [openingFloat, setOpeningFloat] = useState<number>(2000);
  const [actualCashCounted, setActualCashCounted] = useState<number>(0);

  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getRegisterClose(filters),
    [filters]
  );

  const cashSalesAmount = Number(data?.cashSales?.cashAmount || 0);
  const cashSalesCount = Number(data?.cashSales?.cashTxCount || 0);
  const cashExpensesAmount = Number(data?.cashExpenses?.cashExpenseTotal || 0);
  const digitalPayments = data?.digitalPayments || [];
  const salesSummary = data?.salesSummary;
  const refunds = data?.refunds;

  const totalDigitalCollections = digitalPayments.reduce(
    (acc, p) => acc + Number(p.amount),
    0
  );

  // Expected Cash = Float + Cash Sales - Cash Expenses
  const expectedCashInDrawer =
    Number(openingFloat || 0) + cashSalesAmount - cashExpensesAmount;

  // Discrepancy = Counted - Expected
  const discrepancy = Number(actualCashCounted || 0) - expectedCashInDrawer;
  const hasCounted = actualCashCounted > 0;

  const handlePrintZReport = () => {
    window.print();
  };

  return (
    <div className="space-y-6">
      <div className="print:hidden">
        <ReportHeader
          category="Financial Reports"
          title="Shift & Cash Drawer Close (Z-Report)"
          description="End-of-day register reconciliation, cash drawer balancing, over/short audit, and printable slip."
          onRefresh={refetch}
          onPrint={handlePrintZReport}
          loading={loading}
        />

        <div className="mt-4">
          <ReportDateFilter filters={filters} onFiltersChange={setFilters} />
        </div>
      </div>

      {/* Screen Layout (hidden during print) */}
      <div className="space-y-6 print:hidden">
        {/* Register session breakdown — actual drawer data per shift */}
        {data?.sessions && data.sessions.length > 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Register Sessions
            </h3>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Register</th>
                    <th className="px-3 py-2">Location</th>
                    <th className="px-3 py-2">Cashier</th>
                    <th className="px-3 py-2 text-right">Opening</th>
                    <th className="px-3 py-2 text-right">Cash sales</th>
                    <th className="px-3 py-2 text-right">Non-cash</th>
                    <th className="px-3 py-2 text-right">Cash in</th>
                    <th className="px-3 py-2 text-right">Cash out</th>
                    <th className="px-3 py-2 text-right">Cash refunds</th>
                    <th className="px-3 py-2 text-right">Refund value</th>
                    <th className="px-3 py-2 text-right">Expected</th>
                    <th className="px-3 py-2 text-right">Counted</th>
                    <th className="px-3 py-2 text-right">Over/Short</th>
                    <th className="px-3 py-2">Window</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((session) => (
                    <tr key={session.sessionId} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">{session.registerName}</td>
                      <td className="px-3 py-2">{session.locationName}</td>
                      <td className="px-3 py-2">{session.cashierName}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(session.openingCash)}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(session.cashSales)}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(session.nonCashSales)}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(session.cashIn)}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(session.cashOut)}</td>
                      <td className="px-3 py-2 text-right text-rose-600">
                        {formatCurrency(session.cashRefunds)}
                      </td>
                      <td className="px-3 py-2 text-right">{formatCurrency(session.refunds)}</td>
                      <td className="px-3 py-2 text-right">
                        {session.status === "closed" ? formatCurrency(session.expectedCash) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {session.countedCash === null ? "—" : formatCurrency(session.countedCash)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-medium ${
                          session.difference === null
                            ? "text-slate-400"
                            : session.difference === 0
                              ? "text-emerald-600"
                              : session.difference > 0
                                ? "text-blue-600"
                                : "text-rose-600"
                        }`}
                      >
                        {session.difference === null
                          ? "—"
                          : `${session.difference > 0 ? "+" : ""}${formatCurrency(session.difference)}`}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {session.openedAt ? new Date(session.openedAt).toLocaleString() : "—"}
                        {" → "}
                        {session.closedAt ? new Date(session.closedAt).toLocaleString() : "open"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {/* Metric Cards Row */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ReportMetricCard
            title="Cash Sales In"
            value={cashSalesAmount}
            subtitle={`${cashSalesCount} cash receipts`}
            icon={Banknote}
            accent="bg-emerald-50 text-emerald-700"
            valueClassName="text-emerald-700"
          />
          <ReportMetricCard
            title="Cash Expenses Paid Out"
            value={cashExpensesAmount}
            subtitle="Deducted from drawer"
            icon={Wallet}
            accent="bg-rose-50 text-rose-700"
            valueClassName="text-rose-700"
          />
          <ReportMetricCard
            title="Digital Collections"
            value={totalDigitalCollections}
            subtitle="Cards & Bangla QR"
            icon={CreditCard}
            accent="bg-sky-50 text-sky-700"
          />
          <ReportMetricCard
            title="Gross Period Revenue"
            value={salesSummary?.grossRevenue}
            subtitle={`${salesSummary?.totalInvoices || 0} total invoices`}
            icon={Receipt}
            accent="bg-violet-50 text-violet-700"
          />
        </div>

        {/* Drawer Balancing Interactive Workspace */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Left: Input & Calculation */}
          <div className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs space-y-4">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <Calculator className="size-5 text-emerald-600" />
              <h3 className="font-semibold text-slate-900">
                Cash Drawer Count & Reconciliation
              </h3>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Opening Cash Float (৳)
                </label>
                <input
                  type="number"
                  value={openingFloat}
                  onChange={(e) => setOpeningFloat(Number(e.target.value) || 0)}
                  placeholder="2000"
                  className="w-full h-9 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-800 outline-none focus:border-emerald-600"
                />
                <span className="text-[11px] text-slate-400">
                  Starting cash amount placed in register at start of shift.
                </span>
              </div>

              <div className="rounded-xl bg-slate-50 p-3.5 space-y-2 border border-slate-200/70">
                <div className="flex justify-between text-xs text-slate-600">
                  <span>Opening Float:</span>
                  <span className="font-semibold">
                    {formatCurrency(openingFloat)}
                  </span>
                </div>
                <div className="flex justify-between text-xs text-slate-600">
                  <span>+ Cash Sales Tendered:</span>
                  <span className="font-semibold text-emerald-700">
                    +{formatCurrency(cashSalesAmount)}
                  </span>
                </div>
                <div className="flex justify-between text-xs text-slate-600">
                  <span>- Cash Expenses Paid:</span>
                  <span className="font-semibold text-rose-600">
                    -{formatCurrency(cashExpensesAmount)}
                  </span>
                </div>
                <div className="border-t border-slate-200 pt-2 flex justify-between text-sm font-bold text-slate-900">
                  <span>Expected Cash in Drawer:</span>
                  <span className="text-slate-950 font-mono">
                    {formatCurrency(expectedCashInDrawer)}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Actual Counted Cash at Close (৳)
                </label>
                <input
                  type="number"
                  value={actualCashCounted === 0 ? "" : actualCashCounted}
                  onChange={(e) =>
                    setActualCashCounted(Number(e.target.value) || 0)
                  }
                  placeholder="Enter physical cash counted in drawer..."
                  className="w-full h-10 rounded-lg border-2 border-emerald-600 px-3 text-base font-bold text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500/20"
                />
              </div>

              {/* Discrepancy Alert Box */}
              {hasCounted ? (
                <div
                  className={`rounded-xl p-4 border flex items-center justify-between ${
                    discrepancy === 0
                      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                      : discrepancy > 0
                      ? "bg-blue-50 border-blue-200 text-blue-800"
                      : "bg-rose-50 border-rose-200 text-rose-800"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    {discrepancy === 0 ? (
                      <CheckCircle2 className="size-5 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="size-5 text-rose-600" />
                    )}
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider">
                        {discrepancy === 0
                          ? "Drawer Balanced Perfectly"
                          : discrepancy > 0
                          ? "Cash Overage (+)"
                          : "Cash Shortage (-)"}
                      </p>
                      <p className="text-xs opacity-80">
                        {discrepancy === 0
                          ? "Actual cash matches expected cash."
                          : discrepancy > 0
                          ? "Drawer contains more cash than recorded."
                          : "Drawer has less cash than expected."}
                      </p>
                    </div>
                  </div>
                  <span className="text-lg font-bold font-mono">
                    {discrepancy > 0 ? "+" : ""}
                    {formatCurrency(discrepancy)}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {/* Right: Payment Channels & Action */}
          <div className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs space-y-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-3">
                <Receipt className="size-5 text-slate-700" />
                <h3 className="font-semibold text-slate-900">
                  Non-Cash / Digital Settlement
                </h3>
              </div>

              <div className="space-y-3">
                {digitalPayments.map((dp) => (
                  <div
                    key={dp.method}
                    className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100"
                  >
                    <div className="flex items-center gap-2.5">
                      {dp.method === "bangla_qr" ? (
                        <QrCode className="size-4 text-emerald-600" />
                      ) : (
                        <CreditCard className="size-4 text-sky-600" />
                      )}
                      <div>
                        <p className="text-sm font-semibold capitalize text-slate-800">
                          {dp.method.replace(/_/g, " ")}
                        </p>
                        <p className="text-xs text-slate-400">
                          {dp.txCount} transactions
                        </p>
                      </div>
                    </div>
                    <span className="font-bold text-slate-900">
                      {formatCurrency(dp.amount)}
                    </span>
                  </div>
                ))}

                {digitalPayments.length === 0 && (
                  <p className="text-xs text-slate-400 py-4 text-center">
                    No digital or card transactions recorded for this period.
                  </p>
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 flex gap-2">
              <button
                type="button"
                onClick={handlePrintZReport}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 h-10 px-4 text-sm font-semibold text-white hover:bg-slate-800 shadow-xs"
              >
                <Printer className="size-4" />
                Print Official Z-Report
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Printable 80mm Z-Report Thermal Slip (Visible only during window.print) */}
      <div className="hidden print:block font-mono text-black text-xs p-2 max-w-[320px] mx-auto border border-dashed border-gray-400">
        <div className="text-center space-y-1 mb-3">
          <h2 className="text-base font-bold uppercase tracking-wider">
            ezPos Retail
          </h2>
          <p className="text-[11px]">REGISTER CLOSING SLIP (Z-REPORT)</p>
          <p className="text-[10px]">
            Generated: {formatDateTime(new Date().toISOString())}
          </p>
          <div className="border-b border-black my-2" />
        </div>

        <div className="space-y-1">
          <div className="flex justify-between">
            <span>Period Start:</span>
            <span>{data?.periodBounds.start.slice(0, 16)}</span>
          </div>
          <div className="flex justify-between">
            <span>Period End:</span>
            <span>{data?.periodBounds.end.slice(0, 16)}</span>
          </div>
          <div className="flex justify-between">
            <span>Invoices Closed:</span>
            <span>{salesSummary?.totalInvoices || 0}</span>
          </div>
        </div>

        <div className="border-b border-black my-2" />

        <div className="space-y-1">
          <p className="font-bold">SALES SUMMARY:</p>
          <div className="flex justify-between">
            <span>Gross Revenue:</span>
            <span>{formatCurrency(salesSummary?.grossRevenue)}</span>
          </div>
          <div className="flex justify-between">
            <span>Discounts:</span>
            <span>-{formatCurrency(salesSummary?.totalDiscount)}</span>
          </div>
          <div className="flex justify-between">
            <span>VAT / Tax:</span>
            <span>{formatCurrency(salesSummary?.totalVat)}</span>
          </div>
          <div className="flex justify-between">
            <span>Credit Sales (Due):</span>
            <span>{formatCurrency(salesSummary?.creditSalesDue)}</span>
          </div>
        </div>

        <div className="border-b border-black my-2" />

        <div className="space-y-1">
          <p className="font-bold">DRAWER RECONCILIATION:</p>
          <div className="flex justify-between">
            <span>(+) Opening Float:</span>
            <span>{formatCurrency(openingFloat)}</span>
          </div>
          <div className="flex justify-between">
            <span>(+) Cash Sales:</span>
            <span>{formatCurrency(cashSalesAmount)}</span>
          </div>
          <div className="flex justify-between">
            <span>(-) Cash Expenses:</span>
            <span>-{formatCurrency(cashExpensesAmount)}</span>
          </div>
          <div className="flex justify-between font-bold border-t border-black pt-1">
            <span>Expected Cash:</span>
            <span>{formatCurrency(expectedCashInDrawer)}</span>
          </div>
          <div className="flex justify-between font-bold">
            <span>Actual Counted:</span>
            <span>{formatCurrency(actualCashCounted)}</span>
          </div>
          <div className="flex justify-between font-bold text-sm">
            <span>OVER / SHORT:</span>
            <span>
              {discrepancy >= 0 ? "+" : ""}
              {formatCurrency(discrepancy)}
            </span>
          </div>
        </div>

        <div className="border-b border-black my-2" />

        <div className="space-y-1">
          <p className="font-bold">NON-CASH TENDERS:</p>
          {digitalPayments.map((p) => (
            <div key={p.method} className="flex justify-between">
              <span className="capitalize">{p.method}:</span>
              <span>{formatCurrency(p.amount)}</span>
            </div>
          ))}
          <div className="flex justify-between font-bold">
            <span>Total Digital:</span>
            <span>{formatCurrency(totalDigitalCollections)}</span>
          </div>
        </div>

        <div className="border-b border-black my-3" />

        <div className="pt-4 space-y-6 text-center">
          <div>
            <div className="border-b border-black w-36 mx-auto mb-1" />
            <p className="text-[10px]">Cashier Signature</p>
          </div>
          <div>
            <div className="border-b border-black w-36 mx-auto mb-1" />
            <p className="text-[10px]">Manager / Supervisor Signature</p>
          </div>
        </div>
      </div>
    </div>
  );
}

