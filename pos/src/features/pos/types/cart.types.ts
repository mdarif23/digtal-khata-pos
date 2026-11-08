import { CartSchemaType } from "@/features/pos/schemas/cart.schema";
import { ProductType } from "@/features/products/product.schema";
import { ProductsTypes } from "@/features/products/products.types";
import type React from "react";
import { UseFormReturn } from "react-hook-form";

/**
 * A sell unit selected for a cart line (packaging-unit selling). The base
 * unit is `uomConversionId: null` with `conversionFactor: 1`; a package unit
 * (e.g. "Box") carries the UOM conversion id and how many base units one
 * package contains.
 */
export interface SellUnitRef {
  uomConversionId: number | null;
  unitName: string;
  unitAbbreviation: string | null;
  /** Base units per ONE package of this unit (1 for the base unit). */
  conversionFactor: number;
  /** Price per ONE package of this unit. */
  salePrice: number;
}

export interface CartType extends ProductType {
  /**
   * Quantity in the SELECTED sell unit (2 = two boxes on a Box line). This
   * is what gets sent to the server; stock bookkeeping converts to base at
   * the call sites with `conversionFactor`.
   */
  quantity: number;
  discount?: {
    type: "fixed" | "percentage";
    value: number;
  } | null;
  serialNumbers?: string[];
  // --- packaging-unit selling (all optional: legacy/persisted lines are
  // --- base-unit lines and must render exactly as before) ---
  /** null/undefined = base unit line. */
  uomConversionId?: number | null;
  /** Mirror of `quantity` in the selected unit (hold-payload field). */
  enteredQuantity?: number;
  unitName?: string | null;
  unitAbbreviation?: string | null;
  conversionFactor?: number;
  /** Price per one selected unit; falls back to variant.sellingPrice. */
  unitPrice?: number;
  /**
   * Permission-gated price override (Phase 6): the cashier's price replaces
   * the DB selling price for THIS line only. unitPrice is in the selected
   * sell unit; the server re-checks permission + minimum floors.
   */
  priceOverride?: { unitPrice: number; reason?: string } | null;
}
export type DiscountType = "percentage" | "fixed";

/** Normalized unit id of a cart line — `null` means the base unit. */
export function lineUnitId(
  line: Pick<CartType, "uomConversionId"> | undefined,
): number | null {
  return line?.uomConversionId ?? null;
}

/** True when the line belongs to the given unit (null = base unit). */
export function lineMatchesUnit(
  line: CartType,
  uomConversionId: number | null | undefined,
): boolean {
  return lineUnitId(line) === (uomConversionId ?? null);
}

export type SwitchUnitResult =
  | { ok: true; convertedQuantity: number; merged: boolean }
  | { ok: false; reason: "line-not-found" | "below-one-package" };

export interface CartStore {
  cart: CartType[];
  /**
   * Client-generated key for the checkout currently in flight. Created once
   * per checkout attempt and reused across retries (double-click, network
   * failure, resubmit) so the backend returns the original sale instead of
   * creating a duplicate. Cleared after a successful sale.
   */
  checkoutIdempotencyKey: string | null;
  beginCheckout: () => string;
  clearCheckoutIdempotency: () => void;
  /**
   * Adds a line. `unit` selects the sell unit (packaging-unit selling) —
   * omit it for the base unit (single-unit products never pass one).
   * Lines are keyed by (variant, unit): 1 Box and 3 Pcs are separate lines.
   */
  addToCart: (product: ProductType, unit?: SellUnitRef) => void;
  /** `uomConversionId` scopes the action to one unit line (null = base). */
  removeCartItem: (id: number, uomConversionId?: number | null) => void;
  addCartQuantity: (id: number, uomConversionId?: number | null) => void;
  removeCartQuantity: (id: number, uomConversionId?: number | null) => void;
  addCustomCartQuantity: (
    id: number,
    customCartQuantity: number,
    uomConversionId?: number | null,
  ) => void;
  /**
   * Switches a line's sell unit, converting the entered quantity so the
   * BASE amount is preserved (2 Box -> 24 Pcs; 13 Pcs -> 1 Box, remainder
   * floors). When a line with the target unit already exists the converted
   * quantity merges into it and the source line is removed.
   */
  switchLineUnit: (
    variantId: number,
    fromUomConversionId: number | null | undefined,
    unit: SellUnitRef,
  ) => SwitchUnitResult;
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
  /**
   * Phase 6: sets/clears the price override on one unit line. The caller is
   * responsible for gating the UI on pricing.price_override; the server
   * re-checks the permission and the minimum floors.
   */
  setLinePriceOverride: (
    variantId: number,
    uomConversionId: number | null | undefined,
    override: { unitPrice: number; reason?: string } | null,
  ) => void;
  /** Mandatory approval reason when a line lands below its minimum floor. */
  belowMinimumReason: string;
  setBelowMinimumReason: (reason: string) => void;
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
