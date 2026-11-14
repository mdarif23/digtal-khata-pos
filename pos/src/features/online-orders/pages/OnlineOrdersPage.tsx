import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { keepPreviousData } from "@tanstack/react-query";
import {
  CheckCircle2,
  PackageCheck,
  RefreshCw,
  Truck,
  XCircle,
} from "lucide-react";
import { useSessionStore } from "@/auth/sessionStore";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { SearchInput } from "@/components/common/SearchInput";
import { SummaryCard } from "@/components/common/SummaryCard";
import { useOnlineOrders, useOrdersSummary } from "../hooks/useOnlineOrders";
import { OnlineOrdersTable } from "../components/OnlineOrdersTable";
import { OrderStatusBadge } from "../components/OrderStatusBadge";
import {
  CHANNEL_LABELS,
  FULFILLMENT_LABELS,
  type FulfillmentState,
  type OnlineOrdersFilters,
  type OrderStatus,
  type SalesChannel,
} from "../types/onlineOrders.types";
import { formatCurrency } from "@/lib/format";

const PAGE_SIZE = 20;

const fulfillmentOptions: FulfillmentState[] = [
  "confirmed",
  "processing",
  "packed",
  "ready_to_ship",
  "shipped",
  "delivered",
  "return_requested",
  "partially_returned",
  "returned",
];

const statusOptions: OrderStatus[] = [
  "pending",
  "completed",
  "cancelled",
  "refunded",
];

/** Online Orders dashboard (module one §4.1) — KPI counts are computed
 * server-side over the same filters as the list below. Cancelled orders are
 * reported separately and never mixed into completed figures. */
export function OnlineOrdersPage() {
  const navigate = useNavigate();
  const locations = useSessionStore((s) => s.locations);

  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState<SalesChannel | "">("");
  const [fulfillment, setFulfillment] = useState<FulfillmentState | "">("");
  const [status, setStatus] = useState<OrderStatus | "">("");
  const [locationId, setLocationId] = useState<number | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

  const filters = useMemo<OnlineOrdersFilters>(
    () => ({
      ...(search ? { search } : {}),
      ...(channel ? { channel } : {}),
      ...(fulfillment ? { fulfillmentStatus: fulfillment } : {}),
      ...(status ? { status } : {}),
      ...(locationId ? { locationId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      page,
      pageSize: PAGE_SIZE,
    }),
    [search, channel, fulfillment, status, locationId, from, to, page],
  );

  const summaryFilters = useMemo(
    () => ({
      ...(channel ? { channel } : {}),
      ...(locationId ? { locationId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    }),
    [channel, locationId, from, to],
  );

  const ordersQuery = useOnlineOrders(filters);
  const summaryQuery = useOrdersSummary(summaryFilters);
  const summary = summaryQuery.data;

  const totalPages = ordersQuery.data
    ? Math.max(1, Math.ceil(ordersQuery.data.total / PAGE_SIZE))
    : 1;

  const resetFilters = () => {
    setSearch("");
    setChannel("");
    setFulfillment("");
    setStatus("");
    setLocationId("");
    setFrom("");
    setTo("");
    setPage(1);
  };

  return (
    <PageContainer>
      <PageHeader
        title="Online Orders"
        description="Orders from WooCommerce and your storefronts — confirm, pack, ship and track payment collection."
      />

      {/* KPI dashboard */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <SummaryCard
          title="New / awaiting confirmation"
          value={String(summary?.newOrders ?? "—")}
          description={`${summary?.total ?? 0} orders in range`}
          icon={<RefreshCw className="size-4 text-muted-foreground" />}
        />
        <SummaryCard
          title="In fulfillment"
          value={
            summary
              ? String(summary.confirmed + summary.processing + summary.packed + summary.readyToShip)
              : "—"
          }
          description={`${summary?.shipped ?? 0} shipped · ${summary?.delivered ?? 0} delivered`}
          icon={<PackageCheck className="size-4 text-muted-foreground" />}
        />
        <SummaryCard
          title="Completed (net of refunds)"
          value={summary ? formatCurrency(summary.netSales) : "—"}
          description={`${summary?.completed ?? 0} orders · ${formatCurrency(summary?.refundedTotal ?? 0)} refunded`}
          icon={<CheckCircle2 className="size-4 text-muted-foreground" />}
        />
        <SummaryCard
          title="Issues"
          value={String(summary?.unpaidCount ?? "—")}
          description={
            summary
              ? `${summary.cancelled} cancelled · ${summary.returnRequests} returns · unpaid above`
              : undefined
          }
          icon={<XCircle className="size-4 text-muted-foreground" />}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="Order # / external ID"
          ariaLabel="Search online orders"
        />
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="oo-channel">
            Channel
          </label>
          <select
            id="oo-channel"
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value as SalesChannel | "");
              setPage(1);
            }}
            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
          >
            <option value="">All channels</option>
            <option value="woocommerce">{CHANNEL_LABELS.woocommerce}</option>
            <option value="custom_storefront">
              {CHANNEL_LABELS.custom_storefront}
            </option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="oo-fulfillment">
            Fulfillment
          </label>
          <select
            id="oo-fulfillment"
            value={fulfillment}
            onChange={(e) => {
              setFulfillment(e.target.value as FulfillmentState | "");
              setPage(1);
            }}
            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
          >
            <option value="">All stages</option>
            {fulfillmentOptions.map((f) => (
              <option key={f} value={f}>
                {FULFILLMENT_LABELS[f]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="oo-status">
            Status
          </label>
          <select
            id="oo-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as OrderStatus | "");
              setPage(1);
            }}
            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
          >
            <option value="">All statuses</option>
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="oo-location">
            Location
          </label>
          <select
            id="oo-location"
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value ? Number(e.target.value) : "");
              setPage(1);
            }}
            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
          >
            <option value="">All locations</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="oo-from">
            From
          </label>
          <input
            id="oo-from"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="oo-to">
            To
          </label>
          <input
            id="oo-to"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
          />
        </div>
        <Button type="button" variant="outline" onClick={resetFilters}>
          Reset
        </Button>
      </div>

      {/* Active-fulfillment quick glance */}
      {summary && summary.shipped > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          <Truck className="h-4 w-4" />
          {summary.shipped} {summary.shipped === 1 ? "order is" : "orders are"} in
          transit — confirm delivery to close the loop.
        </div>
      ) : null}

      <OnlineOrdersTable
        orders={ordersQuery.data?.orders}
        isLoading={ordersQuery.isLoading}
        isError={ordersQuery.isError}
        onRetry={() => void ordersQuery.refetch()}
        onOpenOrder={(id) => void navigate(`/online-orders/${id}`)}
      />

      {/* Server-side pagination */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Page {ordersQuery.data?.page ?? page} of {totalPages} ·{" "}
          {ordersQuery.data?.total ?? 0} orders
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      {fulfillment ? (
        <p className="text-xs text-muted-foreground">
          Filtered by fulfillment stage: <OrderStatusBadge status={fulfillment} />
        </p>
      ) : null}
    </PageContainer>
  );
}

export default OnlineOrdersPage;
