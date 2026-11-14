import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CustomerDialog } from "@/features/Contacts/components/customers/CustomerDialog";
import { MapPin, Phone } from "lucide-react";
import type { InputValue } from "@/types/customers.types";

interface CustomersTableProps {
  customers: InputValue[];
  dueByCustomer: Map<number, number>;
  loading: boolean;
  dueStatus: "loading" | "error" | "loaded";
}

const money = new Intl.NumberFormat("en-BD", {
  style: "currency",
  currency: "BDT",
  maximumFractionDigits: 2,
});

export function CustomersTable({
  customers,
  dueByCustomer,
  loading,
  dueStatus,
}: CustomersTableProps) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead>Customer</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Address</TableHead>
            <TableHead className="text-right">Outstanding balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell
                colSpan={4}
                className="h-28 text-center text-muted-foreground"
              >
                Loading customers…
              </TableCell>
            </TableRow>
          ) : customers.length ? (
            customers.map((customer) => {
              const due = dueByCustomer.get(customer.id) ?? 0;
              return (
                <TableRow key={customer.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary">
                        {customer.name.slice(0, 1).toUpperCase()}
                      </div>
                      <span className="font-medium">{customer.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {customer.phone ? (
                      <a
                        href={`tel:${customer.phone}`}
                        className="flex items-center gap-2 text-sm hover:text-primary"
                      >
                        <Phone className="size-3.5 text-muted-foreground" />
                        {customer.phone}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs whitespace-normal text-muted-foreground">
                    {customer.address ? (
                      <span className="flex items-start gap-2">
                        <MapPin className="mt-0.5 size-3.5 shrink-0" />
                        {customer.address}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {dueStatus === "loading" ? (
                        <span className="text-sm text-muted-foreground">
                          Loading…
                        </span>
                      ) : dueStatus === "error" ? (
                        <span className="text-sm text-muted-foreground">
                          Unavailable
                        </span>
                      ) : due > 0 ? (
                        <Badge
                          variant="secondary"
                          className="bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        >
                          {money.format(due)}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">No due</span>
                      )}
                      {/* E1-004: correct the customer's contact details. */}
                      <CustomerDialog
                        editCustomer={{
                          id: customer.id,
                          name: customer.name,
                          phone: customer.phone ?? "",
                          address: customer.address ?? "",
                        }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          ) : (
            <TableRow>
              <TableCell
                colSpan={4}
                className="h-28 text-center text-muted-foreground"
              >
                No customers match this search.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
