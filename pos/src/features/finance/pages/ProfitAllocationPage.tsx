import { useState } from "react";
import { ArrowDownRight, Coins, PieChart } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { formatCurrency, formatDate } from "@/features/reports/utils/reportUtils";
import {
  createAllocationApi,
  realizeAllocationApi,
  reverseAllocationApi,
} from "../finance.api";
import {
  useInvalidateFinance,
  useOwners,
  useProfitAllocations,
} from "../hooks/useFinance";
import type { ProfitAllocation } from "../finance.types";

/**
 * Profit Allocation: designate distributable profit into reserves /
 * reinvestment / owner distribution. Server-authoritative — the backend
 * recomputes distributable profit and rejects over-allocation.
 */

const CATEGORY_LABELS: Record<string, string> = {
  reinvestment: "Business reinvestment",
  owner_distribution: "Owner distribution",
  emergency_reserve: "Emergency reserve",
  expansion: "Business expansion",
  debt_repayment: "Debt repayment",
  other: "Other reserve",
};

export function ProfitAllocationPage() {
  const allocations = useProfitAllocations();
  const invalidate = useInvalidateFinance();
  const [createOpen, setCreateOpen] = useState(false);

  const realize = async (lineId: number, ownerProfileId: number) => {
    await createEntityPromiseToast(
      () => realizeAllocationApi(lineId, { ownerProfileId, method: "cash" }),
      { success: "Distribution recorded", loading: "Posting distribution…" },
    );
    invalidate();
  };

  const reverse = async (allocationId: number) => {
    await createEntityPromiseToast(
      () => reverseAllocationApi(allocationId, "Reversed by owner"),
      { success: "Allocation reversed", loading: "Reversing…" },
    );
    invalidate();
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
            Finance &amp; Growth
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            Profit Allocation
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Designations only — no cash moves until a distribution is realized.
            The backend recomputes distributable profit and rejects
            over-allocation and overlapping periods.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <PieChart className="size-4" /> Allocate Profit
        </Button>
      </header>

      <div className="space-y-4">
        {(allocations.data ?? []).map((allocation) => (
          <AllocationCard
            key={allocation.id}
            allocation={allocation}
            onRealize={realize}
            onReverse={reverse}
          />
        ))}
        {allocations.data?.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center text-sm text-slate-400">
              No allocations yet — allocate a period's profit to get started.
            </CardContent>
          </Card>
        )}
      </div>

      <CreateAllocationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={() => {
          setCreateOpen(false);
          invalidate();
        }}
      />
    </div>
  );
}

function AllocationCard({
  allocation,
  onRealize,
  onReverse,
}: {
  allocation: ProfitAllocation;
  onRealize: (lineId: number, ownerProfileId: number) => Promise<void>;
  onReverse: (allocationId: number) => Promise<void>;
}) {
  const owners = useOwners();
  const [ownerProfileId, setOwnerProfileId] = useState("");
  const reversed = allocation.status === "reversed";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            {allocation.periodLabel ?? `${allocation.periodStart} → ${allocation.periodEnd}`}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              Distributable {formatCurrency(allocation.totalDistributable)}
            </Badge>
            <Badge
              variant="outline"
              className={
                reversed
                  ? "text-xs text-slate-500"
                  : "text-xs text-emerald-700"
              }
            >
              {reversed ? "Reversed" : "Allocated"}{" "}
              {formatCurrency(allocation.totalAllocated)}
            </Badge>
            {!reversed && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onReverse(allocation.id)}
              >
                Reverse
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {(allocation.lines ?? []).map((line) => {
          const unrealized =
            Number(line.amount) - Number(line.realizedAmount);
          const isDistribution = line.category === "owner_distribution";
          const canRealize = !reversed && isDistribution && unrealized > 0.005;
          return (
            <div
              key={line.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">
                  {CATEGORY_LABELS[line.category] ?? line.category}
                </p>
                <p className="text-xs text-slate-500">
                  {line.basisType === "percent"
                    ? `${Number(line.basisValue)}% of distributable`
                    : "Fixed amount"}{" "}
                  · realized {formatCurrency(line.realizedAmount)}
                  {line.realizedReference ? ` (${line.realizedReference})` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-950">
                  {formatCurrency(line.amount)}
                </span>
                {canRealize && (
                  <div className="flex items-center gap-1">
                    <Select
                      value={ownerProfileId}
                      onValueChange={setOwnerProfileId}
                    >
                      <SelectTrigger className="h-8 w-36 text-xs">
                        <SelectValue placeholder="Pay owner" />
                      </SelectTrigger>
                      <SelectContent>
                        {(owners.data ?? []).map((owner) => (
                          <SelectItem key={owner.id} value={String(owner.id)}>
                            {owner.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!ownerProfileId}
                      onClick={() =>
                        onRealize(line.id, Number(ownerProfileId))
                      }
                    >
                      <ArrowDownRight className="size-3.5" /> Realize{" "}
                      {formatCurrency(unrealized)}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function CreateAllocationDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [periodLabel, setPeriodLabel] = useState("");
  const [lines, setLines] = useState<
    { category: string; basisType: "percent" | "fixed"; basisValue: string; amount: string }[]
  >([
    { category: "reinvestment", basisType: "percent", basisValue: "50", amount: "" },
    { category: "owner_distribution", basisType: "percent", basisValue: "30", amount: "" },
    { category: "emergency_reserve", basisType: "percent", basisValue: "20", amount: "" },
  ]);

  const submit = async () => {
    await createEntityPromiseToast(
      () =>
        createAllocationApi({
          periodStart,
          periodEnd,
          periodLabel: periodLabel || null,
          lines: lines.map((line) => ({
            category: line.category,
            basisType: line.basisType,
            basisValue:
              line.basisType === "percent" ? Number(line.basisValue) : null,
            amount: line.basisType === "fixed" ? Number(line.amount) : null,
          })),
        }),
      { success: "Profit allocated", loading: "Validating against the ledger…" },
    );
    onSaved();
  };

  const totalPercent = lines
    .filter((l) => l.basisType === "percent")
    .reduce((sum, l) => sum + (Number(l.basisValue) || 0), 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Allocate distributable profit</DialogTitle>
          <DialogDescription>
            Percent lines resolve server-side against the period's verified net
            profit. Over-allocation and overlapping periods are rejected.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label>Period start</Label>
              <Input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Period end</Label>
              <Input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Label (optional)</Label>
              <Input
                value={periodLabel}
                onChange={(e) => setPeriodLabel(e.target.value)}
                placeholder="e.g. January"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Allocation lines</Label>
            {lines.map((line, index) => (
              <div key={index} className="grid grid-cols-12 items-center gap-2">
                <div className="col-span-5">
                  <Select
                    value={line.category}
                    onValueChange={(value) =>
                      setLines((prev) =>
                        prev.map((l, i) =>
                          i === index ? { ...l, category: value } : l,
                        ),
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Select
                    value={line.basisType}
                    onValueChange={(value) =>
                      setLines((prev) =>
                        prev.map((l, i) =>
                          i === index
                            ? {
                                ...l,
                                basisType: value as "percent" | "fixed",
                              }
                            : l,
                        ),
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percent">%</SelectItem>
                      <SelectItem value="fixed">৳ fixed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-4">
                  {line.basisType === "percent" ? (
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={line.basisValue}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((l, i) =>
                            i === index ? { ...l, basisValue: e.target.value } : l,
                          ),
                        )
                      }
                      placeholder="% of profit"
                    />
                  ) : (
                    <Input
                      type="number"
                      min={0}
                      value={line.amount}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((l, i) =>
                            i === index ? { ...l, amount: e.target.value } : l,
                          ),
                        )
                      }
                      placeholder="Amount ৳"
                    />
                  )}
                </div>
                <div className="col-span-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setLines((prev) => prev.filter((_, i) => i !== index))
                    }
                  >
                    ✕
                  </Button>
                </div>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setLines((prev) => [
                  ...prev,
                  {
                    category: "other",
                    basisType: "percent",
                    basisValue: "",
                    amount: "",
                  },
                ])
              }
            >
              Add line
            </Button>
          </div>

          <p className="text-xs text-slate-500">
            Percent lines total {totalPercent}%
            {totalPercent > 100 ? " — exceeds 100%, adjust before submitting." : ""}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!periodStart || !periodEnd || lines.length === 0 || totalPercent > 100}
          >
            Confirm allocation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
