import { SummaryCard } from "../purchasesReceiveItems/SummaryCard";
import type { PaymentsInfoCard } from "../../purchase.types";

/**
 * Receiving-side money summary: value received now, previously paid, the
 * maximum still payable for this receipt, and the outstanding balance strip.
 * All figures are passed in precomputed by the page — the backend remains
 * authoritative for the actual payment limit.
 */
export function ReceivingCostSummary({
  cards,
  dueAmount,
  paymentAmount,
  formatCurrency,
}: {
  cards: PaymentsInfoCard[];
  dueAmount: number;
  paymentAmount: number;
  formatCurrency: (value: number) => string;
}) {
  const newBalance = Math.max(0, dueAmount - Number(paymentAmount || 0));

  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        {cards.map((card) => (
          <SummaryCard
            key={card.title}
            card={card}
            formatCurrency={formatCurrency}
          />
        ))}
      </div>

      <div className="flex flex-wrap justify-between gap-3 rounded-lg bg-muted/50 p-4 text-sm">
        <div>
          <p className="text-muted-foreground">Outstanding before payment</p>
          <p className="mt-1 font-medium">৳ {formatCurrency(dueAmount)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Paying now</p>
          <p className="mt-1 font-medium">
            ৳ {formatCurrency(Number(paymentAmount) || 0)}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Balance after payment</p>
          <p className="mt-1 text-lg font-semibold">
            ৳ {formatCurrency(newBalance)}
          </p>
        </div>
      </div>
    </>
  );
}
