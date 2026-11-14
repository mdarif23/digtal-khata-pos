import { useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  Boxes,
  CheckCircle2,
  Coins,
  Landmark,
  Scale,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/common/StatusBadge";
import { SummaryCard } from "@/components/common/SummaryCard";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { formatCurrency, formatDate } from "@/lib/format";
import { ReportDateFilter } from "@/features/reports/components/ReportDateFilter";
import type { ReportFilters } from "@/features/reports/types/report.types";
import {
  activateFinanceApi,
  getReconciliationApi,
} from "../finance.api";
import {
  financeKeys,
  useFinanceStatus,
  useInvalidateFinance,
  useOverview,
  useReconciliation,
} from "../hooks/useFinance";
import type { ActivationAccount, ReconciliationCheck } from "../finance.types";

/**
 * Financial Overview: the Finance & Growth landing page. Before ledger
 * activation it hosts the opening-balance wizard; after activation it
 * shows the documented overview metrics plus the GL-vs-operational
 * reconciliation status.
 */

const initialAccounts: ActivationAccount[] = [
  { name: "Cash on Hand", type: "cash", openingBalance: 0 },
  { name: "Bank Account", type: "bank", openingBalance: 0 },
];

const ACCOUNT_TYPE_OPTIONS = [
  { value: "cash", label: "Cash (drawers)" },
  { value: "bank", label: "Bank" },
  { value: "mfs", label: "MFS wallet (bKash/Nagad)" },
] as const;

export function FinanceOverviewPage() {
  const status = useFinanceStatus();
  const reconciliation = useReconciliation();

  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
  } as ReportFilters);
  const dateRange = filters.dateRange ?? {
    startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      .toISOString()
      .slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
  };
  const overview = useOverview(dateRange.startDate, dateRange.endDate, status.data?.activated === true);

  if (status.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (status.data && !status.data.activated) {
    return <ActivationWizard />;
  }

  const profit = overview.data?.profit;
  const balances = overview.data?.balances;

  return (
    <PageContainer>
      <PageHeader
        title="Financial Overview"
        description={`Ledger activated ${formatDate(status.data?.activatedAt)} · ${status.data?.journalEntryCount ?? 0} journal entries · ${status.data?.accountCount ?? 0} accounts`}
        actions={
          <ReportDateFilter filters={filters} onFiltersChange={setFilters} showLocationFilter={false} />
        }
      />

      {overview.isError && (
        <Card>
          <CardContent className="flex items-center gap-2 py-4 text-sm text-warning">
            <TriangleAlert className="size-4" />
            Could not load the overview for {dateRange.startDate} → {dateRange.endDate}.
          </CardContent>
        </Card>
      )}

      <section>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Profit &amp; Loss · {dateRange.startDate} → {dateRange.endDate}
        </h2>
        <p className="mb-4 text-xs text-muted-foreground">
          Figures come from the posted general ledger: revenue excludes VAT, owner
          investments/withdrawals are financing (never revenue or expense), and
          GL-only items such as shrinkage and depreciation are included — so
          these numbers can differ slightly from the POS dashboard, which uses
          sale totals incl. VAT.
        </p>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <SummaryCard
            title="Net Revenue"
            value={profit ? formatCurrency(profit.netRevenue) : "—"}
            icon={<ArrowUpRight className="size-4 text-muted-foreground" />}
          />
          <SummaryCard
            title="Gross Profit"
            value={profit ? formatCurrency(profit.grossProfit) : "—"}
            description={profit ? `COGS ${formatCurrency(profit.cogs)}` : undefined}
            icon={<Scale className="size-4 text-muted-foreground" />}
          />
          <SummaryCard
            title="Net Profit"
            value={profit ? formatCurrency(profit.netProfit) : "—"}
            description={profit ? `Opex ${formatCurrency(profit.operatingExpenses)}` : undefined}
            icon={<Coins className="size-4 text-muted-foreground" />}
          />
          <SummaryCard
            title="Loan Interest"
            value={profit ? formatCurrency(profit.interest) : "—"}
            icon={<Banknote className="size-4 text-muted-foreground" />}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Balance Sheet Position (all time)
        </h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <SummaryCard
            title="Cash on Hand"
            value={balances ? formatCurrency(balances.cash) : "—"}
            icon={<Wallet className="size-4 text-muted-foreground" />}
          />
          <SummaryCard
            title="Bank + MFS"
            value={
              balances
                ? formatCurrency(Number(balances.bank) + Number(balances.mfs))
                : "—"
            }
            icon={<Landmark className="size-4 text-muted-foreground" />}
          />
          <SummaryCard
            title="Inventory (GL)"
            value={balances ? formatCurrency(balances.inventory) : "—"}
            description={
              overview.data
                ? `Batch valuation ${formatCurrency(overview.data.inventoryBatchValuation)}`
                : undefined
            }
            icon={<Boxes className="size-4 text-muted-foreground" />}
          />
          <SummaryCard
            title="Receivables"
            value={balances ? formatCurrency(balances.accountsReceivable) : "—"}
            description={balances ? `Payables ${formatCurrency(balances.accountsPayable)}` : undefined}
            icon={<ArrowDownRight className="size-4 text-muted-foreground" />}
          />
        </div>
      </section>

      {overview.data && (
        <section className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Owner Capital</CardTitle>
              <CardDescription>Investments − withdrawals − distributions</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Contributed" value={overview.data.owner.contributed} />
              <Row label="Returned" value={overview.data.owner.returned} />
              <Row label="Distributed" value={overview.data.owner.distributed} />
              <div className="border-t pt-2">
                <Row label="Position" value={overview.data.owner.position} strong />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Liabilities</CardTitle>
              <CardDescription>What the business owes</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Supplier payables" value={balances?.accountsPayable ?? "0.00"} />
              <Row label="Salary payable" value={balances?.salaryPayable ?? "0.00"} />
              <Row label="VAT payable" value={balances?.vatPayable ?? "0.00"} />
              <Row label="Loans payable" value={balances?.loansPayable ?? "0.00"} />
            </CardContent>
          </Card>
          <ReconciliationCard
            checks={reconciliation.data?.checks ?? []}
            allReconciled={reconciliation.data?.allReconciled ?? false}
          />
        </section>
      )}
    </PageContainer>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          strong
            ? "font-semibold text-foreground tabular-nums"
            : "text-foreground tabular-nums"
        }
      >
        {formatCurrency(value)}
      </span>
    </div>
  );
}

function ReconciliationCard({
  checks,
  allReconciled,
}: {
  checks: ReconciliationCheck[];
  allReconciled: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Reconciliation</CardTitle>
          {allReconciled ? (
            <StatusBadge tone="success" dot={false} className="gap-1">
              <CheckCircle2 className="size-3.5" /> Balanced
            </StatusBadge>
          ) : (
            <StatusBadge tone="warning" dot={false} className="gap-1">
              <TriangleAlert className="size-3.5" /> Variances
            </StatusBadge>
          )}
        </div>
        <CardDescription>GL vs operational ledgers</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {checks.length === 0 && <p className="text-muted-foreground">No checks yet.</p>}
        {checks.map((check) => (
          <div key={check.key} className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground capitalize">
              {check.key.replace(/([A-Z])/g, " $1").trim()}
            </span>
            <span
              className={
                check.reconciled
                  ? "font-medium text-success tabular-nums"
                  : "font-medium text-warning tabular-nums"
              }
            >
              {formatCurrency(check.variance)}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Opening-balance wizard — posts one balanced `opening` entry on submit. */
function ActivationWizard() {
  const invalidate = useInvalidateFinance();
  const [accounts, setAccounts] = useState<ActivationAccount[]>(initialAccounts);
  const [inventoryValue, setInventoryValue] = useState("");
  const [receivablesTotal, setReceivablesTotal] = useState("");
  const [payablesTotal, setPayablesTotal] = useState("");
  const [ownerCapital, setOwnerCapital] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const num = (value: string) => (value.trim() === "" ? 0 : Number(value));
  const totalDebits =
    accounts.reduce((sum, a) => sum + a.openingBalance, 0) +
    num(inventoryValue) +
    num(receivablesTotal);
  const totalCredits = num(payablesTotal) + num(ownerCapital);
  const plug = Math.round((totalDebits - totalCredits) * 100) / 100;

  const submit = async () => {
    setSubmitting(true);
    try {
      await createEntityPromiseToast({
        data: null,
        apiCall: () =>
          activateFinanceApi({
            accounts: accounts.filter((a) => a.openingBalance > 0),
            inventoryValue: num(inventoryValue),
            receivablesTotal: num(receivablesTotal),
            payablesTotal: num(payablesTotal),
            ownerCapital: num(ownerCapital),
          }),
        entityName: "finance ledger",
        success: "Finance ledger activated",
        loading: "Posting opening balances…",
      });
      invalidate();
      await new Promise((r) => setTimeout(r, 150));
      void financeKeys;
    } finally {
      setSubmitting(false);
    }
  };

  const setAccount = (index: number, patch: Partial<ActivationAccount>) => {
    setAccounts((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  };

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader
        title="Activate the Finance Ledger"
        description="The double-entry ledger starts here. Enter what the business owns and owes today — one balanced opening entry is posted and every future transaction flows through the general ledger."
      />

      <Card>
        <CardHeader>
          <CardTitle>Cash, bank &amp; wallet balances</CardTitle>
          <CardDescription>Leave an account empty to skip it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {accounts.map((account, index) => (
            <div key={index} className="grid grid-cols-3 items-end gap-3">
              <div className="space-y-1">
                <Label>Account name</Label>
                <Input
                  value={account.name}
                  onChange={(e) => setAccount(index, { name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>Type</Label>
                <Select
                  value={account.type}
                  items={ACCOUNT_TYPE_OPTIONS}
                  onValueChange={(value) =>
                    setAccount(index, { type: value as ActivationAccount["type"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TYPE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Opening balance (৳)</Label>
                <Input
                  type="number"
                  min={0}
                  value={account.openingBalance || ""}
                  onChange={(e) =>
                    setAccount(index, { openingBalance: Number(e.target.value) || 0 })
                  }
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Other opening balances</CardTitle>
          <CardDescription>
            Inventory is valued at batch cost; receivables/payables mirror the due
            ledgers.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>Inventory at cost (৳)</Label>
            <Input
              type="number"
              min={0}
              value={inventoryValue}
              onChange={(e) => setInventoryValue(e.target.value)}
              placeholder="0"
            />
          </div>
          <div className="space-y-1">
            <Label>Customer receivables (৳)</Label>
            <Input
              type="number"
              min={0}
              value={receivablesTotal}
              onChange={(e) => setReceivablesTotal(e.target.value)}
              placeholder="0"
            />
          </div>
          <div className="space-y-1">
            <Label>Supplier payables (৳)</Label>
            <Input
              type="number"
              min={0}
              value={payablesTotal}
              onChange={(e) => setPayablesTotal(e.target.value)}
              placeholder="0"
            />
          </div>
          <div className="space-y-1">
            <Label>Owner capital invested to date (৳)</Label>
            <Input
              type="number"
              min={0}
              value={ownerCapital}
              onChange={(e) => setOwnerCapital(e.target.value)}
              placeholder="0"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-2 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Scale className="size-4" />
            <span className="tabular-nums">
              Debits {formatCurrency(totalDebits)} · Credits {formatCurrency(totalCredits)}
            </span>
          </div>
          <span className="text-muted-foreground">
            {plug !== 0
              ? `Retained earnings plug: ${formatCurrency(Math.abs(plug))} ${plug > 0 ? "(credit)" : "(debit)"}`
              : "Balanced exactly"}
          </span>
          {plug !== 0 && num(ownerCapital) === 0 && (
            <span className="block text-xs text-warning">
              Tip: this plug books the difference as opening equity. If that
              money is YOURS, enter it under "Owner capital invested to date"
              instead — the Finance Growth module tracks owner money there.
            </span>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={submit} disabled={submitting || plug === 0 && totalDebits === 0}>
          {submitting && <Spinner className="size-4" />}
          Activate &amp; Post Opening Entry
        </Button>
      </div>
    </PageContainer>
  );
}
