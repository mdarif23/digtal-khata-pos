import { Button } from "@/components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Label } from "@/components/ui/label.js";
import { Switch } from "@/components/ui/switch.js";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group.js";
import { Loader2, Save } from "lucide-react";
import { toast } from "@/components/ui/toast";
import type { ReceiptConfig } from "../schemas/documentSettings.schema.js";
import { useUpdateDocumentSettings } from "../hooks/useDocumentSettings.js";

interface PrintingPrefsCardProps {
  /** Printing preferences ride on the sales-receipt template row. */
  draft: ReceiptConfig;
  serverConfig: ReceiptConfig | undefined;
  onChange: (updater: (prev: ReceiptConfig) => ReceiptConfig) => void;
  disabled: boolean;
}

export function PrintingPrefsCard({
  draft,
  serverConfig,
  onChange,
  disabled,
}: PrintingPrefsCardProps) {
  const save = useUpdateDocumentSettings();
  const dirty =
    serverConfig !== undefined &&
    JSON.stringify(draft.print) !== JSON.stringify(serverConfig.print);

  const handleSave = () => {
    save.mutate(
      { docType: "sales_receipt", config: draft },
      {
        onSuccess: () =>
          toast.add({ title: "Printing preferences saved.", type: "success" }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Printing Preferences</CardTitle>
        <CardDescription>
          How receipts print at the register. Browsers always show the print
          dialog — ezPos prepares the paper and opens the dialog for you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
          <div>
            <Label htmlFor="pp-auto" className="text-sm font-medium">
              Auto-print receipt after sale
            </Label>
            <p className="text-xs text-muted-foreground">
              Opens the print dialog automatically when a sale completes.
            </p>
          </div>
          <Switch
            id="pp-auto"
            checked={draft.print.autoPrintOnSale}
            onCheckedChange={(checked) =>
              onChange((prev) => ({
                ...prev,
                print: { ...prev.print, autoPrintOnSale: checked === true },
              }))
            }
            disabled={disabled}
          />
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium">
            Receipt copies per print job
          </Label>
          <ToggleGroup

            variant="outline"
            spacing={2}
            value={[String(draft.print.copies)]}
            onValueChange={(value: string[]) => {
              const v = Number(value[0]);
              if (v >= 1 && v <= 3) {
                onChange((prev) => ({
                  ...prev,
                  print: { ...prev.print, copies: v },
                }));
              }
            }}
            disabled={disabled}
          >
            <ToggleGroupItem value="1">1 copy</ToggleGroupItem>
            <ToggleGroupItem value="2">2 copies</ToggleGroupItem>
            <ToggleGroupItem value="3">3 copies</ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            Copies print in a single job (one dialog), separated by page
            breaks — the merchant copy and customer copy in one go.
          </p>
        </div>

        <div className="flex justify-end">
          <Button type="button" disabled={disabled || !dirty || save.isPending} onClick={handleSave}>
            {save.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save Preferences
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
