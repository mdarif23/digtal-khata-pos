import axios from "../api/axios.js";
import { isAxiosError } from "axios";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "@/components/ui/toast";
import type { InputValue, CustomerStore } from "../types/customers.types.js";
import {
  createCustomerApi,
  getCustomersApi,
  updateCustomerApi,
} from "../api/customer.api.js";
const initialCustomerInfo: InputValue = {
  id: 0,
  name: "",
  phone: "",
  address: "",
};

export const useCustomerStore = create<CustomerStore>((set, get) => ({
  customers: [],
  customerInfo: initialCustomerInfo,
  customerInputValue: initialCustomerInfo,
  showCustomerInfo: initialCustomerInfo,
  loading: false,
  error: null,
  handleOnchange: (e) => {
    const { id, value } = e.target;
    set((state) => ({
      customerInfo: {
        ...state.customerInfo,
        [id]: id === "phone" ? value.replace(/\D/g, "").slice(0, 11) : value,
      },
    }));
  },
  handleInputChange: (e, setChecked) => {
    const { value } = e.target;
    set((state) => ({
      customerInputValue: {
        ...state.customerInputValue,
        name: value,
      },
    }));
    if (value === "") {
      setChecked(true);
    }
  },
  setShowCustomerInfo: (customer) => {
    set((state) => ({
      showCustomerInfo: customer,
    }));
  },
  resetCustomerInfo: () =>
    set({
      customerInfo: { ...initialCustomerInfo },
    }),
  resetShowCustomerInfo: () =>
    set({
      showCustomerInfo: { ...initialCustomerInfo },
      customerInputValue: { ...initialCustomerInfo },
    }),
  handleAddCustomer: async () => {
    const { customerInfo, resetCustomerInfo } = get();
    if (customerInfo.name === "" || customerInfo.phone === "") {
      toast.add({ description: "Please fill in the customer name and phone." });
      return;
    }
    try {
      await get().addCustomer(customerInfo);
      resetCustomerInfo();
      toast.add({ description: "Customer added." });
    } catch (err: unknown) {
      console.error("Failed to add customer in handleAddCustomer:", err);
      toast.add({
        description: isAxiosError(err)
          ? (err.response?.data?.message ?? "Could not add the customer.")
          : "Could not add the customer.",
      });
    }
  },
  getCustomers: async () => {
    set({ loading: true, error: null });
    try {
      const { loadCustomersWithCache } = await import(
        "@/features/pos/offline/catalog.js"
      );
      const { data: customersData } = await loadCustomersWithCache(getCustomersApi);
      set({ customers: customersData, loading: false });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      set({ error: errorMessage, loading: false });
    }
  },
  addCustomer: async (customerInfo) => {
    const customer = await createCustomerApi(customerInfo);
    set((state) => ({
      customers: [...state.customers, customer],
    }));
    return customer;
  },
  updateCustomer: async (id, customerInfo) => {
    const customer = await updateCustomerApi(id, customerInfo);
    set((state) => ({
      customers: state.customers.map((existing) =>
        existing.id === id ? customer : existing,
      ),
    }));
    return customer;
  },
}));
