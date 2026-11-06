import type { ReactNode } from "react";
import { Wallet } from "lucide-react";
import { SummaryCard } from "../purchasesReceiveItems/SummaryCard";
import type { PaymentsInfoCard } from "../../purchase.types";

/**
 * Credit-side summary for a purchase return: estimated return value,
 * previously paid, and the balance after the credit nets against the
 * payable. The supplier CREDIT (ledger entry) is distinct from an actual
 * refund payment — no refund is issued here.
 */
export function SupplierCreditSummary({
  cards,
  formatCurrency,
  children,
}: {
  cards: PaymentsInfoCard[];
  formatCurrency: (value: number) => string;
  children?: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-xl border bg-background p-4 shadow-sm md:p-5">
      <div className="flex items-center gap-3">
        <Wallet className="size-5 text-primary" />
        <div>
          <h2 className="font-semibold">Return summary</h2>
          <p className="text-sm text-muted-foreground">
            Processing updates inventory and records a supplier credit. The
            final credit uses each unit&apos;s actual batch cost.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {cards.map((card) => (
          <SummaryCard
            key={card.title}
            card={card}
            formatCurrency={formatCurrency}
          />
        ))}
      </div>

      {children}
    </section>
  );
}
