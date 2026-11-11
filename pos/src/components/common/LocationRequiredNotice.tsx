import { ArrowRight } from "lucide-react";

/**
 * Shown when an API rejects the page because the business has no location
 * yet — retrying can never succeed, so guide the user to Locations instead
 * of a dead-end "Try again" banner. Render only when the error matches.
 */
export function LocationRequiredNotice({ error }: { error: string }) {
  if (!error.toLowerCase().includes("no locations")) return null;
  return (
    <div
      role="status"
      className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-4"
    >
      <p className="text-sm font-medium text-sky-900">
        Create your first location to open this page.
      </p>
      <p className="mt-1 text-sm text-slate-600">
        Sales, stock, and cash are tracked per location. Add one under
        Products → Locations — everything fills in automatically.
      </p>
      <a
        href="/locations"
        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-sky-700 px-3 py-2 text-sm font-medium text-white hover:bg-sky-800"
      >
        Go to Locations{" "}
        <ArrowRight aria-hidden="true" className="size-4" />
      </a>
    </div>
  );
}
