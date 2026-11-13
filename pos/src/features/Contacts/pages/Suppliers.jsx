import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SupplierDialog } from "../components/suppliers/SuppliersDialog";
import { SuppliersTable } from "../components/suppliers/SuppliersTable";
import { ContactListLayout } from "../components/ContactListLayout";
import { ContactImportExportButtons } from "../components/ContactImportExportButtons";
import { useContactStore } from "../useContactStore";

export function Suppliers() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const suppliers = useContactStore((state) => state.suppliers);
  const loading = useContactStore((state) => state.loading);
  const error = useContactStore((state) => state.error);
  const getSuppliers = useContactStore((state) => state.getSuppliers);

  useEffect(() => {
    void getSuppliers().catch(() => undefined);
  }, [getSuppliers]);

  const filteredSuppliers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return suppliers.filter((supplier) => {
      const matchesSearch =
        !query ||
        [supplier.name, supplier.phone, supplier.email, supplier.address]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));
      const matchesStatus = status === "all" || supplier.status === status;
      return matchesSearch && matchesStatus;
    });
  }, [search, status, suppliers]);
  const activeCount = suppliers.filter(
    (supplier) => supplier.status === "active",
  ).length;

  return (
    <ContactListLayout
      title="Suppliers"
      description="Keep supplier details organized and ready for your next purchase."
      action={
        <div className="flex gap-2">
          <ContactImportExportButtons entity="suppliers" />
          <SupplierDialog />
        </div>
      }
      metrics={[
        {
          label: "Total suppliers",
          value: error ? "—" : loading ? "…" : String(suppliers.length),
          description: "Supplier contacts in your directory",
        },
        {
          label: "Active suppliers",
          value: error ? "—" : loading ? "…" : String(activeCount),
          description: "Available for purchasing",
        },
        {
          label: "Inactive suppliers",
          value: error
            ? "—"
            : loading
              ? "…"
              : String(
                  suppliers.filter(
                    (supplier) => supplier.status === "inactive",
                  ).length,
                ),
          description: "Not currently active",
        },
      ]}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search suppliers by name, phone, or email"
      resultCount={
        error ? "—" : loading ? "…" : filteredSuppliers.length
      }
      filter={
        <Select value={status} onValueChange={(value) => value && setStatus(value)}>
          <SelectTrigger aria-label="Filter suppliers by status" className="w-full sm:w-40">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
      }
    >
      {error ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-destructive">
            Could not load suppliers. {error}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void getSuppliers().catch(() => undefined)}
          >
            Try again
          </Button>
        </div>
      ) : (
        <SuppliersTable suppliers={filteredSuppliers} loading={loading} />
      )}
    </ContactListLayout>
  );
}
