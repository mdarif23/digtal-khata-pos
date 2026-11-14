import { create } from "zustand";
import {
  createSupplierApi,
  getSuppliersApi,
  updateSupplierApi,
} from "./contact.api";
import type { ContactStoreType } from "./contact.type";

export const useContactStore = create<ContactStoreType>((set) => ({
  suppliers: [],
  loading: false,
  error: null,
  getSuppliers: async () => {
    set({ loading: true, error: null });
    try {
      const suppliers = await getSuppliersApi();
      set({ suppliers, loading: false });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message, loading: false });
      throw error;
    }
  },
  createSupplier: async (data) => {
    const { data: result } = await createSupplierApi(data);
    const supplier = {
      id: result.data.supplierId,
      name: data.supplierName,
      phone: data.phone,
      email: data.email,
      address: data.address,
      status: data.status,
    };
    set((state) => ({
      suppliers: [...state.suppliers, supplier].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      error: null,
    }));
    return result;
  },
  updateSupplier: async (id, data) => {
    const { data: updated } = await updateSupplierApi(id, data);
    set((state) => ({
      suppliers: state.suppliers
        .map((supplier) =>
          supplier.id === id
            ? {
                id,
                name: updated.name,
                phone: updated.phone,
                email: updated.email,
                address: updated.address,
                status: updated.status,
              }
            : supplier,
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
      error: null,
    }));
  },
}));
