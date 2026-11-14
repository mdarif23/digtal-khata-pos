import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/format";

/**
 * Cost-summary block for purchase creation (Phase 3). Layout per the
 * financial-summary spec — additions and deductions are visually
 * distinct, supplier shipping is explicitly the SUPPLIER's invoice
 * charge, and additional freight is pointed at the landed-cost module so
 * the two shipping concepts are never confused.
 */
export function PurchaseCostSummary({
  itemsSubtotal,
  orderDiscount,
  discountSuffix,
  orderTax,
  supplierShipping,
  grandTotal,
}: {
  itemsSubtotal: number;
  orderDiscount: number;
  /** Shown beside the discount amount, e.g. "(5%)" for percentage basis. */
  discountSuffix?: string | undefined;
  orderTax: number;
  supplierShipping: number;
  grandTotal: number;
}) {
  return (
    <TooltipProvider>
      <div className="space-y-2 border-t pt-3 text-sm">
        <div className="flex justify-between text-muted-foreground">
          <span>Items subtotal</span>
          <span>{formatCurrency(itemsSubtotal)}</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>
            Order discount
            {discountSuffix && (
              <span className="ml-1 text-xs">{discountSuffix}</span>
            )}
          </span>
          <span className="text-destructive">
            −{formatCurrency(orderDiscount)}
          </span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>Additional tax</span>
          <span>{formatCurrency(orderTax)}</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <Tooltip>
            <TooltipTrigger render={<span className="cursor-help underline decoration-dotted underline-offset-2" />}>
              Supplier shipping
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              Shipping charged by the supplier on this purchase invoice — it
              increases the payable and can be capitalized into inventory
              through landed cost.
            </TooltipContent>
          </Tooltip>
          <span>{formatCurrency(supplierShipping)}</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <Tooltip>
            <TooltipTrigger render={<span className="cursor-help underline decoration-dotted underline-offset-2" />}>
              Additional freight
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              Separate transportation expenses are managed through the
              landed-cost module after the order is created — they do not
              change this supplier invoice.
            </TooltipContent>
          </Tooltip>
          <span className="italic text-muted-foreground/70">
            via landed cost
          </span>
        </div>
        <div className="flex justify-between border-t pt-3 text-lg font-semibold">
          <span>Purchase grand total</span>
          <span>{formatCurrency(grandTotal)}</span>
        </div>
      </div>
    </TooltipProvider>
  );
}
