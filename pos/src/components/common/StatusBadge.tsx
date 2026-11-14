import { cn } from "@/lib/utils";

export type StatusTone =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "primary"
  | "neutral";

const toneClasses: Record<StatusTone, string> = {
  success: "bg-success/10 text-success ring-success/30",
  warning: "bg-warning/10 text-warning ring-warning/30",
  danger: "bg-destructive/10 text-destructive ring-destructive/30",
  info: "bg-info/10 text-info ring-info/30",
  primary: "bg-primary/10 text-primary ring-primary/30",
  neutral: "bg-muted text-muted-foreground ring-border",
};

/**
 * The one status chip. Every module renders the same status in the same
 * visual language — semantic tone resolved through design tokens instead of
 * per-file `bg-green-100 text-green-800` palettes. Status text itself is
 * never carried by color alone (the label is always inside the chip).
 */
export function StatusBadge({
  tone = "neutral",
  dot = true,
  children,
  className,
}: {
  tone?: StatusTone;
  /** Leading status dot — keep it on; color here reinforces, never carries. */
  dot?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 truncate rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        toneClasses[tone],
        className,
      )}
    >
      {dot && (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-current"
        />
      )}
      {children}
    </span>
  );
}
