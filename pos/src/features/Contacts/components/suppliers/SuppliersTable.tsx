import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Mail, MapPin, Phone } from "lucide-react";
import { useNavigate } from "react-router";
import type { Supplier } from "../../contact.type";
import { SupplierDialog } from "./SuppliersDialog";

interface SuppliersTableProps {
  suppliers: Supplier[];
  loading: boolean;
}

export function SuppliersTable({ suppliers, loading }: SuppliersTableProps) {
  const navigate = useNavigate();
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead>Supplier</TableHead>
            <TableHead>Contact</TableHead>
            <TableHead>Address</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell
                colSpan={4}
                className="h-28 text-center text-muted-foreground"
              >
                Loading suppliers…
              </TableCell>
            </TableRow>
          ) : suppliers.length ? (
            suppliers.map((supplier) => (
              <TableRow
                key={supplier.id}
                className="cursor-pointer"
                onClick={() => navigate(`/procurement/suppliers/${supplier.id}`)}
              >
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary">
                      {supplier.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="font-medium">{supplier.name}</div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="space-y-1.5">
                    {supplier.phone ? (
                      <a
                        href={`tel:${supplier.phone}`}
                        className="flex items-center gap-2 text-sm hover:text-primary"
                      >
                        <Phone className="size-3.5 text-muted-foreground" />
                        {supplier.phone}
                      </a>
                    ) : null}
                    {supplier.email ? (
                      <a
                        href={`mailto:${supplier.email}`}
                        className="flex items-center gap-2 text-sm hover:text-primary"
                      >
                        <Mail className="size-3.5 text-muted-foreground" />
                        {supplier.email}
                      </a>
                    ) : null}
                    {!supplier.phone && !supplier.email ? (
                      <span className="text-sm text-muted-foreground">
                        No contact details
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="max-w-xs whitespace-normal text-muted-foreground">
                  {supplier.address ? (
                    <span className="flex items-start gap-2">
                      <MapPin className="mt-0.5 size-3.5 shrink-0" />
                      {supplier.address}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  <div
                    className="flex items-center gap-2"
                    // The row navigates to the supplier detail page — clicks
                    // on the Edit control belong to the dialog.
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Badge
                      variant={supplier.status === "active" ? "secondary" : "outline"}
                      className={
                        supplier.status === "active"
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                          : ""
                      }
                    >
                      {supplier.status
                        ? supplier.status.charAt(0).toUpperCase() +
                          supplier.status.slice(1)
                        : "Unknown"}
                    </Badge>
                    <SupplierDialog editSupplier={supplier} />
                  </div>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell
                colSpan={4}
                className="h-28 text-center text-muted-foreground"
              >
                No suppliers match this search.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
