import React from "react";
import type {
  SaleReceiptData,
  PaperWidth,
  ReceiptSettings,
} from "../../types/receipt.types.js";
import { useReceiptSettingsStore } from "../../stores/useReceiptSettingsStore.js";

interface ReceiptTemplateProps {
  receipt: SaleReceiptData;
  settings?: Partial<ReceiptSettings>;
  paperWidth?: PaperWidth;
  className?: string;
  isPrintPreview?: boolean;
}

export const ReceiptTemplate = React.forwardRef<
  HTMLDivElement,
  ReceiptTemplateProps
>(function ReceiptTemplate(
  { receipt, settings: customSettings, paperWidth: propPaperWidth, className = "", isPrintPreview = false },
  ref,
) {
  const globalSettings = useReceiptSettingsStore((s) => s.settings);
  const settings = { ...globalSettings, ...customSettings };
  const paperWidth = propPaperWidth || settings.paperWidth || "80mm";

  const is58mm = paperWidth === "58mm";
  const isA4 = paperWidth === "a4";

  const formattedDate = React.useMemo(() => {
    try {
      const d = new Date(receipt.saleDate || receipt.createdAt || new Date());
      return isNaN(d.getTime())
        ? new Date().toLocaleString("en-GB")
        : d.toLocaleString("en-GB", {
            dateStyle: "medium",
            timeStyle: "short",
          });
    } catch {
      return new Date().toLocaleString();
    }
  }, [receipt.saleDate, receipt.createdAt]);

  const money = (val: number | null | undefined) =>
    (Number(val) || 0).toLocaleString("en-BD", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  // Calculate width style
  const containerWidthClass = isA4
    ? "w-full max-w-[210mm] mx-auto p-8 bg-white text-black"
    : is58mm
      ? "w-[58mm] max-w-[58mm] mx-auto p-2 bg-white text-black text-[10px] leading-tight"
      : "w-[80mm] max-w-[80mm] mx-auto p-3 bg-white text-black text-[12px] leading-normal";

  return (
    <div
      ref={ref}
      className={`receipt-container select-none font-mono text-zinc-900 bg-white ${containerWidthClass} ${className}`}
      style={{
        boxSizing: "border-box",
        wordBreak: "break-word",
      }}
    >
      {/* Header section */}
      <div className="text-center pb-2">
        {settings.logoUrl && (
          <div className="flex justify-center mb-1">
            <img
              src={settings.logoUrl}
              alt={settings.shopName}
              className="max-h-12 object-contain grayscale"
            />
          </div>
        )}
        <h1 className={`font-bold tracking-tight uppercase ${is58mm ? "text-sm" : isA4 ? "text-2xl" : "text-base"}`}>
          {settings.shopName}
        </h1>
        {settings.tagline && (
          <p className="text-[10px] text-zinc-600">{settings.tagline}</p>
        )}
        {settings.address && (
          <p className="text-[10px] text-zinc-700 mt-0.5">{settings.address}</p>
        )}
        {settings.phone && (
          <p className="text-[10px] text-zinc-700">Phone: {settings.phone}</p>
        )}
      </div>

      {/* Title & metadata */}
      <div className="border-t border-b border-dashed border-zinc-500 py-1.5 my-1 text-[11px]">
        <div className="text-center font-bold uppercase tracking-wider text-[11px] mb-1">
          {settings.headerMessage || "CASH MEMO / INVOICE"}
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-600">Invoice:</span>
          <span className="font-bold">{receipt.invoiceNumber}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-600">Date:</span>
          <span>{formattedDate}</span>
        </div>
        {settings.cashierName && (
          <div className="flex justify-between">
            <span className="text-zinc-600">Cashier:</span>
            <span>{settings.cashierName}</span>
          </div>
        )}

        {settings.showCustomerInfo && (
          <div className="mt-1 pt-1 border-t border-dotted border-zinc-400">
            <div className="flex justify-between">
              <span className="text-zinc-600">Customer:</span>
              <span className="font-semibold text-right">
                {receipt.customer?.name || "Walk-in Customer"}
              </span>
            </div>
            {receipt.customer?.phone && (
              <div className="flex justify-between">
                <span className="text-zinc-600">Phone:</span>
                <span>{receipt.customer.phone}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Items list */}
      <div className="my-2">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-zinc-800 text-[10px] uppercase font-bold">
              <th className="py-1 pr-1 text-left">Item</th>
              <th className="py-1 px-1 text-center w-8">Qty</th>
              <th className="py-1 px-1 text-right w-12">Price</th>
              <th className="py-1 pl-1 text-right w-14">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dotted divide-zinc-300 text-[11px]">
            {receipt.items.map((item, idx) => (
              <tr key={item.id || idx} className="align-top">
                <td className="py-1 pr-1">
                  <div className="font-medium leading-snug">
                    {item.productName}
                  </div>
                  {item.variantName && (
                    <div className="text-[10px] text-zinc-500 leading-tight">
                      {item.variantName}
                    </div>
                  )}
                  {item.discount > 0 && (
                    <div className="text-[9px] text-zinc-600">
                      (Disc: -৳{money(item.discount)})
                    </div>
                  )}
                </td>
                <td className="py-1 px-1 text-center font-mono">
                  {item.quantity}
                </td>
                <td className="py-1 px-1 text-right font-mono text-[10px]">
                  {money(item.unitPrice)}
                </td>
                <td className="py-1 pl-1 text-right font-mono font-medium">
                  {money(item.lineTotal)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Totals Section */}
      <div className="border-t border-zinc-800 pt-1.5 space-y-1 text-[11px]">
        <div className="flex justify-between">
          <span>Subtotal:</span>
          <span className="font-mono">৳{money(receipt.subtotal)}</span>
        </div>

        {receipt.discount > 0 && (
          <div className="flex justify-between text-zinc-700">
            <span>Discount:</span>
            <span className="font-mono">-৳{money(receipt.discount)}</span>
          </div>
        )}

        {receipt.vat > 0 && (
          <div className="flex justify-between text-zinc-700">
            <span>VAT / Tax:</span>
            <span className="font-mono">+৳{money(receipt.vat)}</span>
          </div>
        )}

        <div className="flex justify-between items-center py-1.5 border-t border-b border-zinc-800 text-sm font-bold">
          <span className="uppercase">Final Payable:</span>
          <span className="font-mono text-base">৳{money(receipt.finalTotal)}</span>
        </div>
      </div>

      {/* Payments Section */}
      <div className="my-2 text-[11px] space-y-1 bg-zinc-50/70 p-1.5 rounded border border-zinc-200">
        <div className="font-bold uppercase text-[10px] text-zinc-600 tracking-wider">
          Payment Breakdown
        </div>
        {receipt.payments && receipt.payments.length > 0 ? (
          receipt.payments.map((p, idx) => (
            <div key={idx} className="flex justify-between items-center text-[10px]">
              <span className="capitalize font-medium">
                {p.method.replace("_", " ")}:
                {p.reference ? (
                  <span className="text-[9px] text-zinc-500 ml-1">
                    ({p.reference})
                  </span>
                ) : null}
              </span>
              <span className="font-mono font-semibold">৳{money(p.amount)}</span>
            </div>
          ))
        ) : (
          <div className="flex justify-between text-[10px]">
            <span>Paid:</span>
            <span className="font-mono">৳{money(receipt.paidAmount)}</span>
          </div>
        )}

        {/* Cash Tendered & Change if cash used */}
        {receipt.payments?.some((p) => p.method === "cash" && p.tendered) && (
          <div className="pt-1 border-t border-dotted border-zinc-300 text-[10px]">
            {receipt.payments
              .filter((p) => p.method === "cash" && p.tendered)
              .map((p, i) => (
                <div key={i} className="flex justify-between text-zinc-600">
                  <span>Cash Tendered:</span>
                  <span className="font-mono">৳{money(p.tendered)}</span>
                </div>
              ))}
          </div>
        )}

        {receipt.change > 0 && (
          <div className="flex justify-between text-[10px] font-semibold text-emerald-800">
            <span>Change Returned:</span>
            <span className="font-mono">৳{money(receipt.change)}</span>
          </div>
        )}

        {/* Due amount distinguished */}
        {receipt.dueAmount > 0 ? (
          <div className="flex justify-between text-[11px] font-bold text-red-700 pt-1 border-t border-dashed border-red-300">
            <span>OUTSTANDING DUE:</span>
            <span className="font-mono">৳{money(receipt.dueAmount)}</span>
          </div>
        ) : (
          <div className="text-center font-bold text-[9px] text-zinc-500 pt-0.5 uppercase tracking-widest">
            *** PAID IN FULL ***
          </div>
        )}
      </div>

      {/* Barcode & Footer policies */}
      <div className="mt-3 text-center space-y-1.5 pt-1 border-t border-dashed border-zinc-400">
        {/* Simple barcode rendering */}
        <div className="flex flex-col items-center justify-center my-1">
          <div
            className="flex items-center justify-center h-7 gap-[1.5px] px-2 overflow-hidden"
            aria-label={`Barcode for ${receipt.invoiceNumber}`}
          >
            {/* Monochromatic Barcode Pattern */}
            {[2, 1, 3, 1, 2, 4, 1, 3, 2, 1, 4, 2, 1, 3, 2, 3, 1, 2, 4, 1, 2, 3, 1, 4, 1, 2, 3].map(
              (w, i) => (
                <span
                  key={i}
                  className="bg-black inline-block h-full"
                  style={{ width: `${w * (is58mm ? 1 : 1.4)}px` }}
                />
              ),
            )}
          </div>
          <span className="text-[9px] font-mono tracking-widest text-zinc-600">
            *{receipt.invoiceNumber}*
          </span>
        </div>

        {settings.footerMessage && (
          <p className="font-medium text-[10px]">{settings.footerMessage}</p>
        )}

        {settings.returnPolicy && (
          <p className="text-[9px] text-zinc-500 leading-tight">
            {settings.returnPolicy}
          </p>
        )}

        <div className="text-[8px] text-zinc-400 pt-1">
          ezPos Software • Powered by Advanced POS System
        </div>
      </div>
    </div>
  );
});

