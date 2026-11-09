import { useEffect, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { formatCurrency, formatDate } from "@/features/reports/utils/reportUtils";
import { ReportTable, type ReportColumn } from "@/features/reports/components/ReportTable";
import {
  approvePayrollPeriodApi,
  cancelPayrollPeriodApi,
  createEmployeeApi,
  createPayrollPeriodApi,
  createSalaryStructureApi,
  giveAdvanceApi,
  reopenPayrollPeriodApi,
  updateEmployeeApi,
} from "../finance.api";
import {
  useEmployees,
  useInvalidateFinance,
  usePayrollPeriod,
  usePayrollPeriods,
} from "../hooks/useFinance";
import type { Employee, PayrollPeriod, PayrollRecord } from "../finance.types";

/**
 * Staff & Payroll: employees (with versioned salary structures), salary
 * advances, and payroll runs — calculate → approve (accrual) → pay.
 */

type PayrollTab = "employees" | "runs";

export function PayrollPage() {
  const [tab, setTab] = useState<PayrollTab>("employees");
  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
          Finance &amp; Growth
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
          Staff &amp; Payroll
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Approval posts the accrual (DR 5020 / CR 2030, advance recovery → 1060);
          payments settle the payable. An advance is an asset, never an expense.
        </p>
      </header>
      <Tabs value={tab} onValueChange={(value) => setTab(value as PayrollTab)}>
        <TabsList>
          <TabsTrigger value="employees">Employees</TabsTrigger>
          <TabsTrigger value="runs">Payroll Runs</TabsTrigger>
        </TabsList>
        <TabsContent value="employees">
          <EmployeesTab />
        </TabsContent>
        <TabsContent value="runs">
          <RunsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Employees tab
// ---------------------------------------------------------------------------

function EmployeesTab() {
  const [filters, setFilters] = useState<{ status?: string; search?: string; page: number; pageSize: number }>({
    page: 1,
    pageSize: 25,
  });
  const employees = useEmployees(filters);
  const invalidate = useInvalidateFinance();
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState<Employee | null>(null);

  const columns: ReportColumn<Employee>[] = [
    { key: "employeeCode", header: "Code", render: (row) => <span className="font-mono text-xs">{row.employeeCode}</span> },
    { key: "fullName", header: "Name", render: (row) => <span className="font-medium">{row.fullName}</span> },
    { key: "designation", header: "Designation", render: (row) => <span>{row.designation ?? "—"}</span> },
    { key: "department", header: "Department", render: (row) => <span>{row.department ?? "—"}</span> },
    {
      key: "payType",
      header: "Salary",
      render: (row) =>
        row.payType ? (
          <span>
            {row.payType} · {formatCurrency(row.basicAmount ?? "0")}
          </span>
        ) : (
          <Badge variant="outline" className="text-xs text-amber-700">
            No structure
          </Badge>
        ),
    },
    {
      key: "employmentStatus",
      header: "Status",
      render: (row) => (
        <Badge
          variant="outline"
          className={
            row.employmentStatus === "active"
              ? "text-xs text-emerald-700"
              : "text-xs text-slate-500"
          }
        >
          {row.employmentStatus}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setDetail(row);
          }}
        >
          Manage
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Employees</CardTitle>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          Add employee
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Input
            className="max-w-xs"
            placeholder="Search name, code…"
            value={filters.search ?? ""}
            onChange={(e) =>
              setFilters((prev) => ({ ...prev, search: e.target.value, page: 1 }))
            }
          />
        </div>
        <ReportTable
          columns={columns}
          data={employees.data?.rows ?? []}
          loading={employees.isLoading}
          keyExtractor={(row) => row.id}
          emptyMessage="No employees yet."
        />
        <AddEmployeeDialog open={addOpen} onOpenChange={setAddOpen} onSaved={() => invalidate()} />
        {detail && (
          <EmployeeManageDialog
            employee={detail}
            onClose={() => setDetail(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function AddEmployeeDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState("");
  const [designation, setDesignation] = useState("");
  const [department, setDepartment] = useState("");
  const [payType, setPayType] = useState<"monthly" | "daily" | "hourly">("monthly");
  const [basicAmount, setBasicAmount] = useState("");
  const [overtimeRate, setOvertimeRate] = useState("");

  const submit = async () => {
    await createEntityPromiseToast(
      () =>
        createEmployeeApi({
          fullName,
          designation: designation || null,
          department: department || null,
          salaryStructure: {
            payType,
            basicAmount: Number(basicAmount),
            allowances: [],
            overtimeRate: overtimeRate ? Number(overtimeRate) : null,
          },
        }),
      { success: `Employee "${fullName}" added`, loading: "Creating employee…" },
    );
    onSaved();
    setFullName("");
    setBasicAmount("");
    setOvertimeRate("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add employee</DialogTitle>
          <DialogDescription>
            The salary structure is versioned — creating a new one retires the old.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Full name</Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Designation</Label>
              <Input value={designation} onChange={(e) => setDesignation(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Department</Label>
              <Input value={department} onChange={(e) => setDepartment(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Pay type</Label>
              <Select value={payType} onValueChange={(v) => setPayType(v as typeof payType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>
                {payType === "monthly"
                  ? "Monthly basic (৳)"
                  : payType === "daily"
                    ? "Per-day rate (৳)"
                    : "Per-hour rate (৳)"}
              </Label>
              <Input
                type="number"
                min={0}
                value={basicAmount}
                onChange={(e) => setBasicAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Overtime rate/hour (optional)</Label>
              <Input
                type="number"
                min={0}
                value={overtimeRate}
                onChange={(e) => setOvertimeRate(e.target.value)}
                placeholder="defaults to basic-derived"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!fullName.trim() || !basicAmount}>
            Save employee
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmployeeManageDialog({
  employee: listRow,
  onClose,
}: {
  employee: Employee;
  onClose: () => void;
}) {
  const invalidate = useInvalidateFinance();
  const [employee, setEmployee] = useState(listRow);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [structureOpen, setStructureOpen] = useState(false);
  const [advances, setAdvances] = useState<
    { id: number; amount: string; outstandingAmount: string; advanceDate: string; reason: string | null }[]
  >([]);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [newBasic, setNewBasic] = useState("");
  const [newPayType, setNewPayType] = useState<"monthly" | "daily" | "hourly">("monthly");

  const loadAdvances = async () => {
    const { listAdvancesApi } = await import("../finance.api");
    setAdvances(await listAdvancesApi(listRow.id));
  };
  const openAdvance = async () => {
    setAdvanceOpen(true);
    await loadAdvances();
  };

  const setStatus = async (status: "active" | "inactive" | "terminated") => {
    await createEntityPromiseToast(
      () => updateEmployeeApi(employee.id, { employmentStatus: status }),
      { success: "Employee updated", loading: "Updating…" },
    );
    setEmployee((prev) => ({ ...prev, employmentStatus: status }));
    invalidate();
  };

  const giveAdvance = async () => {
    await createEntityPromiseToast(
      () => giveAdvanceApi({ employeeId: employee.id, amount: Number(amount), reason: reason || null }),
      { success: "Advance recorded (asset)", loading: "Posting advance…" },
    );
    invalidate();
    setAmount("");
    await loadAdvances();
  };

  const saveStructure = async () => {
    await createEntityPromiseToast(
      () =>
        createSalaryStructureApi(employee.id, {
          payType: newPayType,
          basicAmount: Number(newBasic),
          allowances: [],
        }),
      { success: "New salary structure active", loading: "Saving…" },
    );
    invalidate();
    setStructureOpen(false);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {employee.fullName}{" "}
            <span className="font-mono text-xs text-slate-400">{employee.employeeCode}</span>
          </DialogTitle>
          <DialogDescription>
            Status: {employee.employmentStatus} ·{" "}
            {employee.payType ? `${employee.payType} ${formatCurrency(employee.basicAmount ?? "0")}` : "no structure"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setStatus("active")}>
              Set active
            </Button>
            <Button variant="outline" size="sm" onClick={() => setStatus("inactive")}>
              Set inactive
            </Button>
            <Button variant="outline" size="sm" onClick={() => setStatus("terminated")}>
              Terminate
            </Button>
            <Button variant="outline" size="sm" onClick={() => setStructureOpen(true)}>
              New salary structure
            </Button>
            <Button variant="outline" size="sm" onClick={openAdvance}>
              Advances
            </Button>
          </div>
          {structureOpen && (
            <div className="space-y-2 rounded-xl border border-slate-200 p-3">
              <p className="text-sm font-medium">New salary structure</p>
              <div className="grid grid-cols-3 gap-2">
                <Select value={newPayType} onValueChange={(v) => setNewPayType(v as typeof newPayType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="hourly">Hourly</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min={0}
                  placeholder="Basic ৳"
                  value={newBasic}
                  onChange={(e) => setNewBasic(e.target.value)}
                />
                <Button onClick={saveStructure} disabled={!newBasic}>
                  Save
                </Button>
              </div>
            </div>
          )}
          {advanceOpen && (
            <div className="space-y-2 rounded-xl border border-slate-200 p-3">
              <p className="text-sm font-medium">Salary advances (asset — recovered from pay)</p>
              {advances.map((advance) => (
                <div key={advance.id} className="flex items-center justify-between text-xs">
                  <span>
                    {formatDate(advance.advanceDate)} · {advance.reason ?? "Advance"}
                  </span>
                  <span>
                    Outstanding <strong>{formatCurrency(advance.outstandingAmount)}</strong>
                  </span>
                </div>
              ))}
              {advances.length === 0 && <p className="text-xs text-slate-400">No advances.</p>}
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <Label>Amount ৳</Label>
                  <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Reason</Label>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
                <Button onClick={giveAdvance} disabled={!amount}>
                  Give
                </Button>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Runs tab
// ---------------------------------------------------------------------------

function RunsTab() {
  const periods = usePayrollPeriods();
  const invalidate = useInvalidateFinance();
  const [runOpen, setRunOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const detail = usePayrollPeriod(selectedId);

  const run = async (periodStart: string, employeeIds: number[]) => {
    await createEntityPromiseToast(
      () => createPayrollPeriodApi({ periodStart, employeeIds }),
      { success: "Payroll draft created", loading: "Calculating…" },
    );
    invalidate();
    setRunOpen(false);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardHeader className="flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">Payroll periods</CardTitle>
          <Button size="sm" onClick={() => setRunOpen(true)}>
            Run payroll
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {(periods.data ?? []).map((period) => (
            <button
              key={period.id}
              onClick={() => setSelectedId(period.id)}
              className={`w-full rounded-xl border px-3 py-2.5 text-left text-sm ${
                selectedId === period.id
                  ? "border-slate-900 bg-slate-50"
                  : "border-slate-200 hover:bg-slate-50"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{period.periodStart.slice(0, 7)}</span>
                <StatusBadge status={period.status} />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Gross {formatCurrency(period.grossTotal)} · Net{" "}
                {formatCurrency(period.netTotal)}
              </p>
            </button>
          ))}
          {periods.data?.length === 0 && (
            <p className="py-4 text-center text-sm text-slate-400">
              No payroll runs yet.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <PeriodDetail
          period={detail.data}
          onChanged={() => {
            invalidate();
          }}
        />
      </Card>

      <RunPayrollDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        onRun={run}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "paid"
      ? "text-emerald-700"
      : status === "approved"
        ? "text-sky-700"
        : status === "partial"
          ? "text-amber-700"
          : status === "cancelled"
            ? "text-rose-700"
            : "text-slate-500";
  return (
    <Badge variant="outline" className={`text-xs ${tone}`}>
      {status}
    </Badge>
  );
}

function PeriodDetail({
  period,
  onChanged,
}: {
  period: PayrollPeriod | undefined;
  onChanged: () => void;
}) {
  const [payslipId, setPayslipId] = useState<number | null>(null);
  if (!period) {
    return (
      <CardContent className="py-16 text-center text-sm text-slate-400">
        Select a payroll period to view its records.
      </CardContent>
    );
  }
  const isDraft = period.status === "draft";
  const canPay = period.status === "approved" || period.status === "partial" || period.status === "paid";

  const approve = async () => {
    await createEntityPromiseToast(() => approvePayrollPeriodApi(period.id), {
      success: "Payroll approved — accrual posted",
      loading: "Posting accrual…",
    });
    onChanged();
  };
  const cancel = async () => {
    await createEntityPromiseToast(() => cancelPayrollPeriodApi(period.id, "Cancelled"), {
      success: "Payroll cancelled — accrual reversed",
      loading: "Reversing…",
    });
    onChanged();
  };
  const reopen = async () => {
    await createEntityPromiseToast(() => reopenPayrollPeriodApi(period.id), {
      success: "Payroll reopened as draft",
      loading: "Reopening…",
    });
    onChanged();
  };

  const columns: ReportColumn<PayrollRecord>[] = [
    { key: "employeeName", header: "Employee", render: (row) => <span className="font-medium">{row.employeeName}</span> },
    { key: "grossAmount", header: "Gross", render: (row) => formatCurrency(row.grossAmount) },
    { key: "advanceDeduction", header: "Advance", render: (row) => formatCurrency(row.advanceDeduction) },
    { key: "netAmount", header: "Net", render: (row) => <strong>{formatCurrency(row.netAmount)}</strong> },
    { key: "paidAmount", header: "Paid", render: (row) => formatCurrency(row.paidAmount ?? "0") },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <div className="flex gap-1">
          {canPay && (
            <PayButton record={row} onDone={onChanged} />
          )}
          <Button variant="outline" size="sm" onClick={() => setPayslipId(row.id)}>
            Payslip
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <CardHeader className="flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-base">
            {period.periodStart.slice(0, 7)} <StatusBadge status={period.status} />
          </CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            Gross {formatCurrency(period.grossTotal)} · Net{" "}
            {formatCurrency(period.netTotal)} · Advance recovery{" "}
            {formatCurrency(period.advanceRecoveryTotal)}
          </p>
        </div>
        <div className="flex gap-2">
          {isDraft && (
            <Button size="sm" onClick={approve}>
              Approve &amp; post accrual
            </Button>
          )}
          {(period.status === "approved") && (
            <Button variant="outline" size="sm" onClick={cancel}>
              Cancel
            </Button>
          )}
          {period.status === "cancelled" && (
            <Button variant="outline" size="sm" onClick={reopen}>
              Reopen
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <ReportTable
          columns={columns}
          data={period.records ?? []}
          keyExtractor={(row) => row.id}
          emptyMessage="No records in this period."
        />
      </CardContent>
      {payslipId != null && (
        <PayslipDialog recordId={payslipId} onClose={() => setPayslipId(null)} />
      )}
    </div>
  );
}

function PayButton({ record, onDone }: { record: PayrollRecord; onDone: () => void }) {
  const paid = Number(record.paidAmount ?? 0);
  const net = Number(record.netAmount);
  const remaining = Math.round((net - paid) * 100) / 100;
  const [amount, setAmount] = useState(remaining > 0 ? String(remaining) : "");
  const pay = async () => {
    const { recordSalaryPaymentApi } = await import("../finance.api");
    await createEntityPromiseToast(
      () =>
        recordSalaryPaymentApi(record.id, {
          amount: Number(amount),
          method: "cash",
        }),
      { success: "Salary payment recorded", loading: "Posting payment…" },
    );
    onDone();
  };
  if (remaining <= 0.005) {
    return <Badge variant="outline" className="text-xs text-emerald-700">Paid</Badge>;
  }
  return (
    <div className="flex items-center gap-1">
      <Input
        className="h-8 w-24 text-xs"
        type="number"
        min={0}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <Button size="sm" variant="outline" onClick={pay} disabled={!amount}>
        Pay
      </Button>
    </div>
  );
}

function RunPayrollDialog({
  open,
  onOpenChange,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: (periodStart: string, employeeIds: number[]) => Promise<void>;
}) {
  const employees = useEmployees({ status: "active", page: 1, pageSize: 100 });
  const [periodStart, setPeriodStart] = useState(
    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`,
  );
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Run payroll</DialogTitle>
          <DialogDescription>
            Pick a month and the employees to include — attendance-derived days
            are used when available; adjust records before approving.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Month (first day)</Label>
            <Input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-2">
            {(employees.data?.rows ?? []).map((employee) => (
              <label
                key={employee.id}
                className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.has(employee.id)}
                    onChange={() => toggle(employee.id)}
                  />
                  {employee.fullName}
                </span>
                <span className="text-xs text-slate-500">
                  {employee.payType ?? "no structure"}
                </span>
              </label>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0}
            onClick={async () => {
              await onRun(periodStart, [...selected]);
              onOpenChange(false);
            }}
          >
            Calculate draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowLine({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-0.5 ${strong ? "font-semibold" : ""}`}>
      <span className="text-slate-500">{label}</span>
      <span className={strong ? "text-slate-950" : "text-slate-800"}>{formatCurrency(value)}</span>
    </div>
  );
}

function PayslipDialog({ recordId, onClose }: { recordId: number; onClose: () => void }) {
  const [payslip, setPayslip] = useState<Awaited<ReturnType<typeof import("../finance.api").getPayslipApi>> | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { getPayslipApi } = await import("../finance.api");
      const data = await getPayslipApi(recordId);
      if (!cancelled) {
        setPayslip(data);
        setLoaded(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [recordId]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Payslip</DialogTitle>
          <DialogDescription>Printable — use the browser print dialog.</DialogDescription>
        </DialogHeader>
        {!loaded || !payslip ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-6" />
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-semibold">{payslip.employee.fullName}</span>
              <Badge variant="outline" className="text-xs">
                {payslip.paymentStatus}
              </Badge>
            </div>
            <p className="text-xs text-slate-500">
              {payslip.employee.employeeCode} ·{" "}
              {payslip.period.periodStart.slice(0, 7)} ·{" "}
              {payslip.earnings.workedDays} days worked · {payslip.earnings.overtimeHours}h OT
            </p>
            <div className="rounded-xl border border-slate-200 p-3">
              <RowLine label="Basic" value={payslip.earnings.basicAmount} />
              <RowLine label="Allowances" value={payslip.earnings.allowancesTotal} />
              <RowLine label="Overtime" value={payslip.earnings.overtimeAmount} />
              <RowLine label="Bonus" value={payslip.earnings.bonusAmount} />
              <RowLine label="Commission" value={payslip.earnings.commissionAmount} />
              <div className="border-t pt-1">
                <RowLine label="Gross" value={payslip.earnings.grossAmount} strong />
              </div>
              <RowLine label="Other deductions" value={payslip.deductions.otherDeductions} />
              <RowLine label="Advance recovery" value={payslip.deductions.advanceDeduction} />
              <div className="border-t pt-1">
                <RowLine label="Net payable" value={payslip.netAmount} strong />
              </div>
              <RowLine label="Paid" value={payslip.paidAmount} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => window.print()}>Print</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
