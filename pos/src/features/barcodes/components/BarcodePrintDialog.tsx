import { useState } from "react";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { PermissionButton } from "@/components/common/PermissionGuard";
import {
  layoutLabels,
  type LabelConfig,
  type LabelItem,
  type LabelSize,
} from "../labelTemplates.js";
import { printLabelHtml, renderLabelPagesHtml, withPageSize } from "../labelRenderer.js";
import { downloadLabelsPdf } from "../labelPdf.js";
import { logPrintJobApi } from "../barcode.api.js";

interface PrintDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: LabelItem[];
  size: LabelSize;
  config: LabelConfig;
  copiesPerItem: number;
  shopName: string | null;
  logoDataUrl: string | null;
  /** Called after a successful print/PDF for reprint bookkeeping. */
  onPrinted?: () => void;
}

/**
 * Label printing: browser print (exact @page mm — print at 100% scale!) and
 * PDF download (vector barcodes via jsPDF + svg2pdf). Both paths render the
 * SAME document, so output cannot drift. Requires products.print_labels.
 */
export function BarcodePrintDialog(props: PrintDialogProps) {
  const [busy, setBusy] = useState<"print" | "pdf" | null>(null);

  async function buildHtml(): Promise<{ html: string; width: number; height: number; count: number } | null> {
    if (props.items.length === 0) {
      toast.add({ title: "Select at least one item to print.", type: "error" });
      return null;
    }
    const queue = props.items.flatMap((item) =>
      Array.from({ length: props.copiesPerItem }, () => item),
    );
    const pages = layoutLabels(queue, props.size, props.config);
    const html = await renderLabelPagesHtml(pages, props.config, {
      shopName: props.shopName,
      logoDataUrl: props.logoDataUrl,
    });
    return {
      html,
      width: pages[0]?.pageWidthMm ?? props.size.widthMm,
      height: pages[0]?.pageHeightMm ?? props.size.heightMm,
      count: queue.length,
    };
  }

  async function onPrint() {
    setBusy("print");
    try {
      const built = await buildHtml();
      if (!built) return;
      printLabelHtml(withPageSize(built.html, built.width, built.height));
      await logPrintJobApi({
        variantCount: props.items.length,
        copies: props.copiesPerItem,
        template: props.size.id,
      });
      props.onPrinted?.();
    } catch (error) {
      toast.add({
        title: getErrorMessage(error),
        type: "error",
        priority: "high",
      });
    } finally {
      setBusy(null);
    }
  }

  async function onPdf() {
    setBusy("pdf");
    try {
      const queue = props.items.flatMap((item) =>
        Array.from({ length: props.copiesPerItem }, () => item),
      );
      const pages = layoutLabels(queue, props.size, props.config);
      await downloadLabelsPdf(pages, props.config, {
        shopName: props.shopName,
        logoDataUrl: props.logoDataUrl,
      }, `ezpos-labels-${props.size.id}-${new Date().toISOString().slice(0, 10)}.pdf`);
      await logPrintJobApi({
        variantCount: props.items.length,
        copies: props.copiesPerItem,
        template: `${props.size.id}-pdf`,
      });
      props.onPrinted?.();
    } catch (error) {
      toast.add({
        title: getErrorMessage(error),
        type: "error",
        priority: "high",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Print labels</DialogTitle>
          <DialogDescription>
            {props.items.length} item(s) × {props.copiesPerItem} copy/copies on{" "}
            {props.size.label}. Print at <strong>100% scale ("Actual size")</strong>{" "}
            — browser scaling distorts barcodes and breaks scannability.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => void onPdf()}>
            {busy === "pdf" ? <Spinner className="size-4" /> : null} Download PDF
          </Button>
          <PermissionButton
            permission="products.print_labels"
            disabled={busy !== null}
            onClick={() => void onPrint()}
          >
            {busy === "print" ? <Spinner className="size-4" /> : null} Print labels
          </PermissionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
