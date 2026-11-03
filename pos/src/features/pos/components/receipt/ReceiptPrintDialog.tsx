import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Printer, Settings2, Loader2 } from "lucide-react";
import { Link } from "react-router";
import type { SaleReceiptData } from "../../types/receipt.types.js";
import { usePrintReceipt } from "../../hooks/usePrintReceipt.js";
import { HardwareSettings } from "./HardwareSettings.js";
import { usePermissions } from "@/hooks/usePermissions.js";
import {
  normalizeInvoiceConfig,
  normalizeReceiptConfig,
} from "@/features/receipt-settings/schemas/documentSettings.schema.js";
import { renderReceiptHtml } from "@/features/receipt-settings/renderers/receiptHtml.js";
import { renderInvoiceHtml } from "@/features/receipt-settings/renderers/invoiceHtml.js";
import { resolveBranding, resolveInvoiceConfig, resolveReceiptConfig } from "../../hooks/usePrintReceipt.js";

type PreviewMode = "58mm" | "80mm" | "invoice";

interface ReceiptPrintDialogProps {
  receipt: SaleReceiptData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Preview & print dialog used from the sales history and the post-sale
 * success dialog. The preview is rendered by the SAME HTML renderer the
 * printer receives (shared with /settings/receipt), so they cannot drift.
 */
export function ReceiptPrintDialog({
  receipt,
  open,
  onOpenChange,
}: ReceiptPrintDialogProps) {
  const { printReceipt, printInvoice } = usePrintReceipt();
  const { hasPermission } = usePermissions();
  const canCustomize = hasPermission("receipt_settings.view");
  const [mode, setMode] = useState<PreviewMode>("80mm");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    if (!open || !receipt) return;
    setMode((prev) => {
      if (prev === "invoice") return prev;
      const cfg = resolveReceiptConfig(receipt);
      return cfg.paperWidth;
    });
  }, [open, receipt]);

  // Live preview: the exact document that will print.
  useEffect(() => {
    if (!open || !receipt) {
      setPreviewHtml(null);
      return;
    }
    let cancelled = false;
    setRendering(true);
    const timer = setTimeout(async () => {
      try {
        if (mode === "invoice") {
          const config = resolveInvoiceConfig(receipt);
          const result = renderInvoiceHtml({
            receipt,
            branding: resolveBranding(receipt),
            config,
          });
          if (!cancelled) setPreviewHtml(result.html);
        } else {
          const config = {
            ...resolveReceiptConfig(receipt),
            paperWidth: mode,
            print: { ...resolveReceiptConfig(receipt).print, copies: 1 },
          };
          const result = await renderReceiptHtml({
            receipt,
            branding: resolveBranding(receipt),
            config,
            copies: 1,
          });
          if (!cancelled) setPreviewHtml(result.html);
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, receipt, mode]);

  if (!receipt) return null;

  const handlePrint = () => {
    if (mode === "invoice") {
      void printInvoice(receipt);
    } else {
      void printReceipt(receipt, { paperWidth: mode });
    }
  };

  const paperWidthCss =
    mode === "58mm" ? "58mm" : mode === "80mm" ? "80mm" : "210mm";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[95dvh] w-[95vw] max-w-2xl overflow-hidden flex flex-col p-0">
        <DialogHeader className="p-4 border-b shrink-0 flex flex-row items-center justify-between space-y-0">
          <div>
            <DialogTitle className="text-lg font-bold">
              Document Preview & Print
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Invoice #{receipt.invoiceNumber} • ৳{receipt.finalTotal.toFixed(2)}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {canCustomize && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1 text-xs"
                render={
                  <Link to="/settings/receipt" onClick={() => onOpenChange(false)} />
                }
              >
                <Settings2 className="size-3.5" />
                Customize
              </Button>
            )}
          </div>
        </DialogHeader>

        {/* Document mode tabs */}
        <div className="px-4 py-2 bg-muted/40 border-b flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground font-medium">Document:</span>
            {(["58mm", "80mm", "invoice"] as PreviewMode[]).map((m) => (
              <Button
                key={m}
                type="button"
                variant={mode === m ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs px-2.5 uppercase"
                onClick={() => setMode(m)}
              >
                {m === "invoice" ? "Invoice (A4)" : m}
              </Button>
            ))}
          </div>

          <span className="text-muted-foreground hidden sm:inline">
            Same layout as your saved template
          </span>
        </div>

        {/* Hardware settings (USB printer mode) */}
        <div className="px-4 py-2 border-b shrink-0">
          <HardwareSettings />
        </div>

        {/* Scrollable Preview Area */}
        <div className="flex-1 overflow-y-auto p-4 bg-zinc-100 flex justify-center">
          {previewHtml ? (
            <iframe
              title="Receipt preview"
              srcDoc={previewHtml}
              className="rounded-sm border border-zinc-300 bg-white shadow-lg"
              style={{ width: paperWidthCss, minHeight: "320px", height: "60vh" }}
              sandbox="allow-same-origin"
            />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Rendering preview…
            </div>
          )}
        </div>

        <DialogFooter className="p-3 border-t bg-background shrink-0 flex sm:justify-between items-center gap-2">
          <div className="text-xs text-muted-foreground hidden sm:block">
            {rendering
              ? "Rendering…"
              : "Prints via the browser dialog to your configured printer"}
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              onClick={handlePrint}
            >
              <Printer className="size-4" />
              {mode === "invoice" ? "Print Invoice" : "Print Receipt"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
