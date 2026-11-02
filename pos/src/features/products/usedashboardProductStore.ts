import { Network } from "lucide-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import axios from "../../api/axios.js";
import { EditingProductsStore, ProductsStore } from "./products.types.js";
import { createProductApi, deleteProductByIdApi, duplicateProductApi, getProductsApi, updateProductByIdApi, updateStockByIdApi } from "./products.api.js";
export const useEditProductStore = create<EditingProductsStore>((set) => ({
  editingProduct: null,
  setEditingProduct: (product) => set({ editingProduct: product }),
}));
export const useProductStore = create<ProductsStore>((set) => ({
  products: [],
  loading: false,
  error: null,
  getProducts: async () => {
    set({ loading: true });
    try {
      // Offline POS: on a network failure the IndexedDB catalog cache
      // (populated on every successful load) keeps the register working —
      // clearly flagged as offline data via useOfflineStore.offlineMode.
      const { loadProductsWithCache } = await import(
        "../pos/offline/catalog.js"
      );
      const { data: productsData } = await loadProductsWithCache(getProductsApi);
      set({ products: productsData, loading: false });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      set({ error: errorMessage, loading: false });
    }
  },
  removeProductQuantity: (id) =>
    set((state) => ({
      products: state.products.map((product) =>
        product.id === id
          ? {
              ...product,
              quantity: product.quantity - 1,
            }
          : product,
      ),
    })),
  removeProductQuantityToCart: (id) =>
    set((state) => ({
      products: state.products.map((p) =>
        p.id === id ? { ...p, quantity: p.quantity - 1 } : p,
      ),
    })),
  addProductQuantityToCart: (id) =>
    set((state) => ({
      products: state.products.map((p) =>
        p.id === id ? { ...p, quantity: p.quantity + 1 } : p,
      ),
    })),
  restoreSingleProductQuantityToCart: (id, soldQuantity) =>
    set((state) => ({
      products: state.products.map((p) => {
        if (p.id === id) {
          return {
            ...p,
            quantity: p.quantity + soldQuantity,
          };
        }
        return p;
      }),
    })),
  addCustomProductQuantityToCart: (id, customQuantity, soldQuantity) =>
    set((state) => ({
      products: state.products.map((p) =>
        p.id === id
          ? { ...p, quantity: p.quantity - (customQuantity - soldQuantity) }
          : p,
      ),
    })),
  restoreAllProductQuantityToCart: (id, soldQuantity) =>
    set((state) => ({
      products: state.products.map((p) =>
        p.id === id ? { ...p, quantity: p.quantity + soldQuantity } : p,
      ),
    })),
  updateStock: async (id, newStock) => {
    try {
      set((state) => {
        const findProduct = state.products.find((p) => p.id === id);
        if (!findProduct) {
          return state;
        }
        const status =
          newStock === 0
            ? "Out of Stock"
            : newStock <= findProduct.alertQuantity
              ? "Low-Stock"
              : "In-Stock";

        updateStockByIdApi(id, newStock, status);
        return {
          products: state.products.map((p) => {
            if (p.id === id) {
              return {
                ...p,
                quantity: newStock,
                status: status,
              };
            }
            return p;
          }),
        };
      });
    } catch (err) {
      console.error(err);
    }
  },
  addToProduct: async (product) => {
    try {
      createProductApi(product);
      set((state) => ({
        products: [...state.products, product],
      }));
    } catch (err) {
      console.log(err);
    }
  },
  removeProduct: async (id) => {
    try {
      deleteProductByIdApi(id);
      set((state) => ({
        products: state.products.filter((p) => p.id !== id),
      }));
    } catch (err) {
      console.error(err);
    }
  },
  duplicateProduct: async (product) => {
    try {
      duplicateProductApi(product);
      set((state) => ({
        products: [
          ...state.products,
          {
            ...product,
            productName: `${product.productName}(copy)`,
            barcode: `${product.barcode}(copy)`,
          },
        ],
      }));
    } catch (err) {
      console.error(err);
    }
  },
  updateProduct: async (id, updatedProduct) => {
    try {
      if (id === undefined) {
        throw new Error("Product ID is undefined");
      }
      updateProductByIdApi(id, updatedProduct);
      set((state) => ({
        products: state.products.map((p) => {
          if (p.id === id) {
            return {
              ...p,
              ...updatedProduct,
            };
          }
          return p;
        }),
      }));
    } catch (err) {
      console.error(err);
    }
  },
}));
