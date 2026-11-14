import axios from "./axios.js";
import type { CustomerDue, InputValue } from "../types/customers.types.js";

type CustomerApiRecord = Omit<InputValue, "phone" | "address"> & {
  phone: string | null;
  address: string | null;
};

function normalizeCustomer(customer: CustomerApiRecord): InputValue {
  return {
    ...customer,
    phone: customer.phone ?? "",
    address: customer.address ?? "",
  };
}

export const getCustomersApi = async () => {
  const { data } = await axios.get<CustomerApiRecord[]>("/customers");
  return data.map(normalizeCustomer);
};
export const createCustomerApi = async (customerInfo: InputValue) => {
  const { data } = await axios.post<CustomerApiRecord>(
    "/customers",
    customerInfo,
  );
  return normalizeCustomer(data);
};

// E1-004: correct a customer's contact details (customers.edit; audited).
export const updateCustomerApi = async (
  id: number,
  customerInfo: InputValue,
) => {
  const { data } = await axios.patch<CustomerApiRecord>(
    `/customers/${id}`,
    customerInfo,
  );
  return normalizeCustomer(data);
};

export const getCustomerDueSummaryApi = async () => {
  const { data } = await axios.get<CustomerDue[]>("/due_by_customers");
  return data;
};
