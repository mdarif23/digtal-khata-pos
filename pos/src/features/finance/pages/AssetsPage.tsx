import { useState } from "react";
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
import { StatusBadge } from "@/components/common/StatusBadge";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { formatCurrency, formatDate } from "@/lib/format";
import { ReportTable, type ReportColumn } from "@/features/reports/components/ReportTable";
import { createAssetApi, runDepreciationApi } from "../finance.api";
import { useAssets, useInvalidateFinance } from "../hooks/useFinance";
import type { BusinessAsset } from "../finance.types";

/**
 * Business assets with straight-line monthly depreciation. The scheduler
 * depreciates the previous month; this page can also trigger a manual run.
 */

export function AssetsPage() {
  const assets = useAssets();
  const invalidate = useInvalidateFinance();
  const [createOpen, setCreateOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const runDepreciation = async () => {
    setRunning(true);
    try {
      await createEntityPromiseToast(
        () => runDepreciationApi(),
        { success: "Depreciation posted", loading: "Running previous-month depreciation…" },
      );
      invalidate();
    } finally {
      setRunning(false);
    }
  };

  const columns: ReportColumn<BusinessAsset>[] = [
    { key: "name", header: "Asset", render: (row) => <span className="font-medium">{row.name}</span> },
    { key: "category", header: "Category", render: (row) => <span className="capitalize">{row.category}</span> },
    { key: "acquiredAt", header: "Acquired", render: (row) => formatDate(row.acquiredAt) },
    {
      key: "cost",
      header: "Cost",
      render: (row) => formatCurrency(row.cost),
      className: "text-right tabular-nums",
      headerClassName: "text-right",
    },
    {
      key: "accumulatedDepreciation",
      header: "Depreciated",
      render: (row) => formatCurrency(row.accumulatedDepreciation),
      className: "text-right tabular-nums",
      headerClassName: "text-right",
    },
    {
      key: "bookValue",
      header: "Book value",
      render: (row) => <strong>{formatCurrency(row.bookValue ?? "0")}</strong>,
      className: "text-right tabular-nums",
      headerClassName: "text-right",
    },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        <StatusBadge tone={row.status === "active" ? "success" : "neutral"}>
          {row.status.replace("_", " ")}
        </StatusBadge>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Assets & Depreciation"
        description="Straight-line monthly depreciation: DR depreciation expense / CR accumulated depreciation (contra-asset), idempotent per month."
        actions={
          <>
            <Button variant="outline" onClick={runDepreciation} disabled={running}>
              {running ? "Running…" : "Run previous-month depreciation"}
            </Button>
            <Button onClick={() => setCreateOpen(true)}>Add Asset</Button>
          </>
        }
      />

      <Card>
        <CardContent>
          <ReportTable
            columns={columns}
            data={assets.data ?? []}
            loading={assets.isLoading}
            keyExtractor={(row) => row.id}
            emptyMessage="No business assets recorded."
          />
        </CardContent>
      </Card>

      <CreateAssetDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageContainer>
  );
}

function CreateAssetDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateFinance();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("equipment");
  const [acquiredAt, setAcquiredAt] = useState(new Date().toISOString().slice(0, 10));
  const [cost, setCost] = useState("");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("");
  const [method, setMethod] = useState("cash");

  const submit = async () => {
    await createEntityPromiseToast(
      () =>
        createAssetApi({
          name,
          category: category as "equipment" | "furniture" | "vehicle" | "other",
          acquiredAt,
          cost: Number(cost),
          usefulLifeMonths: Number(usefulLifeMonths),
          method,
        }),
      { success: `Asset "${name}" recorded`, loading: "Posting acquisition…" },
    );
    invalidate();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add business asset</DialogTitle>
          <DialogDescription>
            Acquisition posts DR asset / CR cash (or payables). Depreciation
            runs monthly: (cost) / useful life.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="equipment">Equipment</SelectItem>
                  <SelectItem value="furniture">Furniture</SelectItem>
                  <SelectItem value="vehicle">Vehicle</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Acquired at</Label>
              <Input
                type="date"
                value={acquiredAt}
                onChange={(e) => setAcquiredAt(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Cost (৳)</Label>
              <Input type="number" min={0} value={cost} onChange={(e) => setCost(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Useful life (months)</Label>
              <Input
                type="number"
                min={1}
                value={usefulLifeMonths}
                onChange={(e) => setUsefulLifeMonths(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Paid via</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="bank">Bank</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!name || !cost || !usefulLifeMonths}
          >
            Save asset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
