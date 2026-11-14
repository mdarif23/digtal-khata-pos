import { useState } from "react";
import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { StatusBadge, type StatusTone } from "@/components/common/StatusBadge";
import { EmptyState } from "@/components/common/EmptyState";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "@/components/ui/toast";
import { extractApiError } from "../components/RuleDialog";
import {
  useBulkApproveProposals,
  useDecideProposal,
  useGenerateProposals,
  useProposals,
  useRunAutoUpdate,
} from "../hooks/usePricing";
import { usePricingSettings, useUpdatePricingSettings } from "../hooks/usePricing";
import type { PriceProposal } from "../pricing.types";

const PROPOSAL_TONES: Record<PriceProposal["status"], StatusTone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  applied: "success",
  stale: "warning",
};

/**
 * Mode A proposals (Phase 8): cost/rule changes become reviewable price
 * recommendations; approval is the sanctioned write. Mode B (auto-update)
 * sweeps when the business opts in via Pricing Settings.
 */
export function PriceProposalsPage() {
  const { hasPermission } = usePermissions();
  const canDecide = hasPermission("pricing.product.manage");
  const canManage = hasPermission("pricing.manage");
  const [status, setStatus] = useState<string>("pending");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);

  const settingsQuery = usePricingSettings();
  const updateSettings = useUpdatePricingSettings();
  const proposalsQuery = useProposals({ status, page, pageSize: 25 });
  const generate = useGenerateProposals();
  const decide = useDecideProposal();
  const bulkApprove = useBulkApproveProposals();
  const runSweep = useRunAutoUpdate();

  const rows = proposalsQuery.data?.rows ?? [];
  const meta = proposalsQuery.data?.meta;

  async function doGenerate() {
    try {
      const result = await generate.mutateAsync();
      toast.add({
        type: "success",
        description: `${result.created} created, ${result.staled} staled, ${result.unchanged} unchanged.`,
      });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not generate proposals."),
        priority: "high",
      });
    }
  }

  async function decideOne(id: number, decision: "approve" | "reject") {
    try {
      await decide.mutateAsync({ id, decision });
      toast.add({ type: "success", description: `Proposal ${decision}d.` });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, `Could not ${decision} the proposal.`),
        priority: "high",
      });
    }
  }

  async function approveSelected() {
    if (selected.length === 0) return;
    try {
      const result = await bulkApprove.mutateAsync(selected);
      toast.add({
        type: result.failed.length > 0 ? "warning" : "success",
        description: `${result.applied.length} applied${result.failed.length > 0 ? `, ${result.failed.length} failed` : ""}.`,
      });
      setSelected([]);
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Bulk approval failed."),
        priority: "high",
      });
    }
  }

  async function sweep() {
    try {
      const result = await runSweep.mutateAsync();
      toast.add({
        type: "success",
        description: `${result.applied} applied, ${result.skipped} skipped, ${result.blocked.length} blocked, ${result.unchanged} unchanged.`,
      });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "The auto-update sweep could not run."),
        priority: "high",
      });
    }
  }

  async function toggleAutoUpdate(enabled: boolean) {
    try {
      await updateSettings.mutateAsync({ autoUpdateEnabled: enabled });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not change the setting."),
        priority: "high",
      });
    }
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Price change proposals"
        description="Generate recommendations from the active pricing rules and the current weighted-average landed costs. Approving a proposal is what writes the price — with a full history row."
        actions={
          canManage ? (
            <div className="flex flex-col items-end gap-2">
              <div className="flex gap-2">
                <Button onClick={() => void doGenerate()} disabled={generate.isPending}>
                  Generate proposals
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void sweep()}
                  disabled={runSweep.isPending || !settingsQuery.data?.autoUpdateEnabled}
                  title={
                    settingsQuery.data?.autoUpdateEnabled
                      ? undefined
                      : "Enable auto-update in Pricing Settings first"
                  }
                >
                  Run auto-update
                </Button>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={settingsQuery.data?.autoUpdateEnabled ?? false}
                  onChange={(e) => void toggleAutoUpdate(e.target.checked)}
                />
                Mode B auto-update enabled
              </label>
            </div>
          ) : undefined
        }
      />
      <Card>
        <CardContent>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {["pending", "approved", "rejected", "applied", "stale"].map((s) => (
              <Button
                key={s}
                size="sm"
                variant={status === s ? "default" : "outline"}
                onClick={() => {
                  setStatus(s);
                  setPage(1);
                  setSelected([]);
                }}
              >
                {s}
              </Button>
            ))}
          </div>
          {canDecide && status === "pending" && rows.length > 0 && (
            <div className="mb-3 flex items-center gap-2 text-sm">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setSelected(
                    selected.length === rows.length ? [] : rows.map((r) => r.id),
                  )
                }
              >
                {selected.length === rows.length ? "Select none" : "Select all"}
              </Button>
              <Button
                size="sm"
                disabled={selected.length === 0 || bulkApprove.isPending}
                onClick={() => void approveSelected()}
              >
                Approve selected ({selected.length})
              </Button>
            </div>
          )}
          {proposalsQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    {canDecide && status === "pending" && <TableHead className="w-8" />}
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Price change</TableHead>
                    <TableHead>Batch</TableHead>
                    <TableHead>Generated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={canDecide && status === "pending" ? 6 : 5}>
                        <EmptyState
                          icon={ClipboardList}
                          title={`No ${status} proposals`}
                          description="Generate proposals to review rule-based price recommendations."
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((proposal) => (
                      <TableRow key={proposal.id}>
                        {canDecide && status === "pending" && (
                          <TableCell>
                            <input
                              type="checkbox"
                              aria-label={`Select proposal for ${proposal.productName}`}
                              checked={selected.includes(proposal.id)}
                              onChange={(e) =>
                                setSelected((prev) =>
                                  e.target.checked
                                    ? [...prev, proposal.id]
                                    : prev.filter((id) => id !== proposal.id),
                                )
                              }
                            />
                          </TableCell>
                        )}
                        <TableCell>
                          <div className="font-medium">{proposal.productName}</div>
                          {proposal.sku && (
                            <div className="text-xs text-muted-foreground">{proposal.sku}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {proposal.oldPrice != null ? `${formatCurrency(proposal.oldPrice)} → ` : ""}
                          <span className="font-semibold">{formatCurrency(proposal.recommendedPrice)}</span>
                          {proposal.percentChange != null && (
                            <Badge
                              variant="outline"
                              className={`ml-2 ${proposal.percentChange >= 0 ? "text-success" : "text-destructive"}`}
                            >
                              {proposal.percentChange >= 0 ? "+" : ""}
                              {proposal.percentChange}%
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {proposal.batchToken}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatDateTime(proposal.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          {canDecide && status === "pending" ? (
                            <div className="flex justify-end gap-1.5">
                              <Button
                                size="sm"
                                disabled={decide.isPending}
                                onClick={() => void decideOne(proposal.id, "approve")}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={decide.isPending}
                                onClick={() => void decideOne(proposal.id, "reject")}
                              >
                                Reject
                              </Button>
                            </div>
                          ) : (
                            <StatusBadge tone={PROPOSAL_TONES[proposal.status]}>
                              {proposal.status}
                            </StatusBadge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
          {meta && meta.totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Page {meta.page} of {meta.totalPages} · {meta.total} proposals
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= meta.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
