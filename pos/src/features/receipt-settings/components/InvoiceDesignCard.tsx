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
import { toast } from "@/components/ui/toast";
import type {
  InvoiceConfig,
  InvoiceVisibility,
} from "../schemas/documentSettings.schema.js";
import { useUpdateDocumentSettings } from "../hooks/useDocumentSettings.js";
import { VisibilityGrid, type VisibilityField } from "./VisibilityGrid.js";

export const INVOICE_VISIBILITY_FIELDS: readonly VisibilityField<
  keyof InvoiceVisibility
>[] = [
  { key: "logo", label: "Business logo" },
  { key: "businessName", label: "Business name" },
  { key: "businessAddress", label: "Business address" },
  { key: "businessPhone", label: "Phone" },
  { key: "businessEmail", label: "Email" },
  { key: "website", label: "Website" },
  { key: "vatBin", label: "VAT / BIN" },
  { key: "invoiceNumber", label: "Invoice number" },
  { key: "invoiceDate", label: "Invoice date" },
  { key: "customerInfo", label: "Customer information" },
  { key: "customerAddress", label: "Customer address" },
  { key: "itemDescription", label: "Product description" },
  { key: "itemSku", label: "SKU column" },
  { key: "itemUnit", label: "Unit column" },
  { key: "quantity", label: "Quantity column" },
  { key: "unitPrice", label: "Unit price column" },
  { key: "lineDiscount", label: "Discount column" },
  { key: "lineVat", label: "VAT column" },
  { key: "lineTotal", label: "Amount column" },
  { key: "subtotal", label: "Subtotal" },
  { key: "overallDiscount", label: "Overall discount" },
  { key: "vat", label: "VAT / Tax" },
  { key: "grandTotal", label: "Grand total" },
  { key: "paidAmount", label: "Paid amount" },
  { key: "dueAmount", label: "Due amount" },
  { key: "paymentInfo", label: "Payment information" },
  { key: "note", label: "Sale note" },
];

interface InvoiceDesignCardProps {
  draft: InvoiceConfig;
  serverConfig: InvoiceConfig | undefined;
  onChange: (updater: (prev: InvoiceConfig) => InvoiceConfig) => void;
  onResetDefaults: () => void;
  disabled: boolean;
}

export function InvoiceDesignCard({
  draft,
  serverConfig,
  onChange,
  onResetDefaults,
  disabled,
}: InvoiceDesignCardProps) {
  const save = useUpdateDocumentSettings();
  const dirty =
    serverConfig !== undefined &&
    JSON.stringify(stripUndefined(draft)) !== JSON.stringify(stripUndefined(serverConfig));

  const patchText = (patch: Partial<InvoiceConfig["text"]>) =>
    onChange((prev) => ({ ...prev, text: { ...prev.text, ...patch } }));
  const patchVisibility = (key: keyof InvoiceVisibility, checked: boolean) =>
    onChange((prev) => ({
      ...prev,
      visibility: { ...prev.visibility, [key]: checked },
    }));

  const handleSave = () => {
    save.mutate(
      { docType: "sales_invoice", config: draft },
      {
        onSuccess: () =>
          toast.add({ title: "Invoice design saved.", type: "success" }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoice Design</CardTitle>
        <CardDescription>
          A formal A4 or A5 invoice document. Amounts are pulled from the real
          transaction when printing — this only controls presentation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label className="text-sm font-medium">Paper Size</Label>
          <ToggleGroup

            variant="outline"
            spacing={2}
            value={[draft.paperSize]}
            onValueChange={(value: string[]) => {
              const v = value[0];
              if (v === "a4" || v === "a5") {
                onChange((prev) => ({ ...prev, paperSize: v }));
              }
            }}
            disabled={disabled}
          >
            <ToggleGroupItem value="a4">A4</ToggleGroupItem>
            <ToggleGroupItem value="a5">A5</ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="space-y-3">
          <Label className="text-sm font-medium">Show / Hide Fields</Label>
          <VisibilityGrid
            fields={INVOICE_VISIBILITY_FIELDS}
            value={draft.visibility}
            onChange={patchVisibility}
            disabled={disabled}
          />
        </div>

        <div className="space-y-3">
          <Label className="text-sm font-medium">Custom Text</Label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="inv-title" className="text-xs">
                Invoice title
              </Label>
              <Input
                id="inv-title"
                value={draft.text.title}
                maxLength={60}
                disabled={disabled}
                onChange={(e) => patchText({ title: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inv-footer" className="text-xs">
                Footer message (optional)
              </Label>
              <Input
                id="inv-footer"
                value={draft.text.footerMessage}
                maxLength={300}
                disabled={disabled}
                onChange={(e) => patchText({ footerMessage: e.target.value })}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="inv-terms" className="text-xs">
                Terms & conditions
              </Label>
              <Textarea
                id="inv-terms"
                rows={3}
                value={draft.text.terms}
                maxLength={2000}
                disabled={disabled}
                onChange={(e) => patchText({ terms: e.target.value })}
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 sm:col-span-2">
              <Label htmlFor="inv-sign" className="text-xs font-normal">
                Show authorized signature block
              </Label>
              <Switch
                id="inv-sign"
                size="sm"
                checked={draft.showSignature}
                onCheckedChange={(checked) =>
                  onChange((prev) => ({ ...prev, showSignature: checked === true }))
                }
                disabled={disabled}
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
            Save Invoice Design
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
