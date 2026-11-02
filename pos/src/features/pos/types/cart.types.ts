import { CartSchemaType } from "@/features/pos/schemas/cart.schema";
import { ProductType } from "@/features/products/product.schema";
import { ProductsTypes } from "@/features/products/products.types";
import type React from "react";
import { UseFormReturn } from "react-hook-form";
export interface CartType extends ProductType {
  quantity: number;
  discount?: {
    type: "fixed" | "percentage";
    value: number;
  } | null;
  serialNumbers?: string[];
}
export type DiscountType = "percentage" | "fixed";
export interface CartStore {
  cart: CartType[];
  addToCart: (product: ProductType) => void;
  removeCartItem: (id: number) => void;
  addCartQuantity: (id: number) => void;
  removeCartQuantity: (id: number) => void;
  addCustomCartQuantity: (id: number, customCartQuantity: number) => void;
  resetCart: () => void;
  addHoldItemsToCart: (holdItems: CartType[]) => void;
  addDiscount: (
    variantId: number,
    discountValue: number,
    discountType: DiscountType,
  ) => void;
  addSerialItem: (
    product: ProductType,
    variantId: number | undefined,
    serials: string[],
  ) => void;
}
export interface CashForm {
  discount: number;
  amountReceived: number;
  change: number;
  finalTotal: number;
  paidAmount: number;
  note: string;
  dueAmount: number;
  subtotal: number;
  vat: number;
}
export interface HoldCartItems {
  id: number;
  name: string;
  time: string;
  items: CartType[];
}
export interface ClickToShowMoreProps {
  showMore: boolean;
  setHoldConfirm: () => void;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  holdCartItems: HoldCartItems[];
  setShowMoreFalse: () => void;
  setShowHoldItems: () => void;
}
export type ClickType = "payments" | "cash";
export interface CashModalProps {
  handlePay: (handelClose: () => void, click: ClickType) => void;
  handleCashChange: (id: string, value: number | string) => void;
  cashForm: CashForm;
  setCashForm: React.Dispatch<React.SetStateAction<CashForm>>;
  isOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCashModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  initialCashFrom: CashForm;
}
interface BaseHoldProps {
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isOpen: boolean;
  holdCartItems: HoldCartItems[];
}
export interface CartHoldBtnProps extends BaseHoldProps {
  setHoldConfirmFalse: () => void;
  setHoldCartItems: () => void;
}
export interface CartHoldShowBtnProps extends BaseHoldProps {
  setShowHoldItemsFalse: () => void;
  setHoldCartItems: React.Dispatch<React.SetStateAction<HoldCartItems[]>>;
}
export interface PeerInputProps {
  id: string;
  peerName: string;
  value: string | number;
  onChange: (id: string, value: number | string) => void;
}
export interface PaymentModalProps {
  initialCashFrom: CashForm;
  handlePay: (handelClose: () => void, click: ClickType) => void;
  paymentMethod: string;
  setPaymentMethod: React.Dispatch<React.SetStateAction<string>>;
  handleCashChange: (id: string, value: string | number) => void;
  cashForm: CashForm;
  setCashForm: React.Dispatch<React.SetStateAction<CashForm>>;
  isOpen: boolean;
  setIsPaymentModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
}
export interface PopupModalProps {
  handelClose: () => void;
  isOpen: boolean;
  className: string;
  children: React.ReactNode;
}
export interface CartTextModalProps {
  subTotal: number;
  vat: number;
  form: UseFormReturn<CartSchemaType>;
}
export interface AddChargeModalProps {
  isOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsChargeModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
}
export interface ClickEmptyToResetCartProps {
  isOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setEmptyCartCon: () => void;
}
