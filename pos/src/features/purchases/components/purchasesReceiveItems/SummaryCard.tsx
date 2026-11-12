import { SummaryCardProps } from "../../purchase.types";

export const SummaryCard = ({ card, formatCurrency }: SummaryCardProps) => {
  const displayValue =
    "total" in card
      ? `৳ ${formatCurrency(card.total)}`
      : (card.status ?? "N/A");
  return (
    <div className={`flex items-center p-3 ${card.bg} rounded-lg`}>
      <div className={`w-3 h-3 ${card.circleBg} rounded-full mr-3`}></div>
      <div>
        <p className="text-sm font-medium text-gray-600">{card.title}</p>
        <p className="font-bold">{displayValue}</p>
      </div>
    </div>
  );
};
