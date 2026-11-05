import {
  AlertTriangle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScanEvent, ScanState } from "./barcodeScannerService.js";

const STATUS_ICON: Record<ScanEvent["status"], typeof CircleCheck> = {
  resolved: CircleCheck,
  not_found: CircleX,
  ambiguous: AlertTriangle,
  duplicate: Copy,
  error: CircleAlert,
};

const STATUS_TEXT: Record<ScanEvent["status"], string> = {
  resolved: "Scanned",
  not_found: "Unknown barcode",
  ambiguous: "Ambiguous barcode",
  duplicate: "Duplicate scan ignored",
  error: "Scan failed",
};

const STATUS_CLASS: Record<ScanEvent["status"], string> = {
  resolved: "text-emerald-600 dark:text-emerald-400",
  not_found: "text-destructive",
  ambiguous: "text-amber-600 dark:text-amber-400",
  duplicate: "text-muted-foreground",
  error: "text-destructive",
};

export function describeScanMatch(match: {
  productName: string;
  variantLabel: string | null;
}): string {
  return match.variantLabel
    ? `${match.productName} (${match.variantLabel})`
    : match.productName;
}

export interface BarcodeScanFeedbackProps {
  state: ScanState;
  className?: string;
}

/**
 * Shared inline scan feedback: last scan outcome + running scan count.
 * Presentational only — pages may pair it with toasts for errors.
 */
export function BarcodeScanFeedback({ state, className }: BarcodeScanFeedbackProps) {
  const last = state.last;
  const busy = state.pending > 0;
  return (
    <div
      data-slot="barcode-scan-feedback"
      className={cn(
        "flex min-h-8 flex-wrap items-center gap-2 text-sm",
        className,
      )}
      aria-live="polite"
    >
      {busy ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
      {last ? (
        <>
          {(() => {
            const Icon = STATUS_ICON[last.status];
            return (
              <Icon className={cn("size-4 shrink-0", STATUS_CLASS[last.status])} />
            );
          })()}
          <span className={cn("font-medium", STATUS_CLASS[last.status])}>
            {STATUS_TEXT[last.status]}
          </span>
          {last.status === "resolved" && last.match ? (
            <span className="text-foreground">
              {describeScanMatch(last.match)}
            </span>
          ) : null}
          {(last.status === "not_found" || last.status === "duplicate") ? (
            <span className="font-mono text-xs text-muted-foreground">
              {last.code}
            </span>
          ) : null}
          {last.detail && last.status !== "duplicate" ? (
            <span className="text-xs text-muted-foreground">{last.detail}</span>
          ) : null}
        </>
      ) : (
        <span className="text-muted-foreground">
          {state.scanCount > 0
            ? `${state.scanCount} scan${state.scanCount === 1 ? "" : "s"}`
            : "Scan a barcode to begin"}
        </span>
      )}
      {state.scanCount > 0 ? (
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {state.scanCount} scan{state.scanCount === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );
}
