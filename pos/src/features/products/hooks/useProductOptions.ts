import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient.js";
import {
  createBrandApi,
  createCategoryApi,
  createUnitApi,
  createVariantOptionApi,
  createVariantTypeApi,
  deleteBrandApi,
  deleteCategoryApi,
  deleteUnitApi,
  deleteVariantOptionApi,
  deleteVariantTypeApi,
  getProductSelectOptionsApi,
  getProductVariantOptionsApi,
  updateBrandApi,
  updateCategoryApi,
  updateUnitApi,
  updateVariantOptionApi,
  updateVariantTypeApi,
} from "../product.api.js";
import {
  productKeys,
} from "./useProducts.js";
import type {
  BrandOption,
  CategoryOption,
  UnitOption,
  VariantOptionData,
  VariantOptionGroup,
} from "../product.types.js";

/**
 * Product option groups (Phase 6 Feature 1, domain 2, second commit):
 * brands/categories/suppliers/units + variant types/options move from the
 * deleted useProductStore to TanStack Query. The CRUD actions keep the
 * store's exact contracts — same API call, same local-patch-no-refetch
 * semantics, same return values — operating on the query cache instead of
 * the Zustand array.
 */
export interface ProductSelectOptions {
  brands: BrandOption[];
  units: UnitOption[];
  categories: CategoryOption[];
  suppliers: {
    value: number;
    label: string;
  }[];
}

export function fetchProductSelectOptions(): Promise<ProductSelectOptions> {
  return getProductSelectOptionsApi();
}

export function fetchProductVariantOptions(): Promise<VariantOptionGroup[]> {
  return getProductVariantOptionsApi();
}

export function useProductSelectOptionsQuery() {
  return useQuery({
    queryKey: productKeys.selectOptions(),
    queryFn: fetchProductSelectOptions,
  });
}

export function useProductVariantOptionsQuery() {
  return useQuery({
    queryKey: productKeys.variantOptions(),
    queryFn: fetchProductVariantOptions,
  });
}

function patchSelectOptions(
  map: (options: ProductSelectOptions) => ProductSelectOptions,
): void {
  queryClient.setQueryData<ProductSelectOptions>(
    productKeys.selectOptions(),
    (current) => (current ? map(current) : current),
  );
}

function patchVariantOptions(
  map: (groups: VariantOptionGroup[]) => VariantOptionGroup[],
): void {
  queryClient.setQueryData<VariantOptionGroup[]>(
    productKeys.variantOptions(),
    (current) => (current ? map(current) : current),
  );
}

export const EMPTY_SELECT_OPTIONS: ProductSelectOptions = {
  brands: [] as BrandOption[],
  categories: [] as CategoryOption[],
  suppliers: [],
  units: [] as UnitOption[],
};

/** Read helper for non-reactive contexts (mirrors readProductsCache). */
export function readProductSelectOptions(): ProductSelectOptions {
  return (
    queryClient.getQueryData<ProductSelectOptions>(productKeys.selectOptions()) ??
    EMPTY_SELECT_OPTIONS
  );
}

/**
 * Option CRUD — same signatures/returns the old store actions had. Hooks
 * (useMutation) would add nothing here: the old semantics were always
 * "API call → local patch", which is what these do against the cache.
 */
export const productOptionActions = {
  createCategory: async (data: Parameters<typeof createCategoryApi>[0]) => {
    const response = await createCategoryApi(data);
    patchSelectOptions((o) => ({
      ...o,
      categories: [response.data.data, ...o.categories],
    }));
    return response.data;
  },
  updateCategory: async (id: number, data: Parameters<typeof updateCategoryApi>[1]) => {
    const response = await updateCategoryApi(id, data);
    patchSelectOptions((o) => ({
      ...o,
      categories: o.categories.map((category) =>
        category.value === id ? response.data.data : category,
      ),
    }));
    return response.data;
  },
  deleteCategory: async (id: number) => {
    await deleteCategoryApi(id);
    patchSelectOptions((o) => ({
      ...o,
      categories: o.categories.filter((category) => category.value !== id),
    }));
  },
  createBrand: async (data: Parameters<typeof createBrandApi>[0]) => {
    const response = await createBrandApi(data);
    patchSelectOptions((o) => ({
      ...o,
      brands: [response.data.data, ...o.brands],
    }));
    return response.data;
  },
  updateBrand: async (id: number, data: Parameters<typeof updateBrandApi>[1]) => {
    const response = await updateBrandApi(id, data);
    patchSelectOptions((o) => ({
      ...o,
      brands: o.brands.map((brand) =>
        brand.value === id ? response.data.data : brand,
      ),
    }));
    return response.data;
  },
  deleteBrand: async (id: number) => {
    await deleteBrandApi(id);
    patchSelectOptions((o) => ({
      ...o,
      brands: o.brands.filter((brand) => brand.value !== id),
    }));
  },
  createUnit: async (data: Parameters<typeof createUnitApi>[0]) => {
    const response = await createUnitApi(data);
    patchSelectOptions((o) => ({
      ...o,
      units: [response.data.data, ...o.units],
    }));
    return response.data;
  },
  updateUnit: async (id: number, data: Parameters<typeof updateUnitApi>[1]) => {
    const response = await updateUnitApi(id, data);
    patchSelectOptions((o) => ({
      ...o,
      units: o.units.map((unit) =>
        unit.value === id ? response.data.data : unit,
      ),
    }));
    return response.data;
  },
  deleteUnit: async (id: number) => {
    await deleteUnitApi(id);
    patchSelectOptions((o) => ({
      ...o,
      units: o.units.filter((unit) => unit.value !== id),
    }));
  },
  createVariantType: async (data: Parameters<typeof createVariantTypeApi>[0]) => {
    const response = await createVariantTypeApi(data);
    const newType = response.data.data as { id: number; name: string };
    patchVariantOptions((groups) => [
      ...groups,
      { typeId: newType.id, typeName: newType.name, options: [] },
    ]);
    return response.data;
  },
  updateVariantType: async (id: number, data: Parameters<typeof updateVariantTypeApi>[1]) => {
    const response = await updateVariantTypeApi(id, data);
    patchVariantOptions((groups) =>
      groups.map((group) =>
        group.typeId === id ? { ...group, typeName: data.variantTypeName } : group,
      ),
    );
    return response.data;
  },
  deleteVariantType: async (id: number) => {
    await deleteVariantTypeApi(id);
    patchVariantOptions((groups) =>
      groups.filter((group) => group.typeId !== id),
    );
  },
  createVariantOption: async (data: Parameters<typeof createVariantOptionApi>[0]) => {
    const response = await createVariantOptionApi(data);
    const newOptions: VariantOptionData[] = response.data.data;
    patchVariantOptions((groups) =>
      groups.map((group) => {
        const optionsToAdd = newOptions
          .filter((opt) => opt.variantTypeId === group.typeId)
          .map((opt) => ({ optionId: opt.id, value: opt.value }));
        if (optionsToAdd.length > 0) {
          return { ...group, options: [...group.options, ...optionsToAdd] };
        }
        return group;
      }),
    );
    return response.data;
  },
  updateVariantOption: async (id: number, value: string) => {
    const response = await updateVariantOptionApi(id, value);
    patchVariantOptions((groups) =>
      groups.map((group) => ({
        ...group,
        options: group.options.map((option) =>
          option.optionId === id ? { ...option, value } : option,
        ),
      })),
    );
    return response.data;
  },
  deleteVariantOption: async (id: number) => {
    await deleteVariantOptionApi(id);
    patchVariantOptions((groups) =>
      groups.map((group) => ({
        ...group,
        options: group.options.filter((option) => option.optionId !== id),
      })),
    );
  },
};
