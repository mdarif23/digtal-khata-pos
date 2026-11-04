import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PurchaseCart } from "../../purchase.types";
import { buildVariantOptionsLabel } from "@/lib/variantDisplay";

type PurchaseLineField =
  | "purchaseQty"
  | "purchasePrice"
  | "purchaseDiscount"
  | "purchaseTax";

export function PurchaseTable({
  purchasesCart,
  onUpdateItem,
  onRemoveItem,
}: {
  purchasesCart: PurchaseCart[];
  onUpdateItem: (variantId: number, field: PurchaseLineField, value: number) => void;
  onRemoveItem: (variantId: number) => void;
}) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[690px] text-left text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-3 font-medium">Product</th>
            <th className="w-24 px-2 py-3 font-medium">Qty</th>
            <th className="w-28 px-2 py-3 font-medium">Unit cost</th>
            <th className="w-24 px-2 py-3 font-medium">Discount</th>
            <th className="w-24 px-2 py-3 font-medium">Tax</th>
            <th className="px-2 py-3 text-right font-medium">Total</th>
            <th className="w-12 px-2 py-3" aria-label="Actions" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {purchasesCart.map((item) => {
            const variant = item.variants[0];
            const variantId = variant?.id;
            if (variantId === undefined) return null;
            const lineTotal =
              item.purchaseQty * item.purchasePrice -
              item.purchaseDiscount +
              item.purchaseTax;

            return (
              <tr key={variantId} className="align-middle">
                <td className="px-3 py-3">
                  <p className="max-w-40 truncate font-medium">{item.name}</p>
                  {variant.sku && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      SKU: {variant.sku}
                    </p>
                  )}
                  {buildVariantOptionsLabel(variant.options) !== "" && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {buildVariantOptionsLabel(variant.options)}
                    </p>
                  )}
                </td>
                <td className="px-2 py-2">
                  <Input
                    aria-label={`${item.name} quantity`}
                    min="0.001"
                    step="0.001"
                    type="number"
                    value={item.purchaseQty}
                    onChange={(event) =>
                      onUpdateItem(
                        variantId,
                        "purchaseQty",
                        Number(event.target.value) || 0,
                      )
                    }
                    className="h-8 px-2"
                  />
                </td>
                <td className="px-2 py-2">
                  <Input
                    aria-label={`${item.name} unit cost`}
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.purchasePrice}
                    onChange={(event) =>
                      onUpdateItem(
                        variantId,
                        "purchasePrice",
                        Number(event.target.value) || 0,
                      )
                    }
                    className="h-8 px-2"
                  />
                </td>
                <td className="px-2 py-2">
                  <Input
                    aria-label={`${item.name} discount`}
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.purchaseDiscount}
                    onChange={(event) =>
                      onUpdateItem(
                        variantId,
                        "purchaseDiscount",
                        Number(event.target.value) || 0,
                      )
                    }
                    className="h-8 px-2"
                  />
                </td>
                <td className="px-2 py-2">
                  <Input
                    aria-label={`${item.name} tax`}
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.purchaseTax}
                    onChange={(event) =>
                      onUpdateItem(
                        variantId,
                        "purchaseTax",
                        Number(event.target.value) || 0,
                      )
                    }
                    className="h-8 px-2"
                  />
                </td>
                <td className="whitespace-nowrap px-2 py-3 text-right font-medium">
                  {lineTotal.toFixed(2)}
                </td>
                <td className="px-2 py-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => onRemoveItem(variantId)}
                  >
                    <Trash2 className="text-muted-foreground" />
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
