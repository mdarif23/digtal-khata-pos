import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { RefreshCcw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CustomerDuesTable,
  type CustomerRowActions,
} from "./components/CustomerDuesTable";
import {
  SupplierPayablesTable,
  type SupplierRowActions,
} from "./components/SupplierPayablesTable";
import { DueSummaryCards } from "./components/DueSummaryCards";
import {
  RecordPaymentDialog,
  type PaymentTarget,
} from "./components/RecordPaymentDialog";
import {
  PurchasePaymentHistoryDialog,
  SalePaymentHistoryDialog,
} from "./components/PaymentHistoryDialogs";
import { LedgerDialog } from "./components/LedgerDialog";
import { MessageDialog } from "./components/MessageDialog";
import { useCustomerDueRows, useSupplierDueRows } from "./hooks/useDueManagement";
import { todayInputValue } from "./lib/format";
import type {
  CustomerDueRow,
  DueRowFilter,
  SupplierDueRow,
} from "./api/dueManagement.api";

const statusOptions = [
  { value: "all", label: "All open" },
  { value: "unpaid", label: "Unpaid" },
  { value: "partial", label: "Partially paid" },
  { value: "overdue", label: "Overdue" },
  { value: "paid", label: "Settled" },
] as const;

type DueTab = "customers" | "suppliers";

export function DueManagementPage() {
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<DueTab>("customers");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<DueRowFilter["status"]>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Dialog state
  const [paymentTarget, setPaymentTarget] = useState<PaymentTarget | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [saleHistoryId, setSaleHistoryId] = useState<number | null>(null);
  const [purchaseHistoryId, setPurchaseHistoryId] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [ledger, setLedger] = useState<{
    kind: "customer" | "supplier";
    partyId: number;
    partyName: string;
  } | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [messageTarget, setMessageTarget] = useState<
    | (CustomerDueRow & { isCustomer: true })
    | (SupplierDueRow & { isCustomer: false })
    | null
  >(null);
  const [messageOpen, setMessageOpen] = useState(false);

  const filters: DueRowFilter = useMemo(
    () => ({
      search: search || undefined,
      status,
      from: from || undefined,
      to: to || undefined,
    }),
    [search, status, from, to],
  );

  const customerQuery = useCustomerDueRows(
    activeTab === "customers" ? filters : { status: "all" },
  );
  const supplierQuery = useSupplierDueRows(
    activeTab === "suppliers" ? filters : { status: "all" },
  );

  function applySearch() {
    setSearch(searchInput.trim());
  }

  function resetFilters() {
    setSearchInput("");
    setSearch("");
    setStatus("all");
    setFrom("");
    setTo("");
  }

  const customerActions: CustomerRowActions = {
    onRecordPayment: (row) => {
      setPaymentTarget({
        kind: "customer",
        saleId: row.saleId,
        customerName: row.customerName ?? "Walk-in customer",
        invoiceNumber: row.invoiceNumber,
        outstandingAmount: row.outstandingAmount,
      });
      setPaymentOpen(true);
    },
    onViewPayments: (row) => {
      setSaleHistoryId(row.saleId);
      setHistoryOpen(true);
    },
    onOpenLedger: (row) => {
      if (row.customerId === null) return;
      setLedger({
        kind: "customer",
        partyId: row.customerId,
        partyName: row.customerName ?? `Customer #${row.customerId}`,
      });
      setLedgerOpen(true);
    },
    onMessage: (row) => {
      setMessageTarget({ ...row, isCustomer: true });
      setMessageOpen(true);
    },
    onViewSale: () => navigate("/sales"),
  };

  const supplierActions: SupplierRowActions = {
    onRecordPayment: (row) => {
      setPaymentTarget({
        kind: "supplier",
        purchaseId: row.purchaseId,
        supplierName: row.supplierName ?? "Supplier",
        purchaseInvoice: row.purchaseInvoice,
        outstandingAmount: row.outstandingAmount,
      });
      setPaymentOpen(true);
    },
    onViewPayments: (row) => {
      setPurchaseHistoryId(row.purchaseId);
      setHistoryOpen(true);
    },
    onOpenLedger: (row) => {
      if (row.supplierId === null) return;
      setLedger({
        kind: "supplier",
        partyId: row.supplierId,
        partyName: row.supplierName ?? `Supplier #${row.supplierId}`,
      });
      setLedgerOpen(true);
    },
    onMessage: (row) => {
      setMessageTarget({ ...row, isCustomer: false });
      setMessageOpen(true);
    },
    onViewPurchase: () => navigate("/purchases-list"),
  };

  const toolbar = (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="due-search">Search</Label>
        <Input
          id="due-search"
          value={searchInput}
          placeholder="Name, phone, invoice…"
          className="lg:w-56"
          onChange={(event) => setSearchInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") applySearch();
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="due-status">Status</Label>
        <Select
          value={status ?? "all"}
          onValueChange={(value) =>
            setStatus(value as DueRowFilter["status"])
          }
          items={statusOptions.map((option) => ({
            value: String(option.value),
            label: option.label,
          }))}
        >
          <SelectTrigger id="due-status" className="lg:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="due-from">From</Label>
        <Input
          id="due-from"
          type="date"
          max={todayInputValue()}
          value={from}
          className="lg:w-40"
          onChange={(event) => setFrom(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="due-to">To</Label>
        <Input
          id="due-to"
          type="date"
          max={todayInputValue()}
          value={to}
          className="lg:w-40"
          onChange={(event) => setTo(event.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={applySearch}>
          Apply
        </Button>
        <Button variant="ghost" onClick={resetFilters}>
          <RefreshCcw />
          Reset
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Due Management
          </h1>
          <p className="text-sm text-muted-foreground">
            Track receivables and payables side by side — and settle them.
          </p>
        </div>
        <div className="flex items-center gap-2" role="tablist" aria-label="Due view">
          <Button
            role="tab"
            aria-selected={activeTab === "customers"}
            variant={activeTab === "customers" ? "default" : "outline"}
            onClick={() => setActiveTab("customers")}
          >
            Customer dues
          </Button>
          <Button
            role="tab"
            aria-selected={activeTab === "suppliers"}
            variant={activeTab === "suppliers" ? "default" : "outline"}
            onClick={() => setActiveTab("suppliers")}
          >
            Supplier payables
          </Button>
        </div>
      </div>

      <DueSummaryCards />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" />
            {activeTab === "customers" ? "Customer dues" : "Supplier payables"}
          </CardTitle>
          <CardDescription>
            {activeTab === "customers"
              ? "Invoice-level receivables. Record full or partial collections, review history, or open a customer ledger."
              : "Purchase-level payables. Record supplier payments, review history, or open a supplier ledger."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activeTab === "customers" ? (
            <CustomerDuesTable
              rows={customerQuery.data ?? []}
              loading={customerQuery.isLoading}
              isError={customerQuery.isError}
              onRetry={() => void customerQuery.refetch()}
              actions={customerActions}
              toolbar={toolbar}
            />
          ) : (
            <SupplierPayablesTable
              rows={supplierQuery.data ?? []}
              loading={supplierQuery.isLoading}
              isError={supplierQuery.isError}
              onRetry={() => void supplierQuery.refetch()}
              actions={supplierActions}
              toolbar={toolbar}
            />
          )}
        </CardContent>
      </Card>

      <RecordPaymentDialog
        target={paymentTarget}
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
      />

      <SalePaymentHistoryDialog
        saleId={saleHistoryId}
        open={historyOpen && saleHistoryId !== null}
        onOpenChange={(open) => {
          setHistoryOpen(open);
          if (!open) setSaleHistoryId(null);
        }}
      />
      <PurchasePaymentHistoryDialog
        purchaseId={purchaseHistoryId}
        open={historyOpen && purchaseHistoryId !== null}
        onOpenChange={(open) => {
          setHistoryOpen(open);
          if (!open) setPurchaseHistoryId(null);
        }}
      />

      <LedgerDialog
        kind={ledger?.kind ?? "customer"}
        partyId={ledger?.partyId ?? null}
        partyName={ledger?.partyName ?? ""}
        open={ledgerOpen}
        onOpenChange={setLedgerOpen}
      />

      <MessageDialog
        target={
          messageTarget
            ? {
                isCustomer: messageTarget.isCustomer,
                name:
                  (messageTarget.isCustomer
                    ? messageTarget.customerName
                    : messageTarget.supplierName) ?? "",
                phone: messageTarget.phone,
                invoiceNumber: messageTarget.isCustomer
                  ? messageTarget.invoiceNumber
                  : messageTarget.purchaseInvoice,
                invoiceDate: messageTarget.isCustomer
                  ? messageTarget.invoiceDate
                  : messageTarget.purchaseDate,
                totalAmount: messageTarget.totalAmount,
                outstandingAmount: messageTarget.outstandingAmount,
              }
            : null
        }
        open={messageOpen}
        onOpenChange={setMessageOpen}
      />
    </div>
  );
}
