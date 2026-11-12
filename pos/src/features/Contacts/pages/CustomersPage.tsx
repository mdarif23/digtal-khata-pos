import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ContactListLayout } from "../components/ContactListLayout";
import { CustomersTable } from "../components/customers/CustomersTable";
import { ContactImportExportButtons } from "../components/ContactImportExportButtons";
import { CustomerDialog } from "../components/customers/CustomerDialog";
import { useCustomerStore } from "@/store/useCustomerStore";
import { getCustomerDueSummaryApi } from "@/api/customer.api";
import type { CustomerDue } from "@/types/customers.types";

const money = new Intl.NumberFormat("en-BD", {
  style: "currency",
  currency: "BDT",
  maximumFractionDigits: 2,
});

export function CustomersPage() {
  const [search, setSearch] = useState("");
  const [dues, setDues] = useState<CustomerDue[]>([]);
  const [dueError, setDueError] = useState("");
  const [loadingDues, setLoadingDues] = useState(true);
  const customers = useCustomerStore((state) => state.customers);
  const loading = useCustomerStore((state) => state.loading);
  const error = useCustomerStore((state) => state.error);
  const getCustomers = useCustomerStore((state) => state.getCustomers);

  const loadDues = useCallback(async () => {
    setLoadingDues(true);
    setDueError("");
    try {
      const customerDues = await getCustomerDueSummaryApi();
      setDues(
        customerDues.map((due) => ({
          ...due,
          totalAmount: Number(due.totalAmount),
          totalDue: Number(due.totalDue),
          totalPaid: Number(due.totalPaid),
        })),
      );
    } catch (loadError: unknown) {
      setDueError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setLoadingDues(false);
    }
  }, []);

  useEffect(() => {
    void loadDues();
  }, [loadDues]);

  const filteredCustomers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return customers.filter(
      (customer) =>
        !query ||
        [customer.name, customer.phone, customer.address]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(query)),
    );
  }, [customers, search]);

  const dueByCustomer = useMemo(
    () => new Map(dues.map((due) => [due.customerId, due.totalDue])),
    [dues],
  );
  const totalOutstanding = dues.reduce((total, due) => total + due.totalDue, 0);

  return (
    <ContactListLayout
      title="Customers"
      description="Manage customer contacts and keep an eye on outstanding balances."
      action={
        <div className="flex gap-2">
          <ContactImportExportButtons entity="customers" />
          <CustomerDialog />
        </div>
      }
      metrics={[
        {
          label: "Total customers",
          value: error ? "—" : loading ? "…" : String(customers.length),
          description: "Customers in your directory",
        },
        {
          label: "Customers with due",
          value: dueError ? "—" : loadingDues ? "…" : String(dues.length),
          description: "Customers with an outstanding balance",
        },
        {
          label: "Total outstanding",
          value: dueError
            ? "—"
            : loadingDues
              ? "…"
              : money.format(totalOutstanding),
          description: "Unpaid customer balances",
        },
      ]}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search customers by name, phone, or address"
      resultCount={
        error ? "—" : loading ? "…" : filteredCustomers.length
      }
    >
      {error ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-destructive">
            Could not load customers. {error}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void getCustomers().catch(() => undefined)}
          >
            Try again
          </Button>
        </div>
      ) : (
        <CustomersTable
          customers={filteredCustomers}
          dueByCustomer={dueByCustomer}
          loading={loading}
          dueStatus={dueError ? "error" : loadingDues ? "loading" : "loaded"}
        />
      )}
      {dueError ? (
        <div
          role="alert"
          className="mt-3 flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-muted-foreground">
            Outstanding balances could not be loaded. {dueError}
          </p>
          <Button variant="outline" size="sm" onClick={() => void loadDues()}>
            Retry balances
          </Button>
        </div>
      ) : null}
    </ContactListLayout>
  );
}
