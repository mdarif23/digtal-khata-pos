import { useEffect, useRef } from "react";
import { toast } from "@/components/ui/toast";
import type { ScanState } from "./barcodeScannerService.js";

/**
 * Scan outcome → toast (spec §16: never silently ignore failed scans).
 * Shared by the purchase order, receive, and return pages — the effect was
 * previously copy-pasted verbatim in all three.
 */
export function useScanFailureToast(scanState: ScanState) {
  const lastHandledEventId = useRef(0);
  useEffect(() => {
    const event = scanState.last;
    if (!event || event.id <= lastHandledEventId.current) return;
    lastHandledEventId.current = event.id;
    if (event.status === "not_found") {
      toast.add({
        type: "error",
        description: "No product matches that barcode.",
      });
    } else if (event.status === "ambiguous") {
      toast.add({
        type: "error",
        description:
          event.detail ?? "That barcode matches more than one product.",
        priority: "high",
      });
    } else if (event.status === "error") {
      toast.add({
        type: "error",
        description: event.detail ?? "Scan failed.",
        priority: "high",
      });
    }
  }, [scanState.last]);
}
