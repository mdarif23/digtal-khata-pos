import { CartSchemaType } from "@/features/pos/schemas/cart.schema";
import { FieldValues, UseFormReturn } from "react-hook-form";

export type InputValue = {
  id: number;
  name: string;
  phone: string;
  address: string;
};
export interface CustomerStore {
  customers: InputValue[];
  customerInfo: InputValue;
  customerInputValue: InputValue;
  showCustomerInfo: InputValue | null;
  loading: boolean;
  error: string | null;
  handleOnchange: (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
  handleInputChange: (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    setChecked: (value: boolean) => void,
  ) => void;
  setShowCustomerInfo: (customer: InputValue | null) => void;
  resetCustomerInfo: () => void;
  resetShowCustomerInfo: () => void;
  handleAddCustomer: () => Promise<void>;
  getCustomers: () => Promise<void>;
  addCustomer: (customerInfo: InputValue) => Promise<InputValue>;
  /** E1-004: correct a customer's contact details. */
  updateCustomer: (id: number, customerInfo: InputValue) => Promise<InputValue>;
}
export type PeerFocusInputProps = {
  placeholder: string;
  id: string;
  handleOnchange: React.ChangeEventHandler<HTMLInputElement>;
  value: string;
  colSpan: string;
};
export type AddCustomerProps = {
  handleOnchange: React.ChangeEventHandler<HTMLInputElement>;
  customerInfo: InputValue;
  handleAddCustomer: () => void;
  setIsOpenCustomerModal: React.Dispatch<React.SetStateAction<boolean>>;
  resetCustomerInfo: () => void;
};
export interface CustomerDue {
  customerId: number;
  totalAmount: number;
  totalDue: number;
  totalPaid: number;
}
export interface ShowCustomerInfoProps {
  form: UseFormReturn<CartSchemaType>;
  isPaymentDialogOpen: boolean;
  setIsPaymentDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
}
