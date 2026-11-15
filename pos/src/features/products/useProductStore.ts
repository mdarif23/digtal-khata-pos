import {
  ProductStoreType,
  ProductType,
  VariantOptionData,
  VariantTypeData,
} from "@/features/products/product.types";
import { create } from "zustand";
import {
  createBrandApi,
  createCategoryApi,
  createProductApi,
  createUnitApi,
  createVariantOptionApi,
  createVariantTypeApi,
  updateProductApi,
  getProductSelectOptionsApi,
  getProductVariantOptionsApi,
  adjustVariantStockApi,
  deleteBrandApi,
  deleteCategoryApi,
  deleteUnitApi,
  deleteVariantOptionApi,
  deleteVariantTypeApi,
  updateBrandApi,
  updateCategoryApi,
  updateUnitApi,
  updateVariantOptionApi,
  updateVariantTypeApi,
} from "./product.api";
import { queryClient } from "@/lib/queryClient.js";
import {
  productKeys,
  type ProductsCache,
} from "@/features/products/hooks/useProducts.js";

/**
 * The product catalog LIST moved to TanStack Query (useProductsQuery) in
 * Phase 6 Feature 1 — useProducts.fetchProductsWithOfflineCache owns the
 * IndexedDB cache contract. This store keeps the option groups
 * (brands/categories/suppliers/units, variant types/options) and the
 * stock-mutating actions, which now patch the catalog query cache with the
 * same in-place math (same clamping, same local-patch-no-refetch semantics).
 */
function patchCatalogCache(map: (rows: ProductType[]) => ProductType[]): void {
  queryClient.setQueryData<ProductsCache>(productKeys.catalog(), (current) =>
    current ? { ...current, data: map(current.data) } : current,
  );
}

const useProductStore = create<ProductStoreType>((set) => ({
  productSelectOptions: {
    brands: [],
    categories: [],
    suppliers: [],
    units: [],
  },
  productVariantOptions: [],
  // P2: per-variant stock adjustments for POS carting — these hit the SAME
  // catalog the product grid reads (fixes the legacy store-drift bug where
  // carting mutated a catalog the grid never saw). Clamped at 0 to match
  // backend behavior (FIFO sales can never drive stock negative).
  returnVariantStock: (variantId, quantity) =>
    patchCatalogCache((rows) =>
      rows.map((product) => ({
        ...product,
        variants: product.variants.map((variant) =>
          variant.id === variantId
            ? { ...variant, quantity: variant.quantity + quantity }
            : variant,
        ),
      })),
    ),
  takeVariantStock: (variantId, quantity) =>
    patchCatalogCache((rows) =>
      rows.map((product) => ({
        ...product,
        variants: product.variants.map((variant) =>
          variant.id === variantId
            ? {
                ...variant,
                quantity: Math.max(0, variant.quantity - quantity),
              }
            : variant,
        ),
      })),
    ),
  adjustVariantStock: async (variantId, data) => {
    const result = await adjustVariantStockApi(variantId, data);
    patchCatalogCache((rows) =>
      rows.map((product) => ({
        ...product,
        variants: product.variants.map((variant) =>
          variant.id === variantId
            ? { ...variant, quantity: result.quantity }
            : variant,
        ),
      })),
    );
    return result;
  },
  getProductSelectOptions: async () => {
    const data = await getProductSelectOptionsApi();
    set({ productSelectOptions: data });
  },
  getProductVariantOptions: async () => {
    const data = await getProductVariantOptionsApi();
    set({ productVariantOptions: data });
  },
  createProduct: async (data) => {
    const response = await createProductApi(data);
    // The POST returns only { productId } — refresh the catalog so the new
    // product is visible immediately (P3: create-cache synchronization).
    await queryClient.invalidateQueries({ queryKey: productKeys.catalog() });
    return response.data;
  },
  updateProduct: async (id, data) => {
    const result = await updateProductApi(id, data);
    const newVariants = data.variants.filter(
      (variant) => variant.id === undefined,
    );
    if (newVariants.length !== result.addedVariants.length) {
      throw new Error(
        "Product was updated, but the server returned an unexpected number of new variants. Refresh the product list.",
      );
    }

    patchCatalogCache((rows) =>
      rows.map((product) => {
        if (product.id !== id) {
          return product;
        }

        return {
          ...product,
          name: data.name,
          categoryId: data.categoryId,
          brandId: data.brandId,
          unitId: data.unitId,
          description: data.description,
          productType: data.productType,
          hasVariants: data.hasVariants,
          trackingType: data.trackingType,
          status: data.status,
          variants: [
            ...product.variants.map((variant) => {
              const updatedVariant = data.variants.find(
                (item) => item.id === variant.id,
              );
              if (!updatedVariant) return variant;

              return {
                ...variant,
                sku: updatedVariant.sku,
                barcode: updatedVariant.barcode,
                sellingPrice: updatedVariant.sellingPrice,
                alertQuantity: updatedVariant.alertQuantity,
                isDefault: updatedVariant.isDefault,
                status: updatedVariant.status,
                options: updatedVariant.options,
              };
            }),
            ...newVariants.map((variant, index) => {
              const created = result.addedVariants[index];
              if (!created) {
                throw new Error(
                  "Product was updated, but a new variant ID was not returned.",
                );
              }
              return {
                ...variant,
                id: created.id,
                sku: created.sku,
                purchaseCost: variant.purchasePrice,
                quantity: 0,
              };
            }),
          ],
        };
      }),
    );
  },
  createCategory: async (data) => {
    const response = await createCategoryApi(data);
    set((state) => ({
      productSelectOptions: {
        ...state.productSelectOptions,
        categories: [
          response.data.data,
          ...state.productSelectOptions.categories,
        ],
      },
    }));
    return response.data;
  },
  updateCategory: async (id, data) => {
    const response = await updateCategoryApi(id, data);
    set((state) => ({
      productSelectOptions: {
        ...state.productSelectOptions,
        categories: state.productSelectOptions.categories.map((category) =>
          category.value === id ? response.data.data : category,
        ),
      },
    }));
    return response.data;
  },
  deleteCategory: async (id) => {
    await deleteCategoryApi(id);
    set((state) => ({
      productSelectOptions: {
        ...state.productSelectOptions,
        categories: state.productSelectOptions.categories.filter(
          (category) => category.value !== id,
        ),
      },
    }));
  },
  createBrand: async (data) => {
    const response = await createBrandApi(data);
    set((state) => ({
      productSelectOptions: {
        ...state.productSelectOptions,
        brands: [response.data.data, ...state.productSelectOptions.brands],
      },
    }));
    return response.data;
  },
  updateBrand: async (id, data) => {
    const response = await updateBrandApi(id, data);
    set((state) => ({
      productSelectOptions: {
        ...state.productSelectOptions,
        brands: state.productSelectOptions.brands.map((brand) =>
          brand.value === id ? response.data.data : brand,
        ),
      },
    }));
    return response.data;
  },
  deleteBrand: async (id) => {
    await deleteBrandApi(id);
    set((state) => ({
      productSelectOptions: {
        ...state.productSelectOptions,
        brands: state.productSelectOptions.brands.filter(
          (brand) => brand.value !== id,
        ),
      },
    }));
  },
  createUnit: async (data) => {
    const response = await createUnitApi(data);
    set((state) => ({
      productSelectOptions: {
        ...state.productSelectOptions,
        units: [response.data.data, ...state.productSelectOptions.units],
      },
    }));
    return response.data;
  },
  updateUnit: async (id, data) => {
    const response = await updateUnitApi(id, data);
    set((state) => ({
      productSelectOptions: {
        ...state.productSelectOptions,
        units: state.productSelectOptions.units.map((unit) =>
          unit.value === id ? response.data.data : unit,
        ),
      },
    }));
    return response.data;
  },
  deleteUnit: async (id) => {
    await deleteUnitApi(id);
    set((state) => ({
      productSelectOptions: {
        ...state.productSelectOptions,
        units: state.productSelectOptions.units.filter(
          (unit) => unit.value !== id,
        ),
      },
    }));
  },
  createVariantType: async (data) => {
    const response = await createVariantTypeApi(data);
    const newType: VariantTypeData = response.data.data;
    const typeToAdd = {
      typeId: newType.id,
      typeName: newType.name,
      options: [],
    };
    set((state) => ({
      productVariantOptions: [...state.productVariantOptions, typeToAdd],
    }));
    return response.data;
  },
  updateVariantType: async (id, data) => {
    const response = await updateVariantTypeApi(id, data);
    set((state) => ({
      productVariantOptions: state.productVariantOptions.map((group) =>
        group.typeId === id ? { ...group, typeName: data.variantTypeName } : group,
      ),
    }));
    return response.data;
  },
  deleteVariantType: async (id) => {
    await deleteVariantTypeApi(id);
    set((state) => ({
      productVariantOptions: state.productVariantOptions.filter(
        (group) => group.typeId !== id,
      ),
    }));
  },
  createVariantOption: async (data) => {
    const response = await createVariantOptionApi(data);
    const newOptions = response.data.data;

    set((state) => ({
      ...state,
      productVariantOptions: state.productVariantOptions.map((group) => {
        const optionsToAdd = newOptions
          .filter(
            (opt: VariantOptionData) => opt.variantTypeId === group.typeId,
          )
          .map((opt: VariantOptionData) => ({
            optionId: opt.id,
            value: opt.value,
          }));
        if (optionsToAdd.length > 0) {
          return {
            ...group,
            options: [...group.options, ...optionsToAdd],
          };
        }
        return group;
      }),
    }));

    return response.data;
  },
  updateVariantOption: async (id, value) => {
    const response = await updateVariantOptionApi(id, value);
    set((state) => ({
      productVariantOptions: state.productVariantOptions.map((group) => ({
        ...group,
        options: group.options.map((option) =>
          option.optionId === id ? { ...option, value } : option,
        ),
      })),
    }));
    return response.data;
  },
  deleteVariantOption: async (id) => {
    await deleteVariantOptionApi(id);
    set((state) => ({
      productVariantOptions: state.productVariantOptions.map((group) => ({
        ...group,
        options: group.options.filter((option) => option.optionId !== id),
      })),
    }));
  },
}));
export default useProductStore;
