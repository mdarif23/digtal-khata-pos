import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pencil, Trash2 } from "lucide-react";
import { productOptionActions } from "../../hooks/useProductOptions.js";
import { BrandsDialog } from "./BrandsDialog";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { useState } from "react";
import type { BrandOption } from "../../product.types";

export function BrandsTable({ brands }: { brands: BrandOption[] }) {
  const { deleteBrand } = productOptionActions;
  const [brandToDelete, setBrandToDelete] = useState<BrandOption | null>(null);

  return (
    <>
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-[28%]">Brand</TableHead>
              <TableHead className="w-[22%]">Products</TableHead>
              <TableHead className="w-[22%]">Status</TableHead>
              <TableHead className="w-[28%] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {brands.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-28 text-center text-muted-foreground"
                >
                  No brands match your current filters.
                </TableCell>
              </TableRow>
            ) : (
              brands.map((brand) => (
                <TableRow key={brand.value}>
                  <TableCell>
                    <div className="font-semibold text-foreground">{brand.label}</div>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground">{brand.productCount}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={brand.status === "active" ? "default" : "secondary"}>
                      {brand.status === "active" ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <BrandsDialog brand={brand} />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${brand.label}`}
                        onClick={() => setBrandToDelete(brand)}
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
        open={Boolean(brandToDelete)}
        onOpenChange={(open) => !open && setBrandToDelete(null)}
        title="Delete brand"
        entityName="Brand"
        description={
          brandToDelete
            ? `This will remove “${brandToDelete.label}” from your catalog. This action cannot be undone.`
            : "Delete this brand?"
        }
        onConfirm={async () => {
          if (!brandToDelete) return;
          await deleteBrand(brandToDelete.value);
          setBrandToDelete(null);
        }}
      />
    </>
  );
}
