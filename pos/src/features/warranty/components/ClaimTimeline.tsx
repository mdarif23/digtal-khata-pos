import { formatDateTime } from "@/lib/format";
import type { WarrantyClaimEvent } from "../types/warranty.types";
import { statusLabel } from "../lib/warranty-format";

interface ClaimTimelineProps {
  events: WarrantyClaimEvent[];
}

/**
 * Activity timeline rendered from the claim's `events` (both customer and
 * supplier claims share the event shape).
 */
export function ClaimTimeline({ events }: ClaimTimelineProps) {
  if (events.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        No activity recorded yet.
      </p>
    );
  }

  // Oldest first so the story reads top-to-bottom.
  const ordered = [...events].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return (
    <ol className="space-y-0">
      {ordered.map((event, index) => {
        const isLast = index === ordered.length - 1;
        const transition =
          event.previousStatus || event.newStatus
            ? [
                event.previousStatus ? statusLabel(event.previousStatus) : null,
                event.newStatus ? statusLabel(event.newStatus) : null,
              ]
                .filter(Boolean)
                .join(" → ")
            : null;

        return (
          <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
            {!isLast && (
              <span
                aria-hidden="true"
                className="absolute top-4 left-[7px] h-full w-px bg-border"
              />
            )}
            <span
              aria-hidden="true"
              className="relative mt-1.5 size-3.5 shrink-0 rounded-full border-2 border-success bg-card"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                {statusLabel(event.eventType)}
              </p>
              {transition && (
                <p className="text-xs text-muted-foreground">{transition}</p>
              )}
              {event.note && (
                <p className="mt-1 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                  {event.note}
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground/70">
                {formatDateTime(event.createdAt)}
                {event.actorType ? ` · ${event.actorType.replace(/_/g, " ")}` : ""}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
