import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { CheckCircle2, Printer, Eye, PlusCircle, Check, Copy } from "lucide-react";
import type { SaleReceiptData } from "../../types/receipt.types.js";
import { resolveReceiptConfig, usePrintReceipt } from "../../hooks/usePrintReceipt.js";
import { ReceiptPrintDialog } from "./ReceiptPrintDialog.js";

interface SaleSuccessDialogProps {
  receipt: SaleReceiptData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewSale: () => void;
}

export function SaleSuccessDialog({
  receipt,
  open,
  onOpenChange,
  onNewSale,
}: SaleSuccessDialogProps) {
  const { printReceipt } = usePrintReceipt();
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Auto-print is driven by the business's SAVED receipt template — carried
  // on the receipt payload itself (falls back to local settings for
  // legacy/offline receipts).
  const autoPrintOnSale = receipt ? resolveReceiptConfig(receipt).print.autoPrintOnSale : false;

  // StrictMode / Remount safe ref guard for auto-printing
  const autoPrintedRef = useRef<number | null>(null);

  useEffect(() => {
    if (open && receipt && autoPrintOnSale) {
      if (autoPrintedRef.current !== receipt.saleId) {
        autoPrintedRef.current = receipt.saleId;
        // Schedule print after dialog mounts
        const timer = setTimeout(() => {
          printReceipt(receipt, { isAutoPrint: true });
        }, 300);
        return () => clearTimeout(timer);
      }
    }
  }, [open, receipt, autoPrintOnSale, printReceipt]);

  if (!receipt) return null;

  const handleCopyInvoice = () => {
    navigator.clipboard.writeText(receipt.invoiceNumber);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDirectPrint = () => {
    printReceipt(receipt);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md p-6 overflow-hidden">
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="size-14 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center animate-in zoom-in-75 duration-200">
              <CheckCircle2 className="size-9" />
            </div>

            <DialogHeader className="space-y-1">
              <DialogTitle className="text-xl font-bold">
                Sale Completed Successfully!
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                Transaction recorded and inventory updated.
              </DialogDescription>
            </DialogHeader>

            {/* Invoice & Total Highlight Box */}
            <div className="w-full bg-muted/50 rounded-xl p-4 border space-y-2.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Invoice Number:</span>
                <button
                  type="button"
                  onClick={handleCopyInvoice}
                  className="font-mono font-bold flex items-center gap-1.5 hover:text-primary transition-colors cursor-pointer"
                  title="Click to copy invoice"
                >
                  <span>{receipt.invoiceNumber}</span>
                  {copied ? (
                    <Check className="size-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="size-3.5 text-muted-foreground" />
                  )}
                </button>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Final Total:</span>
                <span className="font-mono font-bold text-base text-foreground">
                  ৳{receipt.finalTotal.toFixed(2)}
                </span>
              </div>

              <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
                <span>Amount Paid:</span>
                <span className="font-mono font-medium text-foreground">
                  ৳{receipt.paidAmount.toFixed(2)}
                </span>
              </div>

              {receipt.change > 0 && (
                <div className="flex items-center justify-between text-xs text-emerald-600 font-medium">
                  <span>Change Due to Customer:</span>
                  <span className="font-mono font-bold">
                    ৳{receipt.change.toFixed(2)}
                  </span>
                </div>
              )}

              {receipt.dueAmount > 0 && (
                <div className="flex items-center justify-between text-xs text-red-600 font-semibold">
                  <span>Outstanding Balance:</span>
                  <span className="font-mono font-bold">
                    ৳{receipt.dueAmount.toFixed(2)}
                  </span>
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="flex-col sm:flex-col gap-2 mt-4 pt-2 border-t">
            <div className="grid grid-cols-2 gap-2 w-full">
              <Button
                type="button"
                className="w-full gap-2"
                onClick={handleDirectPrint}
              >
                <Printer className="size-4" />
                Print Receipt
              </Button>

              <Button
                type="button"
                variant="outline"
                className="w-full gap-2"
                onClick={() => setIsPreviewOpen(true)}
              >
                <Eye className="size-4" />
                Preview
              </Button>
            </div>

            <Button
              type="button"
              variant="secondary"
              className="w-full gap-2 mt-1"
              onClick={() => {
                onOpenChange(false);
                onNewSale();
              }}
            >
              <PlusCircle className="size-4" />
              New Sale
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Embedded preview modal */}
      <ReceiptPrintDialog
        receipt={receipt}
        open={isPreviewOpen}
        onOpenChange={setIsPreviewOpen}
      />
    </>
  );
}

