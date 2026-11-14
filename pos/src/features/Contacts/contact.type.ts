import type { SupplierSchemaTypeOutput } from "./schemas/supplier.schema";
export type CreateSupplierResponse = {
  message: string;
  data: {
    supplierId: number;
  };
};
export interface Supplier {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  status: string | null;
}
export interface ContactStoreType {
  suppliers: Supplier[];
  loading: boolean;
  error: string | null;
  getSuppliers: () => Promise<void>;
  createSupplier: (
    data: SupplierSchemaTypeOutput,
  ) => Promise<CreateSupplierResponse>;
  /** D1-05: correct a supplier's contact details / status. */
  updateSupplier: (
    id: number,
    data: SupplierSchemaTypeOutput,
  ) => Promise<void>;
}
