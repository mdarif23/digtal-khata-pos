import { useEffect, useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
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
  useAddWarrantyClaimNote,
  useWarrantyClaimDetail,
} from "../hooks/useWarrantyClaims";
import { formatCurrency, formatDate, formatDateTime } from "@/features/reports/utils/reportUtils";
import { WarrantyDataTable } from "../components/table/WarrantyDataTable";
import { WarrantyStatusBadge } from "../components/WarrantyStatusBadge";
import { ClaimActionDialog } from "../components/ClaimActionDialog";
import { ClaimTimeline } from "../components/ClaimTimeline";
import {
  CLAIM_TRANSITION_LABELS,
  durationLabel,
} from "../lib/warranty-format";
import type { WarrantyClaimRow } from "../types/warranty.types";
import type { WarrantyTableFeatures } from "../components/table/warranty-table-features";

const columnHelper = createColumnHelper<WarrantyTableFeatures, WarrantyClaimRow>();

/** Inspection/approval/repair/replacement/pickup actions share the manage
 *  permission; closing and cancelling have their own. */
const MANAGE_TRANSITIONS = new Set([
  "under_inspection",
  "approved",
  "rejected",
  "repairing",
  "waiting_parts",
  "ready_for_pickup",
  "replaced",
]);

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 py-1.5 last:border-0">
      <span className="text-xs whitespace-nowrap text-slate-500">{label}</span>
      <span className="text-right text-sm text-slate-800">{value}</span>
    </div>
  );
}

export function WarrantyClaimDetailPage() {
  const { id } = useParams();
  const claimId = Number(id);
  const query = useWarrantyClaimDetail(claimId);
  const { hasPermission } = usePermissions();

  const [activeTransition, setActiveTransition] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const addNote = useAddWarrantyClaimNote();

  useEffect(() => {
    if (query.isError) {
      toast.add({
        type: "error",
        title: "Could not load the claim",
        description: getErrorMessage(query.error),
      });
    }
  }, [query.isError, query.error]);

  const siblingColumns = useMemo(
    () => [
      columnHelper.accessor("claimNumber", {
        id: "claimNumber",
        header: "Claim #",
        cell: ({ row }) =>
          row.original.id === claimId ? (
            <span className="font-mono text-sm font-semibold text-slate-900">
              {row.original.claimNumber}
            </span>
          ) : (
            <Link
              to={`/warranty/claims/${row.original.id}`}
              className="font-mono text-sm font-semibold text-emerald-700 hover:underline"
            >
              {row.original.claimNumber}
            </Link>
          ),
      }),
      columnHelper.accessor("status", {
        id: "status",
        header: "Status",
        cell: ({ row }) => <WarrantyStatusBadge status={row.original.status} />,
      }),
      columnHelper.accessor("claimType", {
        id: "claimType",
        header: "Type",
        cell: ({ row }) => (
          <span className="text-xs capitalize">
            {row.original.claimType.replace(/_/g, " ")}
          </span>
        ),
      }),
      columnHelper.accessor("repairCost", {
        id: "repairCost",
        header: "Repair cost",
        cell: ({ row }) => formatCurrency(row.original.repairCost),
      }),
      columnHelper.accessor("createdAt", {
        id: "createdAt",
        header: "Filed",
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap text-slate-500">
            {formatDateTime(row.original.createdAt)}
          </span>
        ),
      }),
    ],
    [claimId],
  );

  if (query.isPending) {
    return (
      <div className="space-y-4 p-5">
        <Skeleton className="h-8 w-72" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
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
            Unable to load this claim.
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
  const isClosed = claim.status === "closed" || claim.status === "cancelled";

  const allowedActions = detail.allowedTransitions.filter((transition) =>
    MANAGE_TRANSITIONS.has(transition)
      ? hasPermission("warranty.claim.manage")
      : hasPermission("warranty.claim.close"),
  );

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
            render={<Link to="/warranty/claims" />}
            variant="outline"
            size="icon"
            aria-label="Back to warranty claims"
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-slate-950">
              <span className="font-mono">{claim.claimNumber}</span>
              <WarrantyStatusBadge status={claim.status} />
            </h1>
            <p className="text-sm text-slate-500">
              {claim.claimType.replace(/_/g, " ")} · filed{" "}
              {formatDateTime(claim.createdAt)}
            </p>
          </div>
        </div>

        {allowedActions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {allowedActions.map((transition) => (
              <Button
                key={transition}
                variant={
                  transition === "closed" || transition === "cancelled"
                    ? "outline"
                    : "default"
                }
                size="sm"
                onClick={() => setActiveTransition(transition)}
              >
                {CLAIM_TRANSITION_LABELS[transition] ?? transition}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Customer & sale</CardTitle>
          </CardHeader>
          <CardContent>
            <Fact label="Customer" value={detail.customerName ?? "Walk-in"} />
            <Fact label="Phone" value={detail.customerPhone ?? "—"} />
            <Fact label="Email" value={detail.customerEmail ?? "—"} />
            <Fact label="Address" value={detail.customerAddress ?? "—"} />
            <Fact
              label="Invoice"
              value={
                detail.invoiceNumber ? (
                  <span className="font-mono text-xs">{detail.invoiceNumber}</span>
                ) : (
                  "—"
                )
              }
            />
            <Fact
              label="Serial"
              value={
                claim.serialNumber ? (
                  <span className="font-mono text-xs">{claim.serialNumber}</span>
                ) : (
                  "—"
                )
              }
            />
            <Fact label="Location" value={detail.locationName ?? "—"} />
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
              label="Warranty"
              value={
                <Link
                  to={`/warranty/registry/${claim.warrantyId}`}
                  className="font-mono text-xs text-emerald-700 hover:underline"
                >
                  {detail.warrantyNumber}
                </Link>
              }
            />
            <Fact
              label="Coverage"
              value={`${durationLabel(detail.warrantyDuration, detail.warrantyDurationUnit)}`}
            />
            <Fact
              label="Validity"
              value={`${formatDate(detail.warrantyStartDate)} → ${formatDate(detail.warrantyExpiryDate)}`}
            />
            <Fact
              label="Warranty status"
              value={<WarrantyStatusBadge status={detail.warrantyStatus} />}
            />
            <Fact label="Provider" value={detail.warrantyProvider ?? "Shop warranty"} />
            {detail.warrantyTerms ? (
              <Fact
                label="Terms"
                value={<span className="text-xs text-slate-600">{detail.warrantyTerms}</span>}
              />
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <Fact label="Claim type" value={claim.claimType.replace(/_/g, " ")} />
            <Fact label="Received on" value={formatDate(claim.receivedDate)} />
            <Fact
              label="Repair cost"
              value={claim.repairCost ? formatCurrency(claim.repairCost) : "—"}
            />
            {claim.inspectionNotes ? (
              <Fact
                label="Inspection"
                value={<span className="text-xs text-slate-600">{claim.inspectionNotes}</span>}
              />
            ) : null}
            {claim.repairDescription ? (
              <Fact
                label="Repair"
                value={<span className="text-xs text-slate-600">{claim.repairDescription}</span>}
              />
            ) : null}
            {claim.partsUsed ? (
              <Fact
                label="Parts used"
                value={<span className="text-xs text-slate-600">{claim.partsUsed}</span>}
              />
            ) : null}
            {claim.replacementVariantId ? (
              <Fact
                label="Replacement"
                value={
                  <span className="text-xs text-slate-600">
                    Variant #{claim.replacementVariantId}
                    {claim.replacementSerialNumber
                      ? ` · SN ${claim.replacementSerialNumber}`
                      : ""}
                  </span>
                }
              />
            ) : null}
            {claim.pickupDate ? (
              <Fact label="Picked up" value={formatDate(claim.pickupDate)} />
            ) : null}
            {claim.resolutionType ? (
              <Fact
                label="Resolution"
                value={<span className="text-xs capitalize">{claim.resolutionType.replace(/_/g, " ")}</span>}
              />
            ) : null}
            {claim.resolutionNotes ? (
              <Fact
                label="Resolution note"
                value={<span className="text-xs text-slate-600">{claim.resolutionNotes}</span>}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reported problem</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-700">{claim.reportedProblem}</p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ClaimTimeline events={detail.events} />

            {!isClosed && hasPermission("warranty.claim.manage") && (
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

        <div>
          <h2 className="mb-3 text-base font-semibold text-slate-900">
            Claims on this warranty
          </h2>
          <WarrantyDataTable
            columns={siblingColumns}
            data={detail.siblingClaims}
            loading={query.isFetching}
            emptyMessage="No other claims on this warranty."
          />
        </div>
      </div>

      <ClaimActionDialog
        claimId={claimId}
        transition={activeTransition}
        onClose={() => setActiveTransition(null)}
      />
    </div>
  );
}
