import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { usePermissions } from "@/hooks/usePermissions";
import {
  useNoteSupplierClaim,
  useSupplierClaimDetail,
} from "../hooks/useSupplierWarranties";
import { formatCurrency, formatDate, formatDateTime } from "@/features/reports/utils/reportUtils";
import { WarrantyStatusBadge } from "../components/WarrantyStatusBadge";
import {
  SupplierClaimActionDialog,
  type SupplierClaimAction,
} from "../components/SupplierClaimActionDialog";
import { ClaimTimeline } from "../components/ClaimTimeline";
import { durationLabel } from "../lib/warranty-format";

/** allowedTransitions targets → the dialog action that performs them. */
const ACTION_FOR_TRANSITION: Record<string, SupplierClaimAction> = {
  sent_to_supplier: "response",
  under_repair: "response",
  rejected: "response",
  replaced: "replacement",
  recovered: "recovery",
  closed: "closed",
  cancelled: "cancelled",
};

const ACTION_LABELS: Record<SupplierClaimAction, string> = {
  response: "Supplier response",
  replacement: "Record replacement",
  recovery: "Record recovery",
  closed: "Close claim",
  cancelled: "Cancel claim",
};

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 py-1.5 last:border-0">
      <span className="text-xs whitespace-nowrap text-slate-500">{label}</span>
      <span className="text-right text-sm text-slate-800">{value}</span>
    </div>
  );
}

export function SupplierClaimDetailPage() {
  const { id } = useParams();
  const claimId = Number(id);
  const query = useSupplierClaimDetail(claimId);
  const { hasPermission } = usePermissions();

  const [activeAction, setActiveAction] = useState<SupplierClaimAction | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const addNote = useNoteSupplierClaim();

  useEffect(() => {
    if (query.isError) {
      toast.add({
        type: "error",
        title: "Could not load the supplier claim",
        description: getErrorMessage(query.error),
      });
    }
  }, [query.isError, query.error]);

  const canManage = hasPermission("warranty.supplier.manage");

  const actions = useMemo(() => {
    if (!canManage || !query.data) return [];
    const unique: SupplierClaimAction[] = [];
    for (const transition of query.data.allowedTransitions) {
      const action = ACTION_FOR_TRANSITION[transition];
      if (action && !unique.includes(action)) {
        unique.push(action);
      }
    }
    return unique;
  }, [canManage, query.data]);

  const isTerminal =
    query.data?.claim.status === "closed" || query.data?.claim.status === "cancelled";

  if (query.isPending) {
    return (
      <div className="space-y-4 p-5">
        <Skeleton className="h-8 w-72" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="p-5">
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 py-10 text-center"
        >
          <p className="text-sm font-medium text-rose-700">
            Unable to load this supplier claim.
          </p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const detail = query.data;
  const claim = detail.claim;

  const submitNote = async () => {
    const note = noteDraft.trim();
    if (!note) return;
    try {
      await addNote.mutateAsync({ claimId, body: { note } });
      setNoteDraft("");
      toast.add({ type: "success", title: "Note added to the claim" });
    } catch (error) {
      toast.add({
        type: "error",
        title: "Could not add the note",
        description: getErrorMessage(error),
      });
    }
  };

  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            render={<Link to="/warranty/supplier-claims" />}
            variant="outline"
            size="icon"
            aria-label="Back to supplier claims"
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-slate-950">
              <span className="font-mono">{claim.claimNumber}</span>
              <WarrantyStatusBadge status={claim.status} />
            </h1>
            <p className="text-sm text-slate-500">
              {detail.supplierName} · {detail.productName}
              {detail.variantOptionLabel ? ` · ${detail.variantOptionLabel}` : ""} ·
              filed {formatDateTime(claim.createdAt)}
            </p>
          </div>
        </div>

        {actions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {actions.map((action) => (
              <Button
                key={action}
                variant={
                  action === "closed" || action === "cancelled" ? "outline" : "default"
                }
                size="sm"
                onClick={() => setActiveAction(action)}
              >
                {ACTION_LABELS[action]}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Supplier</CardTitle>
          </CardHeader>
          <CardContent>
            <Fact label="Supplier" value={detail.supplierName} />
            <Fact label="Phone" value={detail.supplierPhone ?? "—"} />
            <Fact
              label="Source warranty"
              value={
                <Link
                  to="/warranty/supplier-warranties"
                  className="text-xs text-emerald-700 hover:underline"
                >
                  #{claim.supplierWarrantyId}
                </Link>
              }
            />
            {claim.customerWarrantyClaimId ? (
              <Fact
                label="Customer claim"
                value={
                  <Link
                    to={`/warranty/claims/${claim.customerWarrantyClaimId}`}
                    className="text-xs text-emerald-700 hover:underline"
                  >
                    #{claim.customerWarrantyClaimId}
                  </Link>
                }
              />
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Product & warranty</CardTitle>
          </CardHeader>
          <CardContent>
            <Fact
              label="Product"
              value={
                detail.variantOptionLabel
                  ? `${detail.productName} (${detail.variantOptionLabel})`
                  : detail.productName
              }
            />
            <Fact
              label="Coverage"
              value={durationLabel(detail.warrantyDuration, detail.warrantyDurationUnit)}
            />
            <Fact
              label="Validity"
              value={`${formatDate(detail.warrantyStartDate)} → ${formatDate(detail.warrantyExpiryDate)}`}
            />
            <Fact label="Defective units" value={String(claim.defectiveQuantity)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Resolution</CardTitle>
          </CardHeader>
          <CardContent>
            <Fact label="Replaced units" value={String(claim.replacementQuantity)} />
            <Fact
              label="Recovered"
              value={
                claim.recoveryAmount
                  ? `${formatCurrency(claim.recoveryAmount)}${claim.recoveryMethod ? ` · ${claim.recoveryMethod.replace(/_/g, " ")}` : ""}`
                  : "—"
              }
            />
            {claim.recoveryReferenceId ? (
              <Fact label="Reference" value={claim.recoveryReferenceId} />
            ) : null}
            <Fact
              label="Shop cost"
              value={claim.costAmount ? formatCurrency(claim.costAmount) : "—"}
            />
            {claim.closedDate ? (
              <Fact label="Closed" value={formatDateTime(claim.closedDate)} />
            ) : null}
          </CardContent>
        </Card>
      </div>

      {claim.issueDescription ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Issue description</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-700">{claim.issueDescription}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ClaimTimeline events={detail.events} />

          {!isTerminal && canManage && (
            <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
              <Textarea
                rows={2}
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder="Add an internal note to this claim…"
                aria-label="Internal note"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!noteDraft.trim() || addNote.isPending}
                  onClick={() => void submitNote()}
                >
                  <Send aria-hidden="true" />
                  Add note
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <SupplierClaimActionDialog
        claimId={claimId}
        action={activeAction}
        onClose={() => setActiveAction(null)}
      />
    </div>
  );
}
