import { useCallback, useRef } from "react";
import type { SaleReceiptData } from "../types/receipt.types.js";
import { useReceiptSettingsStore } from "../stores/useReceiptSettingsStore.js";
import { useHardwareStore, toPrintPayload } from "@/hardware/deviceManager";
import {
  renderReceiptHtml,
  type ReceiptRenderInput,
} from "@/features/receipt-settings/renderers/receiptHtml.js";
import {
  renderInvoiceHtml,
  type InvoiceRenderInput,
} from "@/features/receipt-settings/renderers/invoiceHtml.js";
import {
  normalizeInvoiceConfig,
  normalizeReceiptConfig,
  type DocumentBranding,
  type InvoiceConfig,
  type ReceiptConfig,
} from "@/features/receipt-settings/schemas/documentSettings.schema.js";

// Global set across mounts to prevent duplicate automatic prints for the same sale
const printedSaleIds = new Set<string | number>();

const FALLBACK_BRANDING: DocumentBranding = {
  name: "ezPos Store",
  phone: null,
  email: null,
  address: null,
  website: null,
  vatBin: null,
  tagline: null,
  logoUrl: null,
  currency: "BDT",
};

/**
 * Branding for a receipt: prefer the server-embedded business profile; fall
 * back to the local receipt settings store for receipts created before the
 * customization module existed (or offline).
 */
export function resolveBranding(receipt: SaleReceiptData): DocumentBranding {
  if (receipt.business) {
    return { ...FALLBACK_BRANDING, ...receipt.business };
  }
  const s = useReceiptSettingsStore.getState().settings;
  return {
    name: s.shopName || FALLBACK_BRANDING.name,
    phone: s.phone || null,
    email: null,
    address: s.address || null,
    website: null,
    vatBin: null,
    tagline: s.tagline || null,
    logoUrl: s.logoUrl ?? null,
    currency: FALLBACK_BRANDING.currency,
  };
}

/**
 * Active receipt template: the server-embedded config validated and
 * default-filled; receipts without embedded settings (legacy/offline) map
 * the old localStorage fields onto the config shape.
 */
export function resolveReceiptConfig(receipt: SaleReceiptData): ReceiptConfig {
  if (receipt.documentSettings?.sales_receipt !== undefined) {
    return normalizeReceiptConfig(receipt.documentSettings.sales_receipt);
  }
  const s = useReceiptSettingsStore.getState().settings;
  return normalizeReceiptConfig({
    paperWidth: s.paperWidth === "58mm" ? "58mm" : "80mm",
    visibility: {
      customerName: s.showCustomerInfo,
      customerPhone: s.showCustomerInfo,
    },
    text: {
      title: s.headerMessage || "Sales Receipt",
      footerMessage: s.footerMessage,
      additionalMessage: s.returnPolicy,
    },
    print: { autoPrintOnSale: s.autoPrintOnSale },
  });
}

export function resolveInvoiceConfig(receipt: SaleReceiptData): InvoiceConfig {
  if (receipt.documentSettings?.sales_invoice !== undefined) {
    return normalizeInvoiceConfig(receipt.documentSettings.sales_invoice);
  }
  return normalizeInvoiceConfig({});
}

/** Writes a standalone document into a hidden iframe and opens the print dialog. */
function printHtmlInIframe(html: string, cleanupDelayMs = 1500): void {
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
    return;
  }

  frameDoc.open();
  frameDoc.write(html);
  frameDoc.close();

  setTimeout(() => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch (e) {
      console.error("Print invocation error:", e);
    } finally {
      setTimeout(() => {
        if (document.body.contains(iframe)) {
          document.body.removeChild(iframe);
        }
      }, cleanupDelayMs);
    }
  }, 250);
}

export interface PrintReceiptOptions {
  paperWidth?: "58mm" | "80mm";
  /** Draft overrides (test print from the settings page). */
  config?: Partial<ReceiptConfig>;
  branding?: DocumentBranding;
  copies?: number;
  isAutoPrint?: boolean;
}

export function usePrintReceipt() {
  const settings = useReceiptSettingsStore((s) => s.settings);
  const isPrintingRef = useRef(false);

  const printReceipt = useCallback(
    async (
      receipt: SaleReceiptData,
      options?: PrintReceiptOptions,
    ): Promise<boolean> => {
      if (
        !receipt ||
        receipt.saleId === undefined ||
        receipt.saleId === null
      ) {
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

      try {
        const branding = options?.branding ?? resolveBranding(receipt);
        const activeConfig = resolveReceiptConfig(receipt);
        const config: ReceiptConfig = {
          ...activeConfig,
          ...(options?.config ?? {}),
          layout: { ...activeConfig.layout, ...(options?.config?.layout ?? {}) },
          visibility: {
            ...activeConfig.visibility,
            ...(options?.config?.visibility ?? {}),
          },
          text: { ...activeConfig.text, ...(options?.config?.text ?? {}) },
          print: { ...activeConfig.print, ...(options?.config?.print ?? {}) },
        };
        if (options?.paperWidth) {
          config.paperWidth = options.paperWidth;
        }
        if (options?.copies) {
          config.print.copies = options.copies;
        }

        // Hardware path (Module 9): a connected USB thermal printer prints
        // directly — no browser dialog. ANY failure falls through to the
        // browser-print pipeline below, so a device problem can never lose
        // or corrupt a receipt. ESC/POS carries a subset of the document.
        const hardware = useHardwareStore.getState();
        if (hardware.mode === "usb") {
          const result = await hardware.printReceipt(
            toPrintPayload(receipt, branding.name, config.text.footerMessage),
            async () => false, // no-op: the browser fallback is below
          );
          if (result.ok && result.mode === "usb") {
            return true;
          }
          // Fall through to the browser print below.
        }

        const renderInput: ReceiptRenderInput = {
          receipt,
          branding,
          config,
        };
        const { html } = await renderReceiptHtml(renderInput);
        printHtmlInIframe(html);
        return true;
      } finally {
        // Release the lock once the print dialog has been invoked.
        setTimeout(() => {
          isPrintingRef.current = false;
        }, 400);
      }
    },
    [settings],
  );

  const printInvoice = useCallback(
    async (
      receipt: SaleReceiptData,
      options?: {
        config?: Partial<InvoiceConfig>;
        branding?: DocumentBranding;
      },
    ): Promise<boolean> => {
      if (!receipt) {
        console.warn("Print invoice called without valid receipt data");
        return false;
      }
      if (isPrintingRef.current) {
        return false;
      }
      isPrintingRef.current = true;

      try {
        const branding = options?.branding ?? resolveBranding(receipt);
        const activeConfig = resolveInvoiceConfig(receipt);
        const config: InvoiceConfig = {
          ...activeConfig,
          ...(options?.config ?? {}),
          visibility: {
            ...activeConfig.visibility,
            ...(options?.config?.visibility ?? {}),
          },
          text: { ...activeConfig.text, ...(options?.config?.text ?? {}) },
        };
        const { html } = renderInvoiceHtml({ receipt, branding, config });
        printHtmlInIframe(html);
        return true;
      } finally {
        setTimeout(() => {
          isPrintingRef.current = false;
        }, 400);
      }
    },
    [],
  );

  return { printReceipt, printInvoice, settings };
}
