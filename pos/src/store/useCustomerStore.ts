import { isAxiosError } from "axios";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "@/components/ui/toast";
import type { InputValue, CustomerStore } from "../types/customers.types.js";
import {
  createCustomerApi,
  updateCustomerApi,
} from "../api/customer.api.js";
import { queryClient } from "@/lib/queryClient.js";
import {
  customerKeys,
  type CustomersCache,
} from "@/features/customers/hooks/useCustomers.js";

const initialCustomerInfo: InputValue = {
  id: 0,
  name: "",
  phone: "",
  address: "",
};

/**
 * The customers LIST moved to TanStack Query (useCustomersQuery) in Phase 6
 * Feature 1. This store keeps only the customer DIALOG/SELECTION state
 * (customerInfo / customerInputValue / showCustomerInfo) — checkout state,
 * not data-fetching. addCustomer/updateCustomer keep their exact contract
 * (API call → local patch, NO refetch) but patch the query cache instead of
 * the removed Zustand array.
 */
function patchCustomersCache(
  updater: (rows: InputValue[]) => InputValue[],
): void {
  queryClient.setQueryData<CustomersCache>(customerKeys.list(), (current) =>
    current
      ? { ...current, data: updater(current.data) }
      : { data: updater([]), fromCache: false },
  );
}

export const useCustomerStore = create<CustomerStore>((set, get) => ({
  customerInfo: initialCustomerInfo,
  customerInputValue: initialCustomerInfo,
  showCustomerInfo: initialCustomerInfo,
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
  addCustomer: async (customerInfo) => {
    const customer = await createCustomerApi(customerInfo);
    patchCustomersCache((rows) => [...rows, customer]);
    return customer;
  },
  updateCustomer: async (id, customerInfo) => {
    const customer = await updateCustomerApi(id, customerInfo);
    patchCustomersCache((rows) =>
      rows.map((existing) => (existing.id === id ? customer : existing)),
    );
    return customer;
  },
}));
