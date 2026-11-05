import { useState, type ComponentProps } from "react";
import { Barcode } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { BarcodeScanner } from "./barcodeScannerService.js";

export interface BarcodeScannerInputProps
  extends Omit<ComponentProps<"input">, "value" | "onChange"> {
  scanner: BarcodeScanner;
  /** Clear the field after each scan (default true). */
  clearOnScan?: boolean;
}

/**
 * Shared scan box: Enter submits the field value as a scan and clears it.
 * Works identically for USB wedge scanners and manual keyboard entry, and
 * never submits surrounding forms (Enter is always prevented).
 */
export function BarcodeScannerInput({
  scanner,
  clearOnScan = true,
  className,
  onKeyDown,
  ...props
}: BarcodeScannerInputProps) {
  const [value, setValue] = useState("");
  return (
    <div className={cn("relative flex-1 min-w-0", className)}>
      <Barcode
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        {...props}
        className="pl-8"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            scanner.handleScan(value);
            if (clearOnScan) setValue("");
          }
        }}
      />
    </div>
  );
}
