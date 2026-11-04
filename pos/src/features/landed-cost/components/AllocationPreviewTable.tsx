import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AllocationLinePreview } from "../landedCost.api";

const formatCurrency = (value: number) =>
  `৳${value.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Per-batch allocation preview (Part H): Product, Variant, SKU, received
 * quantity, original purchase cost, basis, allocated additional cost,
 * additional cost per unit and the final landed cost per unit.
 */
export function AllocationPreviewTable({
  lines,
  lineContext,
}: {
  lines: AllocationLinePreview[];
  lineContext: Map<number, { productName: string; variantName: string; sku: string | null; unitCost: number }>;
}) {
  if (lines.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200/80">
      <Table>
        <TableHeader>
          <TableRow className="bg-slate-50/80">
            <TableHead>Product</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead>Batch</TableHead>
            <TableHead className="text-right">Received</TableHead>
            <TableHead className="text-right">Original cost</TableHead>
            <TableHead className="text-right">Allocated</TableHead>
            <TableHead className="text-right">Per unit</TableHead>
            <TableHead className="text-right">Landed / unit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => {
            const ctx = lineContext.get(line.purchaseItemId);
            return line.batches.map((batch, batchIndex) => (
              <TableRow key={`${line.purchaseItemId}-${batch.batchId}`}>
                <TableCell>
                  {batchIndex === 0 ? (
                    <div>
                      <p className="font-medium text-slate-900">
                        {ctx?.productName}
                      </p>
                      {ctx?.variantName !== ctx?.productName && (
                        <p className="text-xs text-slate-500">{ctx?.variantName}</p>
                      )}
                      <p className="mt-0.5 text-xs text-slate-400">
                        ordered {line.orderedQuantity} · received{" "}
                        {line.receivedQuantity} · target{" "}
                        {formatCurrency(line.lineTotalTargetAmount)}
                      </p>
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs text-slate-500">
                  {batchIndex === 0 ? (ctx?.sku ?? "—") : ""}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {batch.batchNumber}
                </TableCell>
                <TableCell className="text-right">{batch.quantitySnapshot}</TableCell>
                <TableCell className="text-right">
                  {formatCurrency(ctx?.unitCost ?? 0)}
                </TableCell>
                <TableCell className="text-right font-semibold">
                  {formatCurrency(batch.allocatedAmount)}
                </TableCell>
                <TableCell className="text-right">
                  {formatCurrency(batch.allocatedPerUnit)}
                </TableCell>
                <TableCell className="text-right font-semibold text-emerald-700">
                  {formatCurrency((ctx?.unitCost ?? 0) + batch.allocatedPerUnit)}
                </TableCell>
              </TableRow>
            ));
          })}
        </TableBody>
      </Table>
    </div>
  );
}
