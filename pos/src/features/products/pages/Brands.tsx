import { useMemo, useState } from "react";
import { BrandsTable } from "../components/Brands/BrandsTable";
import { BrandsDialog } from "../components/Brands/BrandsDialog";
import { EntityListLayout } from "@/components/common/EntityListLayout";
import { EMPTY_SELECT_OPTIONS, useProductSelectOptionsQuery } from "../hooks/useProductOptions.js";

export function Brands() {
  const productSelectOptions = useProductSelectOptionsQuery().data ?? EMPTY_SELECT_OPTIONS;
  const [searchValue, setSearchValue] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">(
    "all",
  );

  const filteredBrands = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    return productSelectOptions.brands.filter((brand) => {
      const matchesSearch =
        query.length === 0 || brand.label.toLowerCase().includes(query);
      const matchesStatus =
        statusFilter === "all" || brand.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [productSelectOptions.brands, searchValue, statusFilter]);

  return (
    <EntityListLayout
      title="Brands"
      description="Manage brands used by your products."
      action={<BrandsDialog />}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      resultCount={filteredBrands.length}
      statusFilter={statusFilter}
      onStatusFilterChange={setStatusFilter}
    >
      <BrandsTable brands={filteredBrands} />
    </EntityListLayout>
  );
}
