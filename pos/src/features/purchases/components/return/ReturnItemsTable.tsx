import { ClipboardList } from "lucide-react";
import { formatCurrency } from "@/features/purchases/utils/formatCurrency";
import type { PurchasesItems } from "../../purchase.types";
import {
  estimateReturnUnitPrice,
  maxReturnableForItem,
} from "../../utils/returnCalculations";
import { AvailableStockIndicator } from "./AvailableStockIndicator";
import { ReturnQuantityInput } from "./ReturnQuantityInput";

/**
 * Eligible return lines: only received units still in stock can be
 * returned. The unit cost shown is the client's per-unit credit ESTIMATE —
 * the server credits actual batch costs (FIFO) and its total is displayed
 * after processing.
 */
export function ReturnItemsTable({
  orderItems,
  returnedByItem,
  returnQuantities,
  onQuantityChange,
}: {
  orderItems: PurchasesItems[];
  returnedByItem: Map<number, number>;
  returnQuantities: Record<number, number>;
  onQuantityChange: (item: PurchasesItems, value: number) => void;
}) {
  if (orderItems.length === 0) {
    return (
      <div className="p-8 text-center">
        <ClipboardList className="mx-auto size-9 text-muted-foreground/50" />
        <p className="mt-3 font-medium">No items on this order</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Product</th>
            <th className="px-3 py-3 font-medium">Unit</th>
            <th className="px-3 py-3 text-right font-medium">Ordered</th>
            <th className="px-3 py-3 text-right font-medium">Received</th>
            <th className="px-3 py-3 text-right font-medium">Returned</th>
            <th className="px-3 py-3 font-medium">Available stock</th>
            <th className="w-32 px-3 py-3 font-medium">Return qty</th>
            <th className="px-4 py-3 text-right font-medium">Unit cost*</th>
            <th className="px-4 py-3 text-right font-medium">Return total</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {orderItems.map((item) => {
            const returned = returnedByItem.get(item.id) ?? 0;
            const selectedForVariant = orderItems.reduce(
              (sum, otherItem) =>
                otherItem.variantId === item.variantId &&
                otherItem.id !== item.id
                  ? sum + (returnQuantities[otherItem.id] ?? 0)
                  : sum,
              0,
            );
            const availableStock = Math.max(
              0,
              Number(item.availableStock ?? 0) - selectedForVariant,
            );
            const maxReturn = maxReturnableForItem(
              item,
              returned,
              selectedForVariant,
            );
            const quantity = returnQuantities[item.id] ?? 0;
            const unitPrice = estimateReturnUnitPrice(item);
            return (
              <tr key={item.id}>
                <td className="px-4 py-3">
                  <p className="font-medium">
                    {item.variantName || item.productName}
                  </p>
                  {item.variantOptions && item.variantName ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.productName} · {item.variantOptions}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.trackingType} tracking
                  </p>
                </td>
                <td className="px-3 py-3 text-muted-foreground">
                  {item.productUnit || "—"}
                </td>
                <td className="px-3 py-3 text-right">{item.quantity}</td>
                <td className="px-3 py-3 text-right">
                  {item.receivedQuantity}
                </td>
                <td className="px-3 py-3 text-right">{returned}</td>
                <td className="px-3 py-3">
                  <AvailableStockIndicator
                    availableStock={availableStock}
                    maxReturn={maxReturn}
                  />
                </td>
                <td className="px-3 py-2">
                  <ReturnQuantityInput
                    value={quantity}
                    maxReturn={maxReturn}
                    label={`Return quantity for ${item.variantName || item.productName}`}
                    disabled={maxReturn <= 0}
                    onChange={(value) => onQuantityChange(item, value)}
                  />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  ৳ {formatCurrency(unitPrice)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-medium">
                  ৳ {formatCurrency(quantity * unitPrice)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
