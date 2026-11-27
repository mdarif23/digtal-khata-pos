import { useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/index.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { CheckCircle2, Check, Copy, Eye, PlusCircle, Printer, WifiOff } from "lucide-react";
import type { SaleReceiptData } from "../../types/receipt.types.js";
import { usePrintReceipt } from "../../hooks/usePrintReceipt.js";
import { ReceiptPrintDialog } from "./ReceiptPrintDialog.js";

/**
 * Offline twin of SaleSuccessDialog: the cashier gets the same
 * sale-is-done confirmation when the sale was recorded into the durable
 * outbox (offline mode, or the connection dropped mid-checkout). Honest by
 * design — no invoice number exists yet (the backend assigns it at sync
 * time), so the locally-generated outbox reference is shown instead, and
 * no print/send actions are offered (those need the server receipt).
 */
export interface OfflineSaleRecord {
  /** Full outbox clientSaleId — copied verbatim by the copy button. */
  reference: string;
  total: number;
  /** Cash portion paid at the counter (offline sales are cash/due only). */
  paid: number;
  /** Receivable recorded with the sale (syncs as sale due). */
  due: number;
  itemCount: number;
  customerName: string | null;
}

interface OfflineSaleRecordedDialogProps {
  record: OfflineSaleRecord | null;
  /** Locally-built provisional receipt (OFF- reference) for print/preview. */
  receipt: SaleReceiptData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewSale: () => void;
}

export function OfflineSaleRecordedDialog({
  record,
  receipt,
  open,
  onOpenChange,
  onNewSale,
}: OfflineSaleRecordedDialogProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const { printReceipt } = usePrintReceipt();
  if (!record) return null;

  const handleCopyReference = () => {
    navigator.clipboard.writeText(record.reference);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
              {t("saleSuccess:offlineTitle", {
                defaultValue: "Sale Recorded Offline!",
              })}
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              {t("saleSuccess:offlineSubtitle", {
                defaultValue:
                  "Saved on this device — it syncs automatically when the connection returns (duplicates are impossible).",
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="w-full bg-muted/50 rounded-xl p-4 border space-y-2.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {t("saleSuccess:offlineReference", {
                  defaultValue: "Offline Reference:",
                })}
              </span>
              <button
                type="button"
                onClick={handleCopyReference}
                className="font-mono font-bold flex items-center gap-1.5 hover:text-primary transition-colors cursor-pointer"
                title={t("saleSuccess:offlineCopyReference", {
                  defaultValue: "Click to copy the offline reference",
                })}
              >
                <span>{record.reference.slice(0, 8).toUpperCase()}</span>
                {copied ? (
                  <Check className="size-3.5 text-emerald-600" />
                ) : (
                  <Copy className="size-3.5 text-muted-foreground" />
                )}
              </button>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {t("saleSuccess:finalTotal", { defaultValue: "Final Total:" })}
              </span>
              <span className="font-mono font-bold text-base text-foreground">
                ৳{record.total.toFixed(2)}
              </span>
            </div>

            {record.paid > 0 && (
              <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
                <span>
                  {t("saleSuccess:amountPaid", { defaultValue: "Amount Paid:" })}
                </span>
                <span className="font-mono font-medium text-foreground">
                  ৳{record.paid.toFixed(2)}
                </span>
              </div>
            )}

            {record.due > 0 && (
              <div className="flex items-center justify-between text-xs text-red-600 font-semibold">
                <span>
                  {t("saleSuccess:outstandingBalance", {
                    defaultValue: "Outstanding Balance:",
                  })}
                </span>
                <span className="font-mono font-bold">
                  ৳{record.due.toFixed(2)}
                </span>
              </div>
            )}

            <div className="flex items-center gap-1.5 text-xs text-amber-700 pt-1 border-t">
              <WifiOff className="size-3.5 shrink-0" />
              <span>
                {t("saleSuccess:offlineInvoiceNote", {
                  defaultValue:
                    "The invoice number is assigned when this sale syncs.",
                })}
              </span>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-col gap-2 mt-4 pt-2 border-t">
          <div className="grid grid-cols-2 gap-2 w-full">
            {receipt && (
              <>
                <Button
                  type="button"
                  className="w-full gap-2"
                  onClick={() => printReceipt(receipt)}
                >
                  <Printer className="size-4" />
                  {t("saleSuccess:printReceipt", {
                    defaultValue: "Print Receipt",
                  })}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => setIsPreviewOpen(true)}
                >
                  <Eye className="size-4" />
                  {t("common:preview", { defaultValue: "Preview" })}
                </Button>
              </>
            )}
          </div>
          <Button
            type="button"
            variant="secondary"
            className="w-full gap-2"
            onClick={() => {
              onOpenChange(false);
              onNewSale();
            }}
          >
            <PlusCircle className="size-4" />
            {t("saleSuccess:newSale", { defaultValue: "New Sale" })}
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>

      {receipt && (
        <ReceiptPrintDialog
          receipt={receipt}
          open={isPreviewOpen}
          onOpenChange={setIsPreviewOpen}
        />
      )}
    </>
  );
}
