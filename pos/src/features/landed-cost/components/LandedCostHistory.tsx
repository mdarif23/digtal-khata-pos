import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LandedCostDetail } from "../landedCost.api";

const formatCurrency = (value: number) =>
  `৳${value.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatDate = (value: string) =>
  new Date(value).toLocaleString("en-BD", { dateStyle: "medium", timeStyle: "short" });

/** Read-only view of a posted document: allocations, adjustments, postings. */
export function LandedCostHistory({ detail }: { detail: LandedCostDetail }) {
  const section = "rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm shadow-slate-950/[0.02]";
  const heading = "text-sm font-semibold text-slate-700";

  return (
    <div className="space-y-5">
      <div className={section}>
        <p className={heading}>Allocations (immutable)</p>
        <div className="mt-3 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50/80">
                <TableHead>Purchase item</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Allocated</TableHead>
                <TableHead className="text-right">Per unit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.allocations.map((allocation) => (
                <TableRow key={allocation.id}>
                  <TableCell>#{allocation.purchaseItemId}</TableCell>
                  <TableCell className="font-mono text-xs">
                    #{allocation.inventoryBatchId}
                  </TableCell>
                  <TableCell className="text-right">
                    {allocation.quantitySnapshot}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {formatCurrency(Number(allocation.allocatedAmount))}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(Number(allocation.allocatedPerUnit))}
                  </TableCell>
                </TableRow>
              ))}
              {detail.allocations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-slate-400">
                    No allocations posted yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {detail.adjustments.length > 0 && (
        <div className={section}>
          <p className={heading}>Adjustments</p>
          <ul className="mt-3 space-y-2">
            {detail.adjustments.map((adjustment) => (
              <li
                key={adjustment.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 p-3 text-sm"
              >
                <span className="flex items-center gap-2">
                  <Badge variant="outline">{adjustment.adjustmentType.replace("_", " ")}</Badge>
                  <span className="text-slate-600">{adjustment.reason}</span>
                </span>
                <span className="text-right text-xs text-slate-500">
                  {formatCurrency(Number(adjustment.previousAllocatedAmount))} →{" "}
                  <strong className="text-slate-800">
                    {formatCurrency(Number(adjustment.newAllocatedAmount))}
                  </strong>{" "}
                  (inventory {formatCurrency(Number(adjustment.inventoryAmount))} / COGS{" "}
                  {formatCurrency(Number(adjustment.cogsAmount))})
                  <span className="block">{formatDate(adjustment.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail.postings.length > 0 && (
        <div className={section}>
          <p className={heading}>Accounting postings</p>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/80">
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Settlement</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.postings.map((posting) => (
                  <TableRow key={posting.id}>
                    <TableCell>
                      <Badge variant="outline">{posting.postingType.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell className="text-slate-600">{posting.description}</TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {posting.paymentSource.replace("_", " ")}
                      {posting.paymentReferenceId
                        ? ` · #${posting.paymentReferenceId}`
                        : ""}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatCurrency(Number(posting.amount))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <div className={section}>
        <p className={heading}>Audit history</p>
        <ul className="mt-2 space-y-1 text-xs text-slate-500">
          {detail.auditLogs.map((log) => (
            <li key={log.id}>
              {formatDate(log.createdAt)} — {log.action}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
