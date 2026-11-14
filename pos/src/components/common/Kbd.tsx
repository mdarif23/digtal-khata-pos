import { cn } from "@/lib/utils";

/**
 * Keycap-style keyboard key label — reads as a physical key, not a text
 * badge: raised bottom edge, mono face, muted surface. Renders either a
 * single key or a combo (each part gets its own cap, joined by "+").
 */
export function Kbd({
  keys,
  className,
  title,
}: {
  /** A single key ("F2") or a combo ("Ctrl+K" → two caps). */
  keys: string | string[];
  className?: string;
  title?: string;
}) {
  const parts = Array.isArray(keys) ? keys : [keys];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 whitespace-nowrap align-middle",
        className,
      )}
      title={title}
    >
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="inline-flex items-center gap-0.5">
          {index > 0 && (
            <span aria-hidden="true" className="text-muted-foreground/70">
              +
            </span>
          )}
          <kbd className="inline-flex min-w-5 items-center justify-center rounded-[5px] border border-border bg-muted px-1 py-px font-mono text-[10px] font-semibold leading-4 text-foreground shadow-[0_1.5px_0_0_var(--border)]">
            {part}
          </kbd>
        </span>
      ))}
    </span>
  );
}
