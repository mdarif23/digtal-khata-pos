import React, { useEffect, useState } from "react";
import axios from "@/api/axios";
import { Button } from "@/components/ui/button";
import { renderReceiptHtml } from "@/features/receipt-settings/renderers/receiptHtml";
import { normalizeReceiptConfig } from "@/features/receipt-settings/schemas/documentSettings.schema";
import type { SaleReceiptData } from "@/features/pos/types/receipt.types";
import type { DocumentBranding, ReceiptConfig } from "@/features/receipt-settings/schemas/documentSettings.schema";

/**
 * P3 Phase 4 (N1-10, D12): the PUBLIC receipt-share page — token in the URL,
 * no account, no internal sale id. Renders with the SAME renderReceiptHtml
 * the POS uses (never a second receipt engine) and prints through the
 * browser dialog ("Save as PDF" included). An expired/revoked token answers
 * a uniform error — nothing about the sale leaks.
 */
export function ReceiptSharePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const token = window.location.pathname.split("/").pop() ?? "";

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await axios.get<{ data: SaleReceiptData }>(
          `/public/receipts/${token}`,
        );
        if (ignore) return;
        const receipt = res.data.data;
        const branding: DocumentBranding =
          (receipt.business as unknown as DocumentBranding) ??
          ({
            name: receipt.customer ? "" : "",
            currency: "BDT",
          } as unknown as DocumentBranding);
        const config: ReceiptConfig = normalizeReceiptConfig(
          receipt.documentSettings?.sales_receipt,
        );
        const { html: rendered } = await renderReceiptHtml({
          receipt,
          branding,
          config,
        });
        if (!ignore) setHtml(rendered);
      } catch {
        if (!ignore) {
          setError("This receipt link has expired or was revoked.");
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [token]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading receipt…
      </div>
    );
  }
  if (error || !html) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2">
        <p className="text-lg font-semibold">Receipt link unavailable</p>
        <p className="text-sm text-muted-foreground">
          {error ?? "Unknown error."}
        </p>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-muted/40 p-4">
      <div className="mx-auto flex max-w-md items-center justify-between py-3">
        <span className="text-sm text-muted-foreground">
          Shared receipt — printed via your browser (PDF supported)
        </span>
        <Button type="button" onClick={() => window.print()}>
          Print / Save PDF
        </Button>
      </div>
      <iframe
        title="Shared receipt"
        className="mx-auto block h-[80vh] w-full max-w-md border bg-white shadow-sm"
        srcDoc={html}
      />
    </div>
  );
}
