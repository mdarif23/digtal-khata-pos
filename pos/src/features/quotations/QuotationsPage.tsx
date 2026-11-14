import { useCallback, useEffect, useState } from "react";
import { Printer, RefreshCcw } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  convertQuotationApi,
  getQuotationApi,
  listQuotationsApi,
  transitionQuotationApi,
  type QuotationDetail,
  type QuotationRow,
  type QuotationStatus,
} from "./quotations.api";
import { formatCurrency } from "@/features/reports/utils/reportUtils";

function extractError(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: { data?: { message?: string } } }).response
      ?.data?.message === "string"
  ) {
    return (error as { response: { data: { message: string } } }).response.data
      .message;
  }
  return fallback;
}

const STATUS_FILTERS: { value: QuotationStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "converted", label: "Converted" },
  { value: "expired", label: "Expired" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
];

/**
 * Quotation workflow (Phase 2B): list, inspect, print, progress statuses
 * and convert accepted quotes into sales with payment.
 * Creation lives at the POS ("Save as quotation") — this page manages the
 * pipeline once a quote exists.
 */
export function QuotationsPage() {
  const [rows, setRows] = useState<QuotationRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<QuotationStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<QuotationDetail | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [cashReceived, setCashReceived] = useState("");
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await listQuotationsApi({
        ...(status !== "all" ? { status } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      setRows(data.rows);
      setTotal(data.total);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to load quotations."), type: "error" });
      setRows([]);
    }
  }, [status, search]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(id: number) {
    try {
      setDetail(await getQuotationApi(id));
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to load the quotation."), type: "error" });
    }
  }

  async function doTransition(id: number, to: "sent" | "accepted" | "rejected" | "cancelled") {
    setActing(true);
    try {
      await transitionQuotationApi(id, to);
      toast.add({ title: `Quotation ${to}.`, type: "success" });
      await openDetail(id);
      void load();
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to update the quotation."), type: "error" });
    } finally {
      setActing(false);
    }
  }

  async function doConvert() {
    if (!detail) return;
    const cash = Number(cashReceived);
    const totalDue = Number(detail.grandTotal);
    if (!Number.isFinite(cash) || cash < 0) {
      toast.add({ title: "Enter the received amount.", type: "error" });
      return;
    }
    const due = Math.max(0, totalDue - cash);
    setActing(true);
    try {
      const payments: { method: string; amount: number; tendered?: number }[] = [];
      if (cash > 0) payments.push({ method: "cash", amount: cash, tendered: cash });
      if (due > 0) payments.push({ method: "due", amount: due });
      if (payments.length === 0) payments.push({ method: "cash", amount: 0, tendered: 0 });
      const result = await convertQuotationApi(detail.id, payments);
      toast.add({
        title: `Converted to sale — ${result.quoteNumber}`,
        type: "success",
      });
      setConvertOpen(false);
      setDetail(null);
      void load();
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to convert the quotation."), type: "error" });
    } finally {
      setActing(false);
    }
  }

  function printQuotation() {
    if (!detail) return;
    const win = window.open("", "_blank", "width=800,height=900");
    if (!win) {
      toast.add({ title: "Allow pop-ups to print quotations.", type: "error" });
      return;
    }
    const itemsHtml = detail.items
      .map(
        (item) => `<tr>
          <td>${item.variantNameSnapshot}</td>
          <td style="text-align:right">${Number(item.quantity)}</td>
          <td style="text-align:right">${formatCurrency(Number(item.unitPrice))}</td>
          <td style="text-align:right">${formatCurrency(Number(item.discount))}</td>
          <td style="text-align:right">${formatCurrency(Number(item.lineTotal))}</td>
        </tr>`,
      )
      .join("");
    win.document.write(`<!doctype html><html><head><title>${detail.quoteNumber}</title>
      <style>body{font-family:system-ui,sans-serif;padding:32px;color:#111}
      h1{margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:16px}
      th,td{padding:6px 8px;border-bottom:1px solid #ddd;font-size:14px}
      th{text-align:left}
      .totals{margin-top:16px;width:280px;margin-left:auto}
      .totals div{display:flex;justify-content:space-between;padding:2px 0}
      .muted{color:#666;font-size:13px}</style></head><body>
      <h1>Quotation ${detail.quoteNumber}</h1>
      <div class="muted">${detail.customerNameSnapshot ?? "Walk-in customer"} · ${new Date(detail.createdAt).toLocaleDateString()}${detail.validUntil ? ` · valid until ${detail.validUntil}` : ""}</div>
      <table><thead><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit</th><th style="text-align:right">Discount</th><th style="text-align:right">Line</th></tr></thead>
      <tbody>${itemsHtml}</tbody></table>
      <div class="totals">
        <div><span>Subtotal</span><span>${formatCurrency(Number(detail.subtotal))}</span></div>
        <div><span>Discount</span><span>-${formatCurrency(Number(detail.discountTotal))}</span></div>
        <div><span>VAT (${Number(detail.vatPercent)}%)</span><span>${formatCurrency(Number(detail.vatTotal))}</span></div>
        <div style="font-weight:700"><span>Total</span><span>${formatCurrency(Number(detail.grandTotal))}</span></div>
      </div>
      ${detail.terms ? `<p class="muted">Terms: ${detail.terms}</p>` : ""}
      ${detail.notes ? `<p class="muted">${detail.notes}</p>` : ""}
      </body></html>`);
    win.document.close();
    win.print();
  }

  const canConvert =
    detail !== null && (detail.status === "accepted" || detail.status === "sent");

  return (
    <div className="grid gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Quotations</h1>
          <p className="text-sm text-muted-foreground">
            Offers and estimates — convert accepted quotes into sales.
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()}>
          <RefreshCcw className="size-4" /> Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={status === f.value ? "default" : "outline"}
            onClick={() => setStatus(f.value)}
          >
            {f.label}
          </Button>
        ))}
        <Input
          placeholder="Search number or customer"
          className="w-56"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {rows === null ? (
        <div className="grid gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No quotations match.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-2 font-medium">Number</th>
                <th className="p-2 font-medium">Customer</th>
                <th className="p-2 text-right font-medium">Total</th>
                <th className="p-2 font-medium">Status</th>
                <th className="p-2 font-medium">Valid until</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="cursor-pointer border-t hover:bg-muted/40"
                  onClick={() => void openDetail(row.id)}
                >
                  <td className="p-2 font-mono text-xs">{row.quoteNumber}</td>
                  <td className="p-2">{row.customerNameSnapshot ?? "Walk-in"}</td>
                  <td className="p-2 text-right font-mono">
                    {formatCurrency(Number(row.grandTotal))}
                  </td>
                  <td className="p-2">
                    <Badge variant="outline">{row.status}</Badge>
                  </td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {row.validUntil ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{total} quotation(s)</p>

      <Dialog open={detail !== null} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{detail?.quoteNumber}</DialogTitle>
            <DialogDescription>
              {detail
                ? `${detail.customerNameSnapshot ?? "Walk-in"} · ${detail.status}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="grid gap-3 text-sm">
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-1.5">Item</th>
                      <th className="p-1.5 text-right">Qty</th>
                      <th className="p-1.5 text-right">Unit</th>
                      <th className="p-1.5 text-right">Line</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((item) => (
                      <tr key={item.id} className="border-t">
                        <td className="p-1.5">{item.variantNameSnapshot}</td>
                        <td className="p-1.5 text-right">{Number(item.quantity)}</td>
                        <td className="p-1.5 text-right font-mono">
                          {formatCurrency(Number(item.unitPrice))}
                        </td>
                        <td className="p-1.5 text-right font-mono">
                          {formatCurrency(Number(item.lineTotal))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end gap-6 text-sm">
                <span className="text-muted-foreground">
                  VAT: {formatCurrency(Number(detail.vatTotal))}
                </span>
                <span className="font-semibold">
                  Total: {formatCurrency(Number(detail.grandTotal))}
                </span>
              </div>
              {detail.terms ? (
                <p className="text-xs text-muted-foreground">Terms: {detail.terms}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {detail.status === "draft" ? (
                  <Button size="sm" variant="outline" disabled={acting} onClick={() => void doTransition(detail.id, "sent")}>
                    Mark sent
                  </Button>
                ) : null}
                {["draft", "sent"].includes(detail.status) ? (
                  <Button size="sm" disabled={acting} onClick={() => void doTransition(detail.id, "accepted")}>
                    Accept
                  </Button>
                ) : null}
                {["draft", "sent"].includes(detail.status) ? (
                  <Button size="sm" variant="outline" disabled={acting} onClick={() => void doTransition(detail.id, "rejected")}>
                    Reject
                  </Button>
                ) : null}
                {["draft", "sent", "accepted"].includes(detail.status) ? (
                  <Button size="sm" variant="ghost" disabled={acting} onClick={() => void doTransition(detail.id, "cancelled")}>
                    Cancel
                  </Button>
                ) : null}
                {canConvert ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setCashReceived(String(Number(detail.grandTotal)));
                      setConvertOpen(true);
                    }}
                  >
                    Convert to sale
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" className="gap-1.5" onClick={printQuotation}>
                  <Printer className="size-4" /> Print
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Convert to sale</DialogTitle>
            <DialogDescription>
              Stock is deducted once and the quotation links to the new sale.
              Enter the cash received — any remainder becomes due.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="conv-cash">
              Cash received (total {formatCurrency(Number(detail?.grandTotal ?? 0))})
            </Label>
            <Input
              id="conv-cash"
              type="number"
              min={0}
              value={cashReceived}
              onChange={(e) => setCashReceived(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => void doConvert()} disabled={acting}>
              {acting ? "Converting…" : "Convert"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
