import { SummaryCard } from "../purchasesReceiveItems/SummaryCard";
import type { PaymentsInfoCard } from "../../purchase.types";

/** Order-level status cards on the Receive Items page. */
export function ReceivingSummary({
  cards,
  formatCurrency,
}: {
  cards: PaymentsInfoCard[];
  formatCurrency: (value: number) => string;
}) {
  return (
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <SummaryCard
          key={card.title}
          card={card}
          formatCurrency={formatCurrency}
        />
      ))}
    </section>
  );
}
