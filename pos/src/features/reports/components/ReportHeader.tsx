import React from "react";
import { Download, Printer, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ReportHeaderProps {
  title: string;
  description: string;
  category?: string;
  onExport?: () => void;
  onRefresh?: () => void;
  onPrint?: () => void;
  loading?: boolean;
  actions?: React.ReactNode;
}

export function ReportHeader({
  title,
  description,
  category = "Reports",
  onExport,
  onRefresh,
  onPrint,
  loading = false,
  actions,
}: ReportHeaderProps) {
  const handlePrint = () => {
    if (onPrint) {
      onPrint();
    } else {
      window.print();
    }
  };

  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between print:mb-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-success">
          {category}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {actions}

        <Button type="button" variant="outline" onClick={handlePrint} title="Print report">
          <Printer className="size-4" />
          <span className="hidden sm:inline">Print</span>
        </Button>

        {onRefresh && (
          <Button
            type="button"
            variant="outline"
            onClick={onRefresh}
            disabled={loading}
            title="Refresh data"
          >
            <RefreshCw
              className={`size-4 ${loading ? "animate-spin" : ""}`}
            />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        )}

        {onExport && (
          <Button type="button" onClick={onExport} disabled={loading}>
            <Download className="size-4" />
            Export CSV
          </Button>
        )}
      </div>
    </header>
  );
}
