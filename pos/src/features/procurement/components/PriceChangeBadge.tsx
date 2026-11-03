import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatPercent, priceDirection } from "../utils/priceMath";

interface PriceChangeBadgeProps {
  value: number | null | undefined;
  className?: string;
}

/**
 * Factual price-change indicator: reports the change only. A rising price
 * is shown in red as "more expensive" — the system never labels a supplier
 * good or bad, it reports numbers.
 */
export function PriceChangeBadge({ value, className }: PriceChangeBadgeProps) {
  const direction = priceDirection(value);
  const formatted = formatPercent(value);

  if (direction === "flat") {
    return (
      <Badge variant="secondary" className={className}>
        <Minus aria-hidden className="size-3" />
        {formatted}
      </Badge>
    );
  }
  if (direction === "up") {
    return (
      <Badge
        className={`bg-red-100 text-red-700 hover:bg-red-100 ${className ?? ""}`}
      >
        <TrendingUp aria-hidden className="size-3" />
        {formatted}
      </Badge>
    );
  }
  return (
    <Badge
      className={`bg-emerald-100 text-emerald-700 hover:bg-emerald-100 ${className ?? ""}`}
    >
      <TrendingDown aria-hidden className="size-3" />
      {formatted}
    </Badge>
  );
}
