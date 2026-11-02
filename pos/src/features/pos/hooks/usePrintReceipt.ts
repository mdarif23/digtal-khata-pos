import { useCallback, useRef } from "react";
import type { SaleReceiptData, PaperWidth, ReceiptSettings } from "../types/receipt.types.js";
import { useReceiptSettingsStore } from "../stores/useReceiptSettingsStore.js";
import { useHardwareStore, toPrintPayload } from "@/hardware/deviceManager";

// Global set across mounts to prevent duplicate automatic prints for the same sale
const printedSaleIds = new Set<string | number>();

export function usePrintReceipt() {
  const settings = useReceiptSettingsStore((s) => s.settings);
  const isPrintingRef = useRef(false);

  const printReceipt = useCallback(
    async (receipt: SaleReceiptData, options?: { paperWidth?: PaperWidth; settings?: Partial<ReceiptSettings>; isAutoPrint?: boolean }) => {
      if (!receipt || !receipt.saleId) {
        console.warn("Print receipt called without valid receipt data");
        return false;
      }

      // Guard: If auto-print, ensure it only triggers once per sale
      if (options?.isAutoPrint) {
        if (printedSaleIds.has(receipt.saleId)) {
          return false;
        }
        printedSaleIds.add(receipt.saleId);
      }

      if (isPrintingRef.current) {
        return false;
      }
      isPrintingRef.current = true;

      const activeSettings = { ...settings, ...options?.settings };

      // Hardware path (Module 9): a connected USB thermal printer prints
      // directly — no browser dialog. ANY failure falls through to the
      // browser-print pipeline below, so a device problem can never lose
      // or corrupt a receipt.
      const hardware = useHardwareStore.getState();
      if (hardware.mode === "usb") {
        const result = await hardware.printReceipt(
          toPrintPayload(
            receipt,
            activeSettings.shopName,
            activeSettings.footerMessage,
          ),
          async () => false, // no-op: the browser fallback is the code below
        );
        if (result.ok && result.mode === "usb") {
          isPrintingRef.current = false;
          return true;
        }
        // Fall through to the browser print below.
      }

      const paperWidth = options?.paperWidth || activeSettings.paperWidth || "80mm";
      const is58mm = paperWidth === "58mm";
      const isA4 = paperWidth === "a4";

      const targetWidth = is58mm ? "58mm" : isA4 ? "210mm" : "80mm";
      const pageMargin = isA4 ? "15mm" : "0mm";

      // Create isolated invisible iframe for printing
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      iframe.style.visibility = "hidden";
      iframe.setAttribute("aria-hidden", "true");

      document.body.appendChild(iframe);

      const frameDoc = iframe.contentWindow?.document;
      if (!frameDoc) {
        document.body.removeChild(iframe);
        isPrintingRef.current = false;
        return false;
      }

      // Format helpers
      const money = (val: number | null | undefined) =>
        (Number(val) || 0).toLocaleString("en-BD", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

      let formattedDate = "";
      try {
        const d = new Date(receipt.saleDate || receipt.createdAt || new Date());
        formattedDate = isNaN(d.getTime())
          ? new Date().toLocaleString("en-GB")
          : d.toLocaleString("en-GB", {
              dateStyle: "medium",
              timeStyle: "short",
            });
      } catch {
        formattedDate = new Date().toLocaleString();
      }

      // Generate HTML for receipt
      const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Receipt - ${receipt.invoiceNumber}</title>
  <style>
    @page {
      size: ${targetWidth} auto;
      margin: ${pageMargin};
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: ${is58mm ? "3mm 2mm" : isA4 ? "10mm" : "4mm 3mm"};
      width: ${targetWidth};
      max-width: ${targetWidth};
      background: #fff;
      color: #000;
      font-family: 'Courier New', Courier, monospace, monospace;
      font-size: ${is58mm ? "10px" : isA4 ? "13px" : "11px"};
      line-height: 1.25;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .text-left { text-align: left; }
    .bold { font-weight: bold; }
    .uppercase { text-transform: uppercase; }
    .divider {
      border-top: 1px dashed #000;
      margin: 4px 0;
    }
    .divider-double {
      border-top: 1px solid #000;
      border-bottom: 1px solid #000;
      padding: 3px 0;
      margin: 4px 0;
    }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 2px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 4px 0;
    }
    th {
      border-bottom: 1px solid #000;
      padding: 3px 1px;
      font-size: ${is58mm ? "9px" : "10px"};
      text-transform: uppercase;
    }
    td {
      padding: 3px 1px;
      vertical-align: top;
      border-bottom: 1px dotted #ccc;
    }
    .item-title {
      font-weight: bold;
    }
    .item-sub {
      font-size: 85%;
      color: #333;
    }
    .total-row {
      font-size: ${is58mm ? "12px" : "13px"};
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      border-top: 1px solid #000;
      border-bottom: 1px solid #000;
      padding: 4px 0;
      margin: 4px 0;
    }
    .payments-box {
      background: #f9f9f9;
      border: 1px solid #ddd;
      padding: 4px;
      margin: 4px 0;
    }
    .due-alert {
      color: #000;
      font-weight: bold;
      border-top: 1px dashed #000;
      padding-top: 3px;
      margin-top: 3px;
    }
    .barcode {
      display: flex;
      justify-content: center;
      gap: 1.5px;
      height: 24px;
      margin: 6px 0 2px;
    }
    .bar {
      background: #000;
      height: 100%;
      display: inline-block;
    }
    .footer-note {
      font-size: 85%;
      margin-top: 4px;
      line-height: 1.2;
    }
  </style>
</head>
<body>
  <div class="text-center">
    ${activeSettings.logoUrl ? `<img src="${activeSettings.logoUrl}" style="max-height: 40px; margin-bottom: 4px;" />` : ""}
    <div class="bold uppercase" style="font-size: ${is58mm ? "13px" : "15px"};">${activeSettings.shopName}</div>
    ${activeSettings.tagline ? `<div class="item-sub">${activeSettings.tagline}</div>` : ""}
    ${activeSettings.address ? `<div class="item-sub">${activeSettings.address}</div>` : ""}
    ${activeSettings.phone ? `<div class="item-sub">Phone: ${activeSettings.phone}</div>` : ""}
  </div>

  <div class="divider"></div>
  <div class="text-center bold uppercase" style="font-size: ${is58mm ? "10px" : "11px"}; margin-bottom: 3px;">
    ${activeSettings.headerMessage || "CASH MEMO / INVOICE"}
  </div>

  <div class="row">
    <span>Invoice:</span>
    <span class="bold">${receipt.invoiceNumber}</span>
  </div>
  <div class="row">
    <span>Date:</span>
    <span>${formattedDate}</span>
  </div>
  ${activeSettings.cashierName ? `
  <div class="row">
    <span>Cashier:</span>
    <span>${activeSettings.cashierName}</span>
  </div>` : ""}

  ${activeSettings.showCustomerInfo ? `
  <div class="divider"></div>
  <div class="row">
    <span>Customer:</span>
    <span class="bold">${receipt.customer?.name || "Walk-in Customer"}</span>
  </div>
  ${receipt.customer?.phone ? `
  <div class="row">
    <span>Phone:</span>
    <span>${receipt.customer.phone}</span>
  </div>` : ""}
  ` : ""}

  <div class="divider"></div>

  <table>
    <thead>
      <tr>
        <th class="text-left">Item</th>
        <th class="text-center" style="width: 25px;">Qty</th>
        <th class="text-right" style="width: 45px;">Price</th>
        <th class="text-right" style="width: 50px;">Total</th>
      </tr>
    </thead>
    <tbody>
      ${receipt.items
        .map(
          (item) => `
        <tr>
          <td>
            <div class="item-title">${item.productName}</div>
            ${item.variantName ? `<div class="item-sub">${item.variantName}</div>` : ""}
            ${item.discount > 0 ? `<div class="item-sub">Disc: -৳${money(item.discount)}</div>` : ""}
          </td>
          <td class="text-center">${item.quantity}</td>
          <td class="text-right">${money(item.unitPrice)}</td>
          <td class="text-right bold">${money(item.lineTotal)}</td>
        </tr>
      `,
        )
        .join("")}
    </tbody>
  </table>

  <div class="row">
    <span>Subtotal:</span>
    <span>৳${money(receipt.subtotal)}</span>
  </div>

  ${receipt.discount > 0 ? `
  <div class="row">
    <span>Discount:</span>
    <span>-৳${money(receipt.discount)}</span>
  </div>` : ""}

  ${receipt.vat > 0 ? `
  <div class="row">
    <span>VAT / Tax:</span>
    <span>+৳${money(receipt.vat)}</span>
  </div>` : ""}

  <div class="total-row">
    <span>FINAL PAYABLE:</span>
    <span>৳${money(receipt.finalTotal)}</span>
  </div>

  <div class="payments-box">
    <div class="bold uppercase" style="font-size: 85%; margin-bottom: 2px;">Payment Breakdown</div>
    ${
      receipt.payments && receipt.payments.length > 0
        ? receipt.payments
            .map(
              (p) => `
      <div class="row">
        <span>${p.method.replace("_", " ")}${p.reference ? ` (${p.reference})` : ""}:</span>
        <span class="bold">৳${money(p.amount)}</span>
      </div>
    `,
            )
            .join("")
        : `
      <div class="row">
        <span>Paid:</span>
        <span class="bold">৳${money(receipt.paidAmount)}</span>
      </div>
    `
    }

    ${
      receipt.payments?.some((p) => p.method === "cash" && p.tendered)
        ? receipt.payments
            .filter((p) => p.method === "cash" && p.tendered)
            .map(
              (p) => `
          <div class="row" style="font-size: 85%; color: #444;">
            <span>Cash Tendered:</span>
            <span>৳${money(p.tendered)}</span>
          </div>
        `,
            )
            .join("")
        : ""
    }

    ${
      receipt.change > 0
        ? `
      <div class="row bold">
        <span>Change Returned:</span>
        <span>৳${money(receipt.change)}</span>
      </div>
    `
        : ""
    }

    ${
      receipt.dueAmount > 0
        ? `
      <div class="row due-alert">
        <span>OUTSTANDING DUE:</span>
        <span>৳${money(receipt.dueAmount)}</span>
      </div>
    `
        : `
      <div class="text-center bold" style="font-size: 80%; margin-top: 3px;">
        *** PAID IN FULL ***
      </div>
    `
    }
  </div>

  <div class="divider"></div>

  <div class="text-center">
    <div class="barcode">
      ${[2, 1, 3, 1, 2, 4, 1, 3, 2, 1, 4, 2, 1, 3, 2, 3, 1, 2, 4, 1, 2, 3, 1, 4, 1, 2, 3]
        .map((w) => `<span class="bar" style="width: ${w * (is58mm ? 1 : 1.4)}px;"></span>`)
        .join("")}
    </div>
    <div style="font-size: 85%;">*${receipt.invoiceNumber}*</div>

    ${activeSettings.footerMessage ? `<div class="footer-note bold">${activeSettings.footerMessage}</div>` : ""}
    ${activeSettings.returnPolicy ? `<div class="footer-note">${activeSettings.returnPolicy}</div>` : ""}
    <div style="font-size: 70%; color: #666; margin-top: 4px;">ezPos Retail System</div>
  </div>
</body>
</html>
      `;

      frameDoc.open();
      frameDoc.write(htmlContent);
      frameDoc.close();

      // Trigger print after iframe renders
      setTimeout(() => {
        try {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
        } catch (e) {
          console.error("Print invocation error:", e);
        } finally {
          // Cleanup iframe after browser print dialog is shown
          setTimeout(() => {
            if (document.body.contains(iframe)) {
              document.body.removeChild(iframe);
            }
            isPrintingRef.current = false;
          }, 1500);
        }
      }, 250);

      return true;
    },
    [settings],
  );

  return { printReceipt, settings };
}

