import { StatusBadge } from "@/components/common/StatusBadge";
import { statusLabel, statusTone } from "../lib/warranty-format";

interface WarrantyStatusBadgeProps {
  status: string | null | undefined;
}

/** Status pill shared by warranty rows, claim rows, and supplier claims. */
export function WarrantyStatusBadge({ status }: WarrantyStatusBadgeProps) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  return <StatusBadge tone={statusTone(status)}>{statusLabel(status)}</StatusBadge>;
}
