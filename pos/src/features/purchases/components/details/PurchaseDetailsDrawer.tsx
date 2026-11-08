import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/features/reports/utils/reportUtils";
import { useLandedCostDocument } from "@/features/landed-cost/hooks/useLandedCost";
import { PurchaseCostSummary } from "../purchases/PurchaseCostSummary";
import {
  usePurchaseDetail,
  usePurchaseLandedCostContext,
} from "../../hooks/usePurchaseDetail";

/**
 * Purchase details drawer (Phase 11): the authoritative financial picture
 * of one purchase — cost summary (same component as creation), item
 * lines, and the landed-cost accounting view (expenses with their Phase 4
 * source identity + the Phase 9 reconciliation). Read-only: every
 * mutation keeps its own page (receive / return / landed cost).
 */

const RECEIVING_LABELS: Record<string, string> = {
  ordered: "Ordered",
  partially_received: "Partially received",
  received: "Received",
};

function StatusBadge({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${className}`}
    >
      {label}
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium">{value}</dd>
    </div>
  );
}

export function PurchaseDetailsDrawer({
  purchaseId,
  open,
  onOpenChange,
}: {
  purchaseId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = usePurchaseDetail(open ? purchaseId : null);
  const context = usePurchaseLandedCostContext(open ? purchaseId : null);
  const docId = context.data?.existingDocumentId ?? null;
  const landedDoc = useLandedCostDocument(open && docId ? docId : null);

  const purchase = detail.data?.purchase;
  const items = detail.data?.items ?? [];
  const accounting = landedDoc.data?.accounting;
  const doc = landedDoc.data?.document;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle data-testid="purchase-details-title">
            {purchase ? purchase.purchaseOrderNumber : "Purchase details"}
          </SheetTitle>
          <SheetDescription>
            {purchase
              ? `${purchase.supplierName ?? "No supplier"} · ${formatDate(purchase.purchaseDate)}`
              : "Loading…"}
          </SheetDescription>
        </SheetHeader>

        {detail.isLoading || !purchase ? (
          <div className="space-y-3 px-4 pb-6">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="space-y-6 px-4 pb-8">
            {/* ---- Statuses ---- */}
            <div className="flex flex-wrap gap-2">
              <StatusBadge
                label={RECEIVING_LABELS[purchase.status] ?? purchase.status}
                className={
                  purchase.status === "received"
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-amber-100 text-amber-800"
                }
              />
              {purchase.returnStatus && (
                <StatusBadge
                  label={purchase.returnStatus}
                  className="bg-violet-100 text-violet-800"
                />
              )}
              <StatusBadge
                label={purchase.paymentStatus}
                className={
                  purchase.paymentStatus === "paid"
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-sky-100 text-sky-800"
                }
              />
              {purchase.landedCostStatus && (
                <StatusBadge
                  label={
                    purchase.landedCostStatus === "pending"
                      ? "Landed cost pending"
                      : "Landed cost allocated"
                  }
                  className={
                    purchase.landedCostStatus === "pending"
                      ? "bg-orange-100 text-orange-800"
                      : "bg-emerald-100 text-emerald-800"
                  }
                />
              )}
            </div>

            {/* ---- Authoritative cost summary (same block as creation) ---- */}
            <section>
              <h3 className="mb-2 text-sm font-semibold">Cost summary</h3>
              <PurchaseCostSummary
                itemsSubtotal={purchase.subtotal}
                orderDiscount={purchase.discount}
                orderTax={purchase.tax}
                supplierShipping={purchase.shippingCost}
                grandTotal={purchase.totalAmount}
              />
              <dl className="mt-3 space-y-0.5 text-sm">
                <DetailRow
                  label="Paid"
                  value={formatCurrency(purchase.paidAmount)}
                />
                <DetailRow
                  label="Due to supplier"
                  value={formatCurrency(purchase.dueAmount)}
                />
                <DetailRow
                  label="Supplier credit balance"
                  value={formatCurrency(purchase.supplierCreditBalance)}
                />
              </dl>
              {purchase.supplierCreditBalance > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Recorded supplier credits (returns and cancellations) —
                  owed by the supplier, not a cash refund. Applying credits
                  to future purchases is not supported yet.
                </p>
              )}
            </section>

            {/* ---- Item lines ---- */}
            <section>
              <h3 className="mb-2 text-sm font-semibold">
                Items ({items.length})
              </h3>
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Item</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Ordered
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Received
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Unit cost
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Line total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className="border-t">
                        <td className="px-3 py-2">
                          <p className="font-medium">{item.productName}</p>
                          {item.variantSku && (
                            <p className="text-xs text-muted-foreground">
                              {item.variantSku}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {item.quantity}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {item.receivedQuantity}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatCurrency(item.unitCost)}
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {formatCurrency(
                            item.quantity * item.unitCost -
                              item.discount +
                              item.tax,
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* ---- Landed-cost accounting panel ---- */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Landed cost</h3>
                {purchase.status !== "ordered" && (
                  <Button
                    nativeButton={false}
                    size="sm"
                    variant="outline"
                    render={
                      <Link to={`/purchases/landed-cost/${purchase.id}`} />
                    }
                  >
                    Manage
                  </Button>
                )}
              </div>
              {purchase.status === "ordered" ? (
                <p className="text-sm text-muted-foreground">
                  Receive at least one quantity before allocating landed
                  costs.
                </p>
              ) : context.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : !doc ? (
                <p className="text-sm text-muted-foreground">
                  No landed-cost document yet
                  {context.data?.existingStatus
                    ? ` (${context.data.existingStatus})`
                    : ""}
                  .
                </p>
              ) : (
                <div className="space-y-3 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="outline" className="capitalize">
                      {doc.status}
                    </Badge>
                    <span className="text-muted-foreground">
                      {doc.allocationMethod} method · allocated{" "}
                      {formatCurrency(Number(doc.totalAllocatedAmount))}
                      {Number(doc.pendingAllocationAmount) > 0 && (
                        <> · pending{" "}
                          {formatCurrency(Number(doc.pendingAllocationAmount))}
                        </>
                      )}
                    </span>
                  </div>

                  {/* Expenses with their source identity. */}
                  <ul className="space-y-1 text-sm">
                    {landedDoc.data?.expenses.map((expense) => (
                      <li
                        key={expense.id}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="flex items-center gap-2">
                          <span className="capitalize">
                            {expense.expenseType}
                          </span>
                          {expense.sourceType === "purchase" && (
                            <Badge
                              variant="outline"
                              className="text-xs"
                              data-testid="purchase-origin-badge"
                            >
                              Auto · supplier shipping
                            </Badge>
                          )}
                        </span>
                        <span className="font-medium">
                          {formatCurrency(expense.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {/* Phase 9/12 accounting reconciliation. */}
                  {accounting && (
                    <div
                      className="space-y-1 border-t pt-2 text-sm"
                      data-testid="landed-accounting"
                    >
                      <DetailRow
                        label="Capitalized"
                        value={formatCurrency(
                          accounting.postingsByType.capitalization,
                        )}
                      />
                      {accounting.soldUnitsLanded !== 0 && (
                        <DetailRow
                          label="To COGS (sold units)"
                          value={formatCurrency(accounting.soldUnitsLanded)}
                        />
                      )}
                      {accounting.postingsByType.reversal !== 0 && (
                        <DetailRow
                          label="Reversed (returns)"
                          value={formatCurrency(
                            accounting.postingsByType.reversal,
                          )}
                        />
                      )}
                      <DetailRow
                        label="Net in inventory"
                        value={formatCurrency(accounting.netInInventory)}
                      />
                      <p
                        className={
                          accounting.capitalizationTiesOut
                            ? "text-xs text-emerald-700"
                            : "text-xs text-destructive"
                        }
                      >
                        {accounting.capitalizationTiesOut
                          ? "✓ Ledger reconciles with the document"
                          : "⚠ Ledger does not reconcile with the document"}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </section>

            {purchase.notes && (
              <section>
                <h3 className="mb-1 text-sm font-semibold">Notes</h3>
                <p className="text-sm text-muted-foreground">
                  {purchase.notes}
                </p>
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
