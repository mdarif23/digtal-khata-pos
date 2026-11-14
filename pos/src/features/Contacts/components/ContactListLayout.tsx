import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { SummaryCard } from "@/components/common/SummaryCard";
import { SearchInput } from "@/components/common/SearchInput";

export interface ContactMetric {
  label: string;
  value: string;
  description: string;
}

interface ContactListLayoutProps {
  title: string;
  description: string;
  action: ReactNode;
  metrics: ContactMetric[];
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  resultCount: number | string;
  filter?: ReactNode;
  children: ReactNode;
}

/**
 * Shared shell for the Contacts list pages: standard PageContainer +
 * PageHeader frame, KPI tiles and the searchable list card. Presentation
 * only — pages keep owning their data, filters and actions.
 */
export function ContactListLayout({
  title,
  description,
  action,
  metrics,
  search,
  onSearchChange,
  searchPlaceholder,
  resultCount,
  filter,
  children,
}: ContactListLayoutProps) {
  return (
    <PageContainer>
      <PageHeader title={title} description={description} actions={action} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map((metric) => (
          <SummaryCard
            key={metric.label}
            title={metric.label}
            value={metric.value}
            description={metric.description}
          />
        ))}
      </div>

      <Card>
        <CardContent className="gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <SearchInput
                value={search}
                onChange={onSearchChange}
                placeholder={searchPlaceholder}
                ariaLabel={searchPlaceholder}
                className="sm:max-w-lg"
              />
              <p className="text-xs text-muted-foreground">
                {resultCount}{" "}
                {typeof resultCount === "number" && resultCount === 1
                  ? "result"
                  : "results"}
              </p>
            </div>
            {filter}
          </div>
          {children}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
