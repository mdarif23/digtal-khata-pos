import { statusBadgeClass, statusLabel } from "../lib/warranty-format";

interface WarrantyStatusBadgeProps {
  status: string | null | undefined;
}

/** Status pill shared by warranty rows, claim rows, and supplier claims. */
export function WarrantyStatusBadge({ status }: WarrantyStatusBadgeProps) {
  if (!status) return <span className="text-slate-400">—</span>;
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass(status)}`}
    >
      {statusLabel(status)}
    </span>
  );
}
