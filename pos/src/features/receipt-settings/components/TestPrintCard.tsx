import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Label } from "@/components/ui/label.js";
import { PrinterCheck } from "lucide-react";
import { usePrintReceipt } from "@/features/pos/hooks/usePrintReceipt.js";
import type { DocumentBranding, InvoiceConfig, ReceiptConfig } from "../schemas/documentSettings.schema.js";
import { SAMPLE_BRANDING, SAMPLE_RECEIPT } from "../renderers/sampleData.js";

interface TestPrintCardProps {
  receiptDraft: ReceiptConfig | null;
  invoiceDraft: InvoiceConfig | null;
  branding: DocumentBranding;
  disabled: boolean;
}

/**
 * Test print — runs the REAL print engines against the clearly-labeled
 * sample transaction using the current (possibly unsaved) drafts. No sale
 * is created and no financial record is touched.
 */
export function TestPrintCard({
  receiptDraft,
  invoiceDraft,
  branding,
  disabled,
}: TestPrintCardProps) {
  const { printReceipt, printInvoice } = usePrintReceipt();

  const printTestReceipt = () => {
    if (!receiptDraft) return;
    void printReceipt(SAMPLE_RECEIPT, {
      config: receiptDraft,
      branding: { ...SAMPLE_BRANDING, ...branding },
    });
  };

  const printTestInvoice = () => {
    if (!invoiceDraft) return;
    void printInvoice(SAMPLE_RECEIPT, {
      config: invoiceDraft,
      branding: { ...SAMPLE_BRANDING, ...branding },
    });
  };

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <Label className="text-sm font-medium">Test Print</Label>
        <p className="text-xs text-muted-foreground">
          Prints the sample document with your current draft settings through
          the real print engine.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={disabled || !receiptDraft}
            onClick={printTestReceipt}
          >
            <PrinterCheck className="size-4" />
            Test Receipt
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={disabled || !invoiceDraft}
            onClick={printTestInvoice}
          >
            <PrinterCheck className="size-4" />
            Test Invoice
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
