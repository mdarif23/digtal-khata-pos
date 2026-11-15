import { useMemo, useState } from "react";
import { EntityListLayout } from "@/components/common/EntityListLayout";
import { UnitsDialog } from "../components/Units/UnitsDialog";
import { UnitsTable } from "../components/Units/UnitsTable";
import { EMPTY_SELECT_OPTIONS, useProductSelectOptionsQuery } from "../hooks/useProductOptions.js";

export function Units() {
  const productSelectOptions = useProductSelectOptionsQuery().data ?? EMPTY_SELECT_OPTIONS;
  const [searchValue, setSearchValue] = useState("");

  const filteredUnits = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    return productSelectOptions.units.filter((unit) => {
      if (!query) return true;
      return (
        unit.label.toLowerCase().includes(query) ||
        unit.abbreviation.toLowerCase().includes(query)
      );
    });
  }, [productSelectOptions.units, searchValue]);

  return (
    <EntityListLayout
      title="Units"
      description="Manage measurement units used by your products."
      action={<UnitsDialog />}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      resultCount={filteredUnits.length}
    >
      <UnitsTable units={filteredUnits} />
    </EntityListLayout>
  );
}
