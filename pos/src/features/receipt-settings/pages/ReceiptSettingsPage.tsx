import { useEffect, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Building2, FileText, Printer, SlidersHorizontal } from "lucide-react";
import { usePermissions } from "@/hooks/usePermissions.js";
import type { DocumentBranding, InvoiceConfig, ReceiptConfig } from "../schemas/documentSettings.schema.js";
import {
  normalizeInvoiceConfig,
  normalizeReceiptConfig,
} from "../schemas/documentSettings.schema.js";
import {
  useBusinessProfile,
  useDocumentSettings,
} from "../hooks/useDocumentSettings.js";
import { renderReceiptHtml } from "../renderers/receiptHtml.js";
import { renderInvoiceHtml } from "../renderers/invoiceHtml.js";
import { SAMPLE_BRANDING, SAMPLE_RECEIPT } from "../renderers/sampleData.js";
import { BusinessInfoCard } from "../components/BusinessInfoCard.js";
import { ReceiptDesignCard } from "../components/ReceiptDesignCard.js";
import { InvoiceDesignCard } from "../components/InvoiceDesignCard.js";
import { PrintingPrefsCard } from "../components/PrintingPrefsCard.js";
import { LivePreview } from "../components/LivePreview.js";
import { TestPrintCard } from "../components/TestPrintCard.js";

type SettingsTab = "business" | "receipt" | "invoice" | "printing";

/**
 * /settings/receipt — Receipt & Invoice customization.
 *
 * Left column: tabbed editors. Right column: live preview rendered by the
 * SAME renderer the printer uses. Drafts are local until saved, so the
 * preview updates instantly and nothing touches the server until "Save".
 */
export default function ReceiptSettingsPage() {
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission("receipt_settings.edit");
  const { data: settings, isLoading: settingsLoading } = useDocumentSettings();
  const { data: business, isLoading: businessLoading } = useBusinessProfile();

  const [tab, setTab] = useState<SettingsTab>("business");
  const [receiptDraft, setReceiptDraft] = useState<ReceiptConfig | null>(null);
  const [invoiceDraft, setInvoiceDraft] = useState<InvoiceConfig | null>(null);

  useEffect(() => {
    if (settings) {
      setReceiptDraft((prev) => prev ?? normalizeReceiptConfig(settings.sales_receipt));
      setInvoiceDraft((prev) => prev ?? normalizeInvoiceConfig(settings.sales_invoice));
    }
  }, [settings]);

  const branding: DocumentBranding = useMemo(() => {
    if (!business) return SAMPLE_BRANDING;
    return {
      name: business.name || SAMPLE_BRANDING.name,
      phone: business.phone,
      email: business.email,
      address: business.address,
      website: business.website,
      vatBin: business.vatBin,
      tagline: business.tagline,
      logoUrl: business.logoUrl,
      currency: business.currency || SAMPLE_BRANDING.currency,
    };
  }, [business]);

  const previewMode: "receipt" | "invoice" = tab === "invoice" ? "invoice" : "receipt";
  const [preview, setPreview] = useState<{
    html: string;
    paperWidthCss: string;
  } | null>(null);
  const [rendering, setRendering] = useState(false);

  // Debounced live re-render of the preview from the current drafts.
  useEffect(() => {
    let cancelled = false;
    setRendering(true);
    const timer = setTimeout(async () => {
      try {
        if (previewMode === "receipt" && receiptDraft) {
          const result = await renderReceiptHtml({
            receipt: SAMPLE_RECEIPT,
            branding,
            config: receiptDraft,
            copies: 1,
          });
          if (!cancelled) setPreview(result);
        } else if (previewMode === "invoice" && invoiceDraft) {
          const result = renderInvoiceHtml({
            receipt: SAMPLE_RECEIPT,
            branding,
            config: invoiceDraft,
          });
          if (!cancelled) setPreview(result);
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [previewMode, receiptDraft, invoiceDraft, branding]);

  if (settingsLoading || businessLoading) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <Skeleton className="h-9 w-72" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
          <Skeleton className="h-[480px]" />
          <Skeleton className="h-[480px]" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold md:text-2xl">Receipt & Invoice</h1>
        <p className="text-sm text-muted-foreground">
          Customize what your business documents look like — branding, fields,
          paper sizes and messages. Changes apply to newly printed documents
          only; sales records are never altered.
        </p>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab((value ?? "business") as SettingsTab)}
          className="min-w-0"
        >
          <TabsList className="flex w-full flex-wrap justify-start gap-1">
            <TabsTrigger value="business">
              <Building2 className="size-4" />
              Business Info
            </TabsTrigger>
            <TabsTrigger value="receipt">
              <SlidersHorizontal className="size-4" />
              Receipt Design
            </TabsTrigger>
            <TabsTrigger value="invoice">
              <FileText className="size-4" />
              Invoice Design
            </TabsTrigger>
            <TabsTrigger value="printing">
              <Printer className="size-4" />
              Printing
            </TabsTrigger>
          </TabsList>

          <TabsContent value="business" className="mt-3">
            <BusinessInfoCard canEdit={canEdit} />
          </TabsContent>

          <TabsContent value="receipt" className="mt-3">
            {receiptDraft && (
              <ReceiptDesignCard
                draft={receiptDraft}
                serverConfig={
                  settings
                    ? normalizeReceiptConfig(settings.sales_receipt)
                    : undefined
                }
                onChange={(updater) =>
                  setReceiptDraft((prev) => (prev ? updater(prev) : prev))
                }
                onResetDefaults={() => setReceiptDraft(normalizeReceiptConfig({}))}
                disabled={!canEdit}
              />
            )}
          </TabsContent>

          <TabsContent value="invoice" className="mt-3">
            {invoiceDraft && (
              <InvoiceDesignCard
                draft={invoiceDraft}
                serverConfig={
                  settings
                    ? normalizeInvoiceConfig(settings.sales_invoice)
                    : undefined
                }
                onChange={(updater) =>
                  setInvoiceDraft((prev) => (prev ? updater(prev) : prev))
                }
                onResetDefaults={() => setInvoiceDraft(normalizeInvoiceConfig({}))}
                disabled={!canEdit}
              />
            )}
          </TabsContent>

          <TabsContent value="printing" className="mt-3">
            {receiptDraft && (
              <PrintingPrefsCard
                draft={receiptDraft}
                serverConfig={
                  settings
                    ? normalizeReceiptConfig(settings.sales_receipt)
                    : undefined
                }
                onChange={(updater) =>
                  setReceiptDraft((prev) => (prev ? updater(prev) : prev))
                }
                disabled={!canEdit}
              />
            )}
          </TabsContent>
        </Tabs>

        <div className="sticky top-4 space-y-4 min-w-0">
          <LivePreview
            html={preview?.html ?? null}
            paperWidthCss={preview?.paperWidthCss ?? (previewMode === "invoice" ? "210mm" : "80mm")}
            mode={previewMode}
            rendering={rendering}
          />
          {canEdit && (
            <TestPrintCard
              receiptDraft={receiptDraft}
              invoiceDraft={invoiceDraft}
              branding={branding}
              disabled={false}
            />
          )}
        </div>
      </div>
    </div>
  );
}
