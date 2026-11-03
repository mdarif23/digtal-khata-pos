import { Button } from "@/components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group.js";
import { Loader2, RotateCcw, Save } from "lucide-react";
import type {
  ReceiptConfig,
  ReceiptVisibility,
} from "../schemas/documentSettings.schema.js";
import { useUpdateDocumentSettings } from "../hooks/useDocumentSettings.js";
import { toast } from "@/components/ui/toast";
import { VisibilityGrid, type VisibilityField } from "./VisibilityGrid.js";

export const RECEIPT_VISIBILITY_FIELDS: readonly VisibilityField<
  keyof ReceiptVisibility
>[] = [
  { key: "logo", label: "Business logo" },
  { key: "businessName", label: "Business name" },
  { key: "businessAddress", label: "Business address" },
  { key: "businessPhone", label: "Phone number" },
  { key: "businessEmail", label: "Email" },
  { key: "vatBin", label: "VAT / BIN number" },
  { key: "invoiceNumber", label: "Invoice number" },
  { key: "dateTime", label: "Date & time" },
  { key: "cashierName", label: "Cashier name" },
  { key: "customerName", label: "Customer name" },
  { key: "customerPhone", label: "Customer phone" },
  { key: "productName", label: "Product name" },
  { key: "sku", label: "Product SKU" },
  { key: "barcode", label: "Product barcode" },
  { key: "quantity", label: "Quantity" },
  { key: "unitPrice", label: "Unit price" },
  { key: "lineDiscount", label: "Line discount" },
  { key: "lineTotal", label: "Line total" },
  { key: "subtotal", label: "Subtotal" },
  { key: "overallDiscount", label: "Overall discount" },
  { key: "vat", label: "VAT / Tax" },
  { key: "grandTotal", label: "Grand total" },
  { key: "paymentMethod", label: "Payment method" },
  { key: "paidAmount", label: "Paid amount" },
  { key: "dueAmount", label: "Due amount" },
  { key: "changeAmount", label: "Change amount" },
  { key: "qrCode", label: "QR code" },
];

interface ReceiptDesignCardProps {
  draft: ReceiptConfig;
  serverConfig: ReceiptConfig | undefined;
  onChange: (updater: (prev: ReceiptConfig) => ReceiptConfig) => void;
  onResetDefaults: () => void;
  disabled: boolean;
}

export function ReceiptDesignCard({
  draft,
  serverConfig,
  onChange,
  onResetDefaults,
  disabled,
}: ReceiptDesignCardProps) {
  const save = useUpdateDocumentSettings();
  const dirty =
    serverConfig !== undefined &&
    JSON.stringify(stripUndefined(draft)) !== JSON.stringify(stripUndefined(serverConfig));

  const patchLayout = (patch: Partial<ReceiptConfig["layout"]>) =>
    onChange((prev) => ({ ...prev, layout: { ...prev.layout, ...patch } }));
  const patchText = (patch: Partial<ReceiptConfig["text"]>) =>
    onChange((prev) => ({ ...prev, text: { ...prev.text, ...patch } }));
  const patchVisibility = (key: keyof ReceiptVisibility, checked: boolean) =>
    onChange((prev) => ({
      ...prev,
      visibility: { ...prev.visibility, [key]: checked },
    }));

  const handleSave = () => {
    save.mutate(
      { docType: "sales_receipt", config: draft },
      {
        onSuccess: () =>
          toast.add({ title: "Receipt design saved.", type: "success" }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Receipt Design</CardTitle>
        <CardDescription>
          Choose the paper width, exactly which fields print, typography and
          your custom messages. Financial values always come from the actual
          sale.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Paper size */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Paper Size</Label>
          <ToggleGroup

            variant="outline"
            spacing={2}
            value={[draft.paperWidth]}
            onValueChange={(value: string[]) => {
              const v = value[0];
              if (v === "58mm" || v === "80mm") {
                onChange((prev) => ({ ...prev, paperWidth: v }));
              }
            }}
            disabled={disabled}
          >
            <ToggleGroupItem value="58mm">58mm thermal</ToggleGroupItem>
            <ToggleGroupItem value="80mm">80mm thermal</ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            58mm printers are narrow — prefer the compact item table and fewer
            visible columns for best readability.
          </p>
        </div>

        {/* Layout */}
        <div className="space-y-3">
          <Label className="text-sm font-medium">Layout</Label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rc-font" className="text-xs">
                Font size ({draft.layout.fontSize}px)
              </Label>
              <input
                id="rc-font"
                type="range"
                min={9}
                max={14}
                step={1}
                value={draft.layout.fontSize}
                disabled={disabled}
                onChange={(e) => patchLayout({ fontSize: Number(e.target.value) })}
                className="w-full accent-primary"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rc-logo-w" className="text-xs">
                Logo width ({draft.layout.logoWidthPx}px)
              </Label>
              <input
                id="rc-logo-w"
                type="range"
                min={40}
                max={200}
                step={2}
                value={draft.layout.logoWidthPx}
                disabled={disabled}
                onChange={(e) => patchLayout({ logoWidthPx: Number(e.target.value) })}
                className="w-full accent-primary"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rc-margin" className="text-xs">
                Page margin ({draft.layout.marginMm}mm)
              </Label>
              <input
                id="rc-margin"
                type="range"
                min={0}
                max={8}
                step={1}
                value={draft.layout.marginMm}
                disabled={disabled}
                onChange={(e) => patchLayout({ marginMm: Number(e.target.value) })}
                className="w-full accent-primary"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rc-header-sp" className="text-xs">
                Header spacing ({draft.layout.headerSpacingPx}px)
              </Label>
              <input
                id="rc-header-sp"
                type="range"
                min={0}
                max={48}
                step={2}
                value={draft.layout.headerSpacingPx}
                disabled={disabled}
                onChange={(e) => patchLayout({ headerSpacingPx: Number(e.target.value) })}
                className="w-full accent-primary"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rc-footer-sp" className="text-xs">
                Footer spacing ({draft.layout.footerSpacingPx}px)
              </Label>
              <input
                id="rc-footer-sp"
                type="range"
                min={0}
                max={48}
                step={2}
                value={draft.layout.footerSpacingPx}
                disabled={disabled}
                onChange={(e) => patchLayout({ footerSpacingPx: Number(e.target.value) })}
                className="w-full accent-primary"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rc-align" className="text-xs">
                Header alignment
              </Label>
              <ToggleGroup

                variant="outline"
                spacing={2}
                value={[draft.layout.headerAlign]}
                onValueChange={(value: string[]) => {
                  const v = value[0];
                  if (v === "left" || v === "center") patchLayout({ headerAlign: v });
                }}
                disabled={disabled}
              >
                <ToggleGroupItem value="left">Left</ToggleGroupItem>
                <ToggleGroupItem value="center">Center</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rc-table" className="text-xs">
                Item table format
              </Label>
              <ToggleGroup

                variant="outline"
                spacing={2}
                value={[draft.layout.itemTableStyle]}
                onValueChange={(value: string[]) => {
                  const v = value[0];
                  if (v === "compact" || v === "detailed") {
                    patchLayout({ itemTableStyle: v });
                  }
                }}
                disabled={disabled}
              >
                <ToggleGroupItem value="detailed">Detailed columns</ToggleGroupItem>
                <ToggleGroupItem value="compact">Compact lines</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <Label htmlFor="rc-sep" className="text-xs font-normal">
                Separator lines between sections
              </Label>
              <Switch
                id="rc-sep"
                size="sm"
                checked={draft.layout.showSeparators}
                onCheckedChange={(checked) =>
                  patchLayout({ showSeparators: checked === true })
                }
                disabled={disabled}
              />
            </div>
          </div>
        </div>

        {/* Visibility */}
        <div className="space-y-3">
          <Label className="text-sm font-medium">
            Show / Hide Fields
          </Label>
          <VisibilityGrid
            fields={RECEIPT_VISIBILITY_FIELDS}
            value={draft.visibility}
            onChange={patchVisibility}
            disabled={disabled}
          />
        </div>

        {/* Custom text */}
        <div className="space-y-3">
          <Label className="text-sm font-medium">Custom Text</Label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rc-title" className="text-xs">
                Receipt title
              </Label>
              <Input
                id="rc-title"
                value={draft.text.title}
                maxLength={60}
                disabled={disabled}
                onChange={(e) => patchText({ title: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rc-thanks" className="text-xs">
                Thank-you message
              </Label>
              <Input
                id="rc-thanks"
                value={draft.text.thankYouMessage}
                maxLength={200}
                disabled={disabled}
                onChange={(e) => patchText({ thankYouMessage: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rc-footer" className="text-xs">
                Footer message
              </Label>
              <Input
                id="rc-footer"
                value={draft.text.footerMessage}
                maxLength={300}
                disabled={disabled}
                onChange={(e) => patchText({ footerMessage: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rc-additional" className="text-xs">
                Additional business message (optional)
              </Label>
              <Textarea
                id="rc-additional"
                rows={2}
                value={draft.text.additionalMessage}
                maxLength={300}
                disabled={disabled}
                onChange={(e) => patchText({ additionalMessage: e.target.value })}
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={onResetDefaults}
          >
            <RotateCcw className="size-4" />
            Reset to defaults
          </Button>
          <Button type="button" disabled={disabled || !dirty || save.isPending} onClick={handleSave}>
            {save.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save Receipt Design
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** JSON-stable compare (key order independent). */
function stripUndefined(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}
