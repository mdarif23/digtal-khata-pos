import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  ArrowUpRight,
  ClipboardList,
  PackageCheck,
  Plus,
  Search,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePurchasesStore } from "../usePurchaseStore";
import { formatCurrency } from "@/features/purchases/utils/formatCurrency";
import {
  LandedCostAdjustmentNotice,
  LandedCostReversalNotice,
} from "../components/receiving/LandedCostAdjustmentNotice";
import type {
  LandedCostFeedback,
  PurchaseNewProps,
  PurchaseStoreType,
} from "../purchase.types";

type PurchaseFilter = "all" | "ordered" | "partially_received" | "received";

type PurchaseNoticeState = {
  receiveNotice?: {
    purchaseId: number;
    landedCost: LandedCostFeedback;
  };
  returnNotice?: {
    purchaseId: number;
    landedCost: LandedCostFeedback;
  };
} | null;

const filters: { value: PurchaseFilter; label: string }[] = [
  { value: "all", label: "All orders" },
  { value: "ordered", label: "Ordered" },
  { value: "partially_received", label: "Partially received" },
  { value: "received", label: "Received" },
];


function formatDate(value: Date | string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en-BD", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(date);
}

export const PurchasesList = () => {
  const [filter, setFilter] = useState<PurchaseFilter>("all");
  const [search, setSearch] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  // Landed-cost feedback handed over from a just-completed receive/return.
  const noticeState = (location.state as PurchaseNoticeState) ?? null;
  const receiveNotice = noticeState?.receiveNotice ?? null;
  const returnNotice = noticeState?.returnNotice ?? null;
  const purchases = usePurchasesStore((state) => state.purchases);
  const purchaseItems = usePurchasesStore((state) => state.purchasesItems);
  const returnedItems = usePurchasesStore(
    (state) => state.purchasesReturnItems,
  );
  const getPurchases = usePurchasesStore((state) => state.getPurchases);
  const getPurchaseItems = usePurchasesStore((state) => state.getPurchaseItems);
  const getPurchasesReturnItems = usePurchasesStore(
    (state) => state.getPurchasesReturnItems,
  );
  const loading = usePurchasesStore((state) => state.loading);
  const error = usePurchasesStore((state) => state.error);

  useEffect(() => {
    void Promise.all([
      getPurchases(),
      getPurchaseItems(),
      getPurchasesReturnItems(),
    ]);
  }, [getPurchaseItems, getPurchases, getPurchasesReturnItems]);

  const allPurchases = purchases.allPurchases ?? [];
  const returnStatusByPurchase = useMemo(() => {
    const returnedByItem = new Map(
      returnedItems.map((item) => [
        item.purchaseItemId,
        Number(item.returnQuantity) || 0,
      ]),
    );
    const totalsByPurchase = new Map<
      number,
      { received: number; returned: number }
    >();

    for (const item of purchaseItems) {
      const totals = totalsByPurchase.get(item.purchaseId) ?? {
        received: 0,
        returned: 0,
      };
      totals.received += Number(item.receivedQuantity) || 0;
      totals.returned += returnedByItem.get(item.id) ?? 0;
      totalsByPurchase.set(item.purchaseId, totals);
    }

    return new Map(
      [...totalsByPurchase].flatMap(([purchaseId, totals]) => {
        if (totals.returned <= 0) return [];
        return [
          [
            purchaseId,
            totals.returned >= totals.received
              ? "Returned"
              : "Partially returned",
          ] as const,
        ];
      }),
    );
  }, [purchaseItems, returnedItems]);

  const visiblePurchases = useMemo(() => {
    const query = search.trim().toLowerCase();
    return allPurchases
      .filter((purchase) => filter === "all" || purchase.status === filter)
      .filter(
        (purchase) =>
          !query ||
          purchase.purchaseOrderNumber.toLowerCase().includes(query) ||
          purchase.supplierName?.toLowerCase().includes(query) ||
          purchase.notes?.toLowerCase().includes(query),
      )
      .sort(
        (first, second) =>
          new Date(second.purchaseDate).getTime() -
          new Date(first.purchaseDate).getTime(),
      );
  }, [allPurchases, filter, search]);

  const outstanding = allPurchases.reduce(
    (sum, purchase) => sum + Number(purchase.dueAmount || 0),
    0,
  );
  const awaitingReceipt = allPurchases.filter(
    (purchase) => purchase.status !== "received",
  ).length;

  return (
    <div className="min-h-[calc(100vh-1rem)] bg-muted/30 p-4 md:p-6">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Inventory / Purchases
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              Purchase orders
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Track supplier orders, receiving progress, and outstanding
              balances.
            </p>
          </div>
          <Button nativeButton={false} render={<Link to="/purchases" />}>
            <Plus /> New purchase
          </Button>
        </header>

        {(receiveNotice || returnNotice) && (
          <div className="space-y-3">
            {receiveNotice && (
              <LandedCostAdjustmentNotice
                purchaseId={receiveNotice.purchaseId}
                landedCost={receiveNotice.landedCost}
                onDismiss={() =>
                  navigate(location.pathname, { replace: true, state: null })
                }
              />
            )}
            {returnNotice && (
              <LandedCostReversalNotice
                purchaseId={returnNotice.purchaseId}
                landedCost={returnNotice.landedCost}
                onDismiss={() =>
                  navigate(location.pathname, { replace: true, state: null })
                }
              />
            )}
          </div>
        )}

        <section className="grid gap-4 sm:grid-cols-3">
          <SummaryCard
            title="Total purchase orders"
            value={String(allPurchases.length)}
            icon={<ClipboardList />}
          />
          <SummaryCard
            title="Awaiting receipt"
            value={String(awaitingReceipt)}
            icon={<PackageCheck />}
          />
          <SummaryCard
            title="Outstanding balance"
            value={`৳ ${formatCurrency(outstanding)}`}
            icon={<Wallet />}
          />
        </section>

        <section className="overflow-hidden rounded-xl border bg-background shadow-sm">
          <div className="space-y-4 border-b p-4 md:p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="font-semibold">Orders</h2>
                <p className="text-sm text-muted-foreground">
                  {visiblePurchases.length} of {allPurchases.length} orders
                </p>
              </div>
              <div className="relative w-full md:max-w-sm">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search order, supplier, or note..."
                  aria-label="Search purchase orders"
                  className="pl-9"
                />
              </div>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {filters.map((item) => {
                const count =
                  item.value === "all"
                    ? allPurchases.length
                    : allPurchases.filter(
                        (purchase) => purchase.status === item.value,
                      ).length;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setFilter(item.value)}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-sm transition-colors ${
                      filter === item.value
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/70"
                    }`}
                  >
                    {item.label}{" "}
                    <span className="ml-1 opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <p
              role="alert"
              className="m-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}

          {loading && allPurchases.length === 0 ? (
            <div className="space-y-3 p-5">
              {Array.from({ length: 5 }, (_, index) => (
                <div
                  key={index}
                  className="h-12 animate-pulse rounded-md bg-muted"
                />
              ))}
            </div>
          ) : visiblePurchases.length ? (
            <PurchaseOrderTable
              purchases={visiblePurchases}
              items={purchaseItems}
              returnStatusByPurchase={returnStatusByPurchase}
            />
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
              <ClipboardList className="size-10 text-muted-foreground/50" />
              <p className="mt-3 font-medium">
                {search
                  ? "No matching purchase orders"
                  : "No purchase orders yet"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {search
                  ? "Change your search or status filter and try again."
                  : "Create a purchase order to start tracking stock from suppliers."}
              </p>
              {!search && (
                <Button
                  nativeButton={false}
                  className="mt-4"
                  variant="outline"
                  render={<Link to="/purchases" />}
                >
                  <Plus /> Create purchase
                </Button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

function SummaryCard({
  title,
  value,
  icon,
}: {
  title: string;
  value: string;
  icon: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border bg-background p-4 shadow-sm">
      <div className="rounded-lg bg-primary/10 p-2.5 text-primary">{icon}</div>
      <div>
        <p className="text-sm text-muted-foreground">{title}</p>
        <p className="mt-1 text-xl font-semibold">{value}</p>
      </div>
    </div>
  );
}

function PurchaseOrderTable({
  purchases,
  items,
  returnStatusByPurchase,
}: PurchaseNewProps & {
  items: { purchaseId: number }[];
  returnStatusByPurchase: Map<number, string>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-5 py-3 font-medium">Order</th>
            <th className="px-4 py-3 font-medium">Supplier</th>
            <th className="px-4 py-3 font-medium">Date</th>
            <th className="px-4 py-3 text-right font-medium">Items</th>
            <th className="px-4 py-3 text-right font-medium">Total</th>
            <th className="px-4 py-3 text-right font-medium">Due</th>
            <th className="px-4 py-3 font-medium">Payment</th>
            <th className="px-4 py-3 font-medium">Receiving</th>
            <th className="px-4 py-3 font-medium">Return status</th>
            <th className="px-5 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {purchases.map((purchase) => {
            const lineCount = items.filter(
              (item) => item.purchaseId === purchase.id,
            ).length;
            return (
              <PurchaseOrderRow
                key={purchase.id}
                purchase={purchase}
                lineCount={lineCount}
                returnStatus={returnStatusByPurchase.get(purchase.id)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PurchaseOrderRow({
  purchase,
  lineCount,
  returnStatus,
}: {
  purchase: PurchaseStoreType;
  lineCount: number;
  returnStatus?: string | undefined;
}) {
  const statusStyles: Record<PurchaseStoreType["status"], string> = {
    ordered: "bg-sky-100 text-sky-800",
    partially_received: "bg-amber-100 text-amber-800",
    received: "bg-emerald-100 text-emerald-800",
  };
  const paymentStyles: Record<PurchaseStoreType["paymentStatus"], string> = {
    unpaid: "bg-rose-100 text-rose-800",
    partial: "bg-amber-100 text-amber-800",
    paid: "bg-emerald-100 text-emerald-800",
  };

  return (
    <tr className="hover:bg-muted/30">
      <td className="px-5 py-4">
        <p className="font-medium">{purchase.purchaseOrderNumber}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Updated {formatDate(purchase.updatedAt)}
        </p>
      </td>
      <td className="px-4 py-4">
        <span className="font-medium">
          {purchase.supplierName || "Walk-in purchase"}
        </span>
      </td>
      <td className="px-4 py-4 text-muted-foreground">
        {formatDate(purchase.purchaseDate)}
      </td>
      <td className="px-4 py-4 text-right">{lineCount}</td>
      <td className="whitespace-nowrap px-4 py-4 text-right font-medium">
        ৳ {formatCurrency(Number(purchase.totalAmount) || 0)}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right">
        ৳ {formatCurrency(Number(purchase.dueAmount) || 0)}
      </td>
      <td className="px-4 py-4">
        <StatusBadge
          label={purchase.paymentStatus.replace("_", " ")}
          className={paymentStyles[purchase.paymentStatus]}
        />
      </td>
      <td className="px-4 py-4">
        <StatusBadge
          label={purchase.status.replace("_", " ")}
          className={statusStyles[purchase.status]}
        />
        {/* Landed-cost indicator — only shown when a document exists and
            hasn't been fully reversed (backend sends null otherwise). */}
        {purchase.landedCostStatus && (
          <p className="mt-1 text-xs text-muted-foreground">
            {purchase.landedCostStatus === "pending"
              ? "Landed cost pending"
              : "Landed cost allocated"}
          </p>
        )}
      </td>
      <td className="px-4 py-4">
        {returnStatus ? (
          <StatusBadge
            label={returnStatus}
            className="bg-violet-100 text-violet-800"
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-5 py-4">
        <div className="flex justify-end gap-2">
          {purchase.status !== "received" && (
            <Button
              nativeButton={false}
              size="sm"
              variant="outline"
              render={<Link to={`/receive-items/${purchase.id}`} />}
            >
              Receive
            </Button>
          )}
          {purchase.status !== "ordered" && (
            <Button
              nativeButton={false}
              size="sm"
              variant="outline"
              render={<Link to={`/purchases/landed-cost/${purchase.id}`} />}
            >
              Landed cost
            </Button>
          )}
          {purchase.status !== "ordered" && purchase.supplierId !== null && (
            <Button
              nativeButton={false}
              size="sm"
              variant="outline"
              render={<Link to={`/purchase-return/${purchase.id}`} />}
            >
              <ArrowUpRight /> Return
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function StatusBadge({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${className}`}
    >
      {label}
    </span>
  );
}
