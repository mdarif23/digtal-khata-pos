import { useEffect } from "react";
import { Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { formatDate } from "@/lib/format";
import { useWarrantyCertificate } from "../hooks/useWarranties";
import { printWarrantyCertificate } from "../lib/printWarrantyCertificate";
import { durationLabel } from "../lib/warranty-format";

interface WarrantyCertificateDialogProps {
  warrantyId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-1.5 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-sm font-medium text-foreground">
        {value}
      </span>
    </div>
  );
}

/**
 * On-screen preview of the printable warranty certificate. Printing goes
 * through the standalone iframe document (see printWarrantyCertificate) so
 * the paper output has no app chrome.
 */
export function WarrantyCertificateDialog({
  warrantyId,
  open,
  onOpenChange,
}: WarrantyCertificateDialogProps) {
  const certificate = useWarrantyCertificate(warrantyId, open);

  useEffect(() => {
    if (certificate.isError) {
      toast.add({
        type: "error",
        title: "Could not load the certificate",
        description: getErrorMessage(certificate.error),
      });
    }
  }, [certificate.isError, certificate.error]);

  const data = certificate.data;
  const warranty = data?.warranty.warranty;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Warranty certificate</DialogTitle>
          <DialogDescription>
            {warranty
              ? `Certificate ${warranty.warrantyNumber} — print it for the customer.`
              : "Loading certificate…"}
          </DialogDescription>
        </DialogHeader>

        {certificate.isLoading || !data || !warranty ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin text-primary" aria-hidden="true" />
            Loading certificate…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border-2 border-primary/60 p-4">
              <div className="border-b-2 border-primary/60 pb-3 text-center">
                <p className="text-lg font-semibold text-foreground">
                  {data.branding.name ?? "Warranty Certificate"}
                </p>
                {data.branding.tagline ? (
                  <p className="text-xs text-muted-foreground italic">
                    {data.branding.tagline}
                  </p>
                ) : null}
              </div>
              <p className="mt-3 text-center text-xs font-semibold tracking-[0.3em] text-primary uppercase">
                Warranty Certificate
              </p>
              <p className="mt-1 text-center font-mono text-sm font-bold text-foreground">
                {warranty.warrantyNumber}
              </p>
              <div className="mt-3">
                <Fact
                  label="Customer"
                  value={
                    warranty.customerName
                      ? `${warranty.customerName}${warranty.customerPhone ? ` · ${warranty.customerPhone}` : ""}`
                      : "—"
                  }
                />
                <Fact label="Invoice" value={data.warranty.invoiceNumber ?? "—"} />
                <Fact
                  label="Product"
                  value={
                    warranty.variantOptionLabel
                      ? `${warranty.productName} (${warranty.variantOptionLabel})`
                      : warranty.productName
                  }
                />
                <Fact label="Serial" value={warranty.serialNumber ?? "—"} />
                <Fact
                  label="Coverage"
                  value={`${durationLabel(warranty.duration, warranty.durationUnit)} · ${warranty.warrantyType}`}
                />
                <Fact label="Provider" value={warranty.provider ?? "Shop warranty"} />
                <Fact label="Starts" value={formatDate(warranty.startDate)} />
                <Fact label="Expires" value={formatDate(warranty.expiryDate)} />
                <Fact
                  label="Covered quantity"
                  value={`${warranty.quantity}${warranty.returnedQuantity ? ` (returned ${warranty.returnedQuantity})` : ""}`}
                />
              </div>
            </div>

            <Button
              type="button"
              className="w-full"
              onClick={() => printWarrantyCertificate(data)}
            >
              <Printer aria-hidden="true" />
              Print certificate
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
