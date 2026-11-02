"use client";

import { useEffect, useState } from "react";
import { fetchAdminPayments, fetchAdminInvoices, type AdminInvoice, type AdminPayment } from "@/lib/api/saas-admin";

function money(amount: number, currency: string): string {
  return `${currency} ${Number(amount).toLocaleString()}`;
}

export function AdminPayments() {
  const [payments, setPayments] = useState<AdminPayment[] | null>(null);
  const [invoices, setInvoices] = useState<AdminInvoice[] | null>(null);

  useEffect(() => {
    void (async () => {
      const [paymentRes, invoiceRes] = await Promise.all([
        fetchAdminPayments(),
        fetchAdminInvoices(),
      ]);
      setPayments(paymentRes.data ?? []);
      setInvoices(invoiceRes.data ?? []);
    })();
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">
          Payments &amp; invoices
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Every gateway transaction and invoice across all businesses.
          Refund processing arrives with payment reconciliation.
        </p>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <h3 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
          Payments
        </h3>
        {payments === null ? (
          <p className="px-5 py-6 text-sm text-slate-500">Loading…</p>
        ) : payments.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No payments recorded yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2 font-medium">Business</th>
                <th className="px-5 py-2 font-medium">Invoice</th>
                <th className="px-5 py-2 font-medium">Amount</th>
                <th className="px-5 py-2 font-medium">Provider</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td className="px-5 py-3 font-medium text-slate-900">{payment.businessName}</td>
                  <td className="px-5 py-3 text-slate-600">{payment.invoiceNumber ?? "—"}</td>
                  <td className="px-5 py-3 text-slate-600">{money(payment.amount, payment.currency)}</td>
                  <td className="px-5 py-3 text-slate-600">{payment.provider ?? "—"}</td>
                  <td className="px-5 py-3">
                    <span className="font-medium text-slate-700">{payment.status}</span>
                    {payment.failureReason ? (
                      <span className="block max-w-xs text-xs text-red-600">{payment.failureReason}</span>
                    ) : null}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {payment.paidAt
                      ? new Date(payment.paidAt).toLocaleDateString()
                      : payment.createdAt
                        ? new Date(payment.createdAt).toLocaleDateString()
                        : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <h3 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
          Invoices
        </h3>
        {invoices === null ? (
          <p className="px-5 py-6 text-sm text-slate-500">Loading…</p>
        ) : invoices.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No invoices issued yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2 font-medium">Invoice</th>
                <th className="px-5 py-2 font-medium">Business</th>
                <th className="px-5 py-2 font-medium">Amount</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Issued</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="px-5 py-3 font-medium text-slate-900">{invoice.invoiceNumber}</td>
                  <td className="px-5 py-3 text-slate-600">{invoice.businessName}</td>
                  <td className="px-5 py-3 text-slate-600">{money(invoice.total, invoice.currency)}</td>
                  <td className="px-5 py-3">
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
                  <td className="px-5 py-3 text-slate-600">
                    {new Date(invoice.issuedAt).toLocaleDateString()}
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
