import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Pencil, Trash2 } from "lucide-react";
import { productOptionActions } from "../../hooks/useProductOptions.js";
import { UnitsDialog } from "./UnitsDialog";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { useState } from "react";
import type { UnitOption } from "../../product.types";

export function UnitsTable({ units }: { units: UnitOption[] }) {
  const { deleteUnit } = productOptionActions;
  const [unitToDelete, setUnitToDelete] = useState<UnitOption | null>(null);

  return (
    <>
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-[30%]">Unit</TableHead>
              <TableHead className="w-[20%]">Abbreviation</TableHead>
              <TableHead className="w-[20%]">Products</TableHead>
              <TableHead className="w-[30%] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {units.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-28 text-center text-muted-foreground"
                >
                  No units match your current filters.
                </TableCell>
              </TableRow>
            ) : (
              units.map((unit) => (
                <TableRow key={unit.value}>
                  <TableCell>
                    <div className="font-semibold text-foreground">{unit.label}</div>
                  </TableCell>
                  <TableCell>
                    <span className="rounded-md bg-muted px-2 py-1 text-xs font-semibold tracking-wide text-muted-foreground">
                      {unit.abbreviation}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground">{unit.productCount}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <UnitsDialog unit={unit} />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${unit.label}`}
                        onClick={() => setUnitToDelete(unit)}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <ConfirmDeleteDialog
        open={Boolean(unitToDelete)}
        onOpenChange={(open) => !open && setUnitToDelete(null)}
        title="Delete unit"
        entityName="Unit"
        description={
          unitToDelete
            ? `This will remove “${unitToDelete.label}” and may affect products using it.`
            : "Delete this unit?"
        }
        onConfirm={async () => {
          if (!unitToDelete) return;
          await deleteUnit(unitToDelete.value);
          setUnitToDelete(null);
        }}
      />
    </>
  );
}
