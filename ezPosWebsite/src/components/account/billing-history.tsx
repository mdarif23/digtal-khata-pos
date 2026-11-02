"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/providers/auth-provider";
import { useActiveBusiness } from "@/hooks/useActiveBusiness";
import {
  fetchInvoices,
  fetchPayments,
  initiatePayment,
  type InvoiceSummary,
  type PaymentSummary,
} from "@/lib/api/portal";
import { downloadCsv, toCsv } from "@/lib/csv";

function Pager({
  page,
  onPage,
  hasMore,
}: {
  page: number;
  onPage: (next: number) => void;
  hasMore: boolean;
}) {
  if (page === 1 && !hasMore) return null;
  return (
    <div className="flex items-center gap-3 px-6 py-3 text-sm">
      <button
        type="button"
        disabled={page === 1}
        onClick={() => onPage(page - 1)}
        className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 disabled:opacity-40"
      >
        ← Previous
      </button>
      <span className="text-xs text-slate-500">Page {page}</span>
      <button
        type="button"
        disabled={!hasMore}
        onClick={() => onPage(page + 1)}
        className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 disabled:opacity-40"
      >
        Next →
      </button>
    </div>
  );
}

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function exportInvoicesCsv(invoices: InvoiceSummary[]) {
  const csv = toCsv(
    ["Invoice", "Period start", "Period end", "Issued", "Currency", "Total", "Status"],
    invoices.map((invoice) => [
      invoice.invoiceNumber,
      invoice.periodStart,
      invoice.periodEnd,
      invoice.issuedAt,
      invoice.currency,
      invoice.total,
      invoice.status,
    ]),
  );
  downloadCsv("ezpos-invoices.csv", csv);
}

export function BillingHistory() {
  const { businessId } = useActiveBusiness();
  const [invoicePage, setInvoicePage] = useState(1);
  const [paymentPage, setPaymentPage] = useState(1);
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null);
  const [payments, setPayments] = useState<PaymentSummary[] | null>(null);
  const [payingId, setPayingId] = useState<number | null>(null);
  const [payError, setPayError] = useState<string | null>(null);

  async function payNow(invoiceId: number) {
    if (!businessId) return;
    setPayError(null);
    setPayingId(invoiceId);
    const result = await initiatePayment(businessId, invoiceId);
    setPayingId(null);
    if (!result.ok || !result.data) {
      setPayError(result.message);
      return;
    }
    // Off to the gateway — the /payment/success page handles verification.
    window.location.assign(result.data.gatewayUrl);
  }

  useEffect(() => {
    if (!businessId) return;
    void (async () => {
      const [invoiceRes, paymentRes] = await Promise.all([
        fetchInvoices(businessId, invoicePage),
        fetchPayments(businessId, paymentPage),
      ]);
      setInvoices(invoiceRes.data ?? []);
      setPayments(paymentRes.data ?? []);
    })();
  }, [businessId, invoicePage, paymentPage]);

  if (!businessId) {
    return <p className="text-sm text-slate-500">No business yet.</p>;
  }
  if (invoices === null || payments === null) {
    return (
      <p className="py-12 text-center text-sm text-slate-500" role="status">
        Loading billing…
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Billing &amp; payments
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Invoices are issued for plan changes and renewals. Online card and
          mobile-wallet payments arrive with the payment integration.
        </p>
      </div>

      {payError ? (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900" role="alert">
          {payError}
        </p>
      ) : null}

      <Pager
        page={invoicePage}
        onPage={setInvoicePage}
        hasMore={(invoices?.length ?? 0) >= 25}
      />

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <h2 className="text-sm font-semibold text-slate-900">Invoices</h2>
          {invoices.length > 0 ? (
            <button
              type="button"
              onClick={() => exportInvoicesCsv(invoices)}
              className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Export CSV
            </button>
          ) : null}
        </div>
        {invoices.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-500">
            No invoices yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-6 py-2 font-medium">Invoice</th>
                <th className="px-6 py-2 font-medium">Period end</th>
                <th className="px-6 py-2 font-medium">Amount</th>
                <th className="px-6 py-2 font-medium">Status</th>
                <th className="px-6 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="px-6 py-3 font-medium text-slate-900">
                    {invoice.invoiceNumber}
                  </td>
                  <td className="px-6 py-3 text-slate-600">
                    {invoice.periodEnd
                      ? new Date(invoice.periodEnd).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="px-6 py-3 text-slate-600">
                    {money(invoice.total, invoice.currency)}
                  </td>
                  <td className="px-6 py-3">
                    <span
                      className={
                        invoice.status === "paid"
                          ? "font-medium text-green-700"
                          : "font-medium text-amber-700"
                      }
                    >
                      {invoice.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right">
                    {invoice.status === "pending" ? (
                      <button
                        type="button"
                        className="mr-3 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
                        disabled={payingId === invoice.id}
                        onClick={() => payNow(invoice.id)}
                      >
                        {payingId === invoice.id ? "Opening…" : "Pay now"}
                      </button>
                    ) : null}
                    <Link
                      href={`/account/invoices/${invoice.id}`}
                      className="font-medium text-indigo-700 hover:underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pager
        page={paymentPage}
        onPage={setPaymentPage}
        hasMore={(payments?.length ?? 0) >= 25}
      />

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <h2 className="border-b border-slate-100 px-6 py-4 text-sm font-semibold text-slate-900">
          Payments
        </h2>
        {payments.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-500">
            No payments recorded yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-6 py-2 font-medium">Date</th>
                <th className="px-6 py-2 font-medium">Invoice</th>
                <th className="px-6 py-2 font-medium">Amount</th>
                <th className="px-6 py-2 font-medium">Method</th>
                <th className="px-6 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td className="px-6 py-3 text-slate-600">
                    {payment.paidAt
                      ? new Date(payment.paidAt).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="px-6 py-3 font-medium text-slate-900">
                    {payment.invoiceNumber ?? "—"}
                  </td>
                  <td className="px-6 py-3 text-slate-600">
                    {money(payment.amount, payment.currency)}
                  </td>
                  <td className="px-6 py-3 text-slate-600">
                    {payment.provider ?? "—"}
                  </td>
                  <td className="px-6 py-3 font-medium text-slate-600">
                    {payment.status}
                    {payment.failureReason ? (
                      <span className="block text-xs text-red-600">
                        {payment.failureReason}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
