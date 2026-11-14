import axios from "../../api/axios.js";
import type { SupplierSchemaTypeOutput } from "./schemas/supplier.schema";
import type { Supplier, CreateSupplierResponse } from "./contact.type";

export async function createSupplierApi(data: SupplierSchemaTypeOutput) {
  return axios.post<CreateSupplierResponse>("/contacts/supplier", data);
}

// D1-05: correct a supplier's contact details / status.
export async function updateSupplierApi(id: number, data: SupplierSchemaTypeOutput) {
  return axios.put<{ message: string; data: Supplier }>(
    `/contacts/supplier/${id}`,
    data,
  );
}

export async function getSuppliersApi() {
  const { data } = await axios.get<Supplier[]>("/contacts/suppliers");
  return data;
}
