import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Shared KPI/summary tile (title, big value, description, optional icon).
 * The one summary-card pattern for dashboard, sales, finance and reports —
 * replaces per-file copies.
 */
export function SummaryCard({
  title,
  value,
  description,
  icon,
  valueClassName,
  className,
}: {
  title: string;
  value: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  valueClassName?: string;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
        <div className="min-w-0">
          <CardDescription className="truncate">{title}</CardDescription>
          <CardTitle
            className={cn("mt-1 text-2xl tabular-nums", valueClassName)}
          >
            {value}
          </CardTitle>
        </div>
        {icon}
      </CardHeader>
      {description !== undefined ? (
        <CardContent>
          <p className="text-xs text-muted-foreground">{description}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}
