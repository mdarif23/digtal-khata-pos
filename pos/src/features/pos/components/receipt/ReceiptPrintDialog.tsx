import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Printer, Settings2, Check, Copy } from "lucide-react";
import type { SaleReceiptData, PaperWidth } from "../../types/receipt.types.js";
import { ReceiptTemplate } from "./ReceiptTemplate.js";
import { useReceiptSettingsStore } from "../../stores/useReceiptSettingsStore.js";
import { usePrintReceipt } from "../../hooks/usePrintReceipt.js";
import { HardwareSettings } from "./HardwareSettings.js";

interface ReceiptPrintDialogProps {
  receipt: SaleReceiptData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReceiptPrintDialog({
  receipt,
  open,
  onOpenChange,
}: ReceiptPrintDialogProps) {
  const { settings, updateSettings, setPaperWidth } = useReceiptSettingsStore();
  const { printReceipt } = usePrintReceipt();
  const [showSettings, setShowSettings] = useState(false);
  const [selectedWidth, setSelectedWidth] = useState<PaperWidth>(settings.paperWidth);

  if (!receipt) return null;

  const handlePrint = () => {
    printReceipt(receipt, { paperWidth: selectedWidth });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[95dvh] w-[95vw] max-w-2xl overflow-hidden flex flex-col p-0">
        <DialogHeader className="p-4 border-b shrink-0 flex flex-row items-center justify-between space-y-0">
          <div>
            <DialogTitle className="text-lg font-bold">
              Receipt Preview & Print
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Invoice #{receipt.invoiceNumber} • ৳{receipt.finalTotal.toFixed(2)}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant={showSettings ? "secondary" : "outline"}
              size="sm"
              onClick={() => setShowSettings(!showSettings)}
              className="h-8 gap-1 text-xs"
            >
              <Settings2 className="size-3.5" />
              Settings
            </Button>
          </div>
        </DialogHeader>

        {/* Paper width quick tabs */}
        <div className="px-4 py-2 bg-muted/40 border-b flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground font-medium">Paper Size:</span>
            {(["58mm", "80mm", "a4"] as PaperWidth[]).map((width) => (
              <Button
                key={width}
                type="button"
                variant={selectedWidth === width ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs px-2.5 uppercase"
                onClick={() => {
                  setSelectedWidth(width);
                  setPaperWidth(width);
                }}
              >
                {width}
              </Button>
            ))}
          </div>

          <span className="text-muted-foreground hidden sm:inline">
            Thermal Roll Ready
          </span>
        </div>

        {/* Quick settings editor if toggled */}
        {showSettings && (
          <div className="p-4 bg-muted/30 border-b space-y-3 text-xs shrink-0 max-h-72 overflow-y-auto">
            <HardwareSettings />
            <div className="font-semibold text-foreground">Receipt Preferences</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="shopName" className="text-[11px]">Shop Name</Label>
                <Input
                  id="shopName"
                  className="h-7 text-xs mt-1"
                  value={settings.shopName}
                  onChange={(e) => updateSettings({ shopName: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="phone" className="text-[11px]">Phone</Label>
                <Input
                  id="phone"
                  className="h-7 text-xs mt-1"
                  value={settings.phone}
                  onChange={(e) => updateSettings({ phone: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="address" className="text-[11px]">Address</Label>
                <Input
                  id="address"
                  className="h-7 text-xs mt-1"
                  value={settings.address}
                  onChange={(e) => updateSettings({ address: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="footerMessage" className="text-[11px]">Footer Message</Label>
                <Input
                  id="footerMessage"
                  className="h-7 text-xs mt-1"
                  value={settings.footerMessage}
                  onChange={(e) => updateSettings({ footerMessage: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="returnPolicy" className="text-[11px]">Return Policy</Label>
                <Input
                  id="returnPolicy"
                  className="h-7 text-xs mt-1"
                  value={settings.returnPolicy}
                  onChange={(e) => updateSettings({ returnPolicy: e.target.value })}
                />
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                id="autoPrintCheck"
                type="checkbox"
                checked={settings.autoPrintOnSale}
                onChange={(e) => updateSettings({ autoPrintOnSale: e.target.checked })}
                className="rounded border-zinc-400 size-3.5"
              />
              <Label htmlFor="autoPrintCheck" className="text-[11px] cursor-pointer">
                Automatically open print dialog right after completing a sale
              </Label>
            </div>
          </div>
        )}

        {/* Scrollable Receipt Preview Area */}
        <div className="flex-1 overflow-y-auto p-4 bg-zinc-100 flex justify-center">
          <div className="shadow-lg border border-zinc-300 rounded-sm overflow-hidden my-auto">
            <ReceiptTemplate
              receipt={receipt}
              paperWidth={selectedWidth}
              isPrintPreview
            />
          </div>
        </div>

        <DialogFooter className="p-3 border-t bg-background shrink-0 flex sm:justify-between items-center gap-2">
          <div className="text-xs text-muted-foreground hidden sm:block">
            Prints directly via browser print dialog to your configured printer
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              onClick={handlePrint}
            >
              <Printer className="size-4" />
              Print Receipt
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

