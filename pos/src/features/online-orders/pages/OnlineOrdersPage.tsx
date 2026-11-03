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
import { formatCurrency } from "@/features/reports/utils/reportUtils";

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

function SummaryCard({
  label,
  value,
  hint,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">{label}</p>
        <span className={`rounded-md p-1.5 ${accent}`}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-1 text-2xl font-semibold text-slate-800">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}

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
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">Online Orders</h1>
        <p className="text-sm text-slate-500">
          Orders from WooCommerce and your storefronts — confirm, pack, ship
          and track payment collection.
        </p>
      </div>

      {/* KPI dashboard */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <SummaryCard
          label="New / awaiting confirmation"
          value={String(summary?.newOrders ?? "—")}
          hint={`${summary?.total ?? 0} orders in range`}
          icon={RefreshCw}
          accent="bg-blue-50 text-blue-600"
        />
        <SummaryCard
          label="In fulfillment"
          value={
            summary
              ? String(summary.confirmed + summary.processing + summary.packed + summary.readyToShip)
              : "—"
          }
          hint={`${summary?.shipped ?? 0} shipped · ${summary?.delivered ?? 0} delivered`}
          icon={PackageCheck}
          accent="bg-indigo-50 text-indigo-600"
        />
        <SummaryCard
          label="Completed (net of refunds)"
          value={summary ? formatCurrency(summary.netSales) : "—"}
          hint={`${summary?.completed ?? 0} orders · ${formatCurrency(summary?.refundedTotal ?? 0)} refunded`}
          icon={CheckCircle2}
          accent="bg-emerald-50 text-emerald-600"
        />
        <SummaryCard
          label="Issues"
          value={String(summary?.unpaidCount ?? "—")}
          hint={
            summary
              ? `${summary.cancelled} cancelled · ${summary.returnRequests} returns · unpaid above`
              : undefined
          }
          icon={XCircle}
          accent="bg-rose-50 text-rose-600"
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500" htmlFor="oo-search">
            Search
          </label>
          <input
            id="oo-search"
            type="search"
            value={search}
            placeholder="Order # / external ID"
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-52 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500" htmlFor="oo-channel">
            Channel
          </label>
          <select
            id="oo-channel"
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value as SalesChannel | "");
              setPage(1);
            }}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All channels</option>
            <option value="woocommerce">{CHANNEL_LABELS.woocommerce}</option>
            <option value="custom_storefront">
              {CHANNEL_LABELS.custom_storefront}
            </option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500" htmlFor="oo-fulfillment">
            Fulfillment
          </label>
          <select
            id="oo-fulfillment"
            value={fulfillment}
            onChange={(e) => {
              setFulfillment(e.target.value as FulfillmentState | "");
              setPage(1);
            }}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
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
          <label className="text-xs font-medium text-slate-500" htmlFor="oo-status">
            Status
          </label>
          <select
            id="oo-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as OrderStatus | "");
              setPage(1);
            }}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
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
          <label className="text-xs font-medium text-slate-500" htmlFor="oo-location">
            Location
          </label>
          <select
            id="oo-location"
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value ? Number(e.target.value) : "");
              setPage(1);
            }}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
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
          <label className="text-xs font-medium text-slate-500" htmlFor="oo-from">
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
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500" htmlFor="oo-to">
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
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={resetFilters}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          Reset
        </button>
      </div>

      {/* Active-fulfillment quick glance */}
      {summary && summary.shipped > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
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
      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>
          Page {ordersQuery.data?.page ?? page} of {totalPages} ·{" "}
          {ordersQuery.data?.total ?? 0} orders
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-md border border-slate-300 px-3 py-1.5 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border border-slate-300 px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>

      {fulfillment ? (
        <p className="text-xs text-slate-400">
          Filtered by fulfillment stage: <OrderStatusBadge status={fulfillment} />
        </p>
      ) : null}
    </div>
  );
}

export default OnlineOrdersPage;
