import { useEffect, useMemo, useState } from "react";
import { MdOutlineAddCircleOutline, MdDeleteOutline } from "react-icons/md";
import { FiMinusCircle } from "react-icons/fi";
import { useWatch } from "react-hook-form";
import { ClearCartDialog } from "./ClearCartDialog.js";
import type { DiscountType } from "../../types/cart.types.js";
import useProductStore from "@/features/products/useProductStore.js";
import { useCartStore } from "@/features/pos/stores/useCartStore.js";
import type {
  CustomerDue,
  ShowCustomerInfoProps,
} from "@/types/customers.types.js";
import axios from "../../../../api/axios.js";
import { useCustomerStore } from "@/store/useCustomerStore.js";
import { PaymentModal } from "./PaymentModal.js";
import { DiscountModal } from "./DiscountModal.js";
import { HoldDropdownMenu } from "./HoldDropdownMenu.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { getCartTotals, getLinePricing, money } from "../../cartPricing.js";
import { quoteSaleApi, type QuoteTotals } from "../../quote.api.js";
import { SerialPickerDialog } from "./SerialPickerDialog.js";
import { toast } from "@/components/ui/toast.js";
import { Button } from "@/components/ui/button.js";
import { ShoppingCart } from "lucide-react";
import {
  useSellUnits,
  type SellUnitOption,
} from "../../hooks/useSellUnits.js";
import { UnitSwitcher } from "./UnitSwitcher.js";

const FALLBACK_IMAGE =
  "https://www.startech.com.bd/image/cache/catalog/ceiling-fan/qulik/windora/windora-01-500x500.webp";

type CartItem = ReturnType<typeof useCartStore.getState>["cart"][number];

const tk = (n: number) => `৳${n.toFixed(2)}`;

// ---------- shared totals (used by every cart component) ----------
// Server-authoritative: the backend computes the same totals createSale will
// charge, including product tax rules the client cannot know. Local math
// fills the gap instantly and keeps working offline / on quote failure.

/** View shape: local getCartTotals fields plus the quote-only coupon/group fields. */
interface CartTotalsView {
  itemsBase: number;
  itemDiscount: number;
  itemsTotal: number;
  cartDiscountAmount: number;
  afterDiscount: number;
  vatPercent: number;
  vat: number;
  finalTotal: number;
  usesTaxRules?: boolean;
  coupon?: { code: string; discountAmount: number; description: string | null } | null;
  couponError?: string | null;
  group?: { id: number; name: string; discountAmount: number } | null;
}

function useCartTotals(form: ShowCustomerInfoProps["form"]): CartTotalsView {
  const cart = useCartStore((state) => state.cart);
  const discount = useWatch({ control: form.control, name: "discount" });
  const vatPercent =
    useWatch({ control: form.control, name: "vatPercent" }) ?? 0;
  const couponCode = useWatch({ control: form.control, name: "couponCode" });
  // Walk-in has id 0 in the store — never send it to the server (the quote
  // endpoint requires a positive customer id, so 0 would 400 every quote and
  // silently break coupons + server totals).
  const customerId =
    useCustomerStore((s) => {
      const id = s.showCustomerInfo?.id;
      return id != null && id > 0 ? id : null;
    });

  const localTotals = useMemo(
    () => getCartTotals(cart, discount, Number(vatPercent)),
    [cart, discount, vatPercent],
  );

  const [quoted, setQuoted] = useState<QuoteTotals | null>(null);

  useEffect(() => {
    if (cart.length === 0) {
      setQuoted(null);
      return;
    }
    let ignore = false;
    const timer = setTimeout(() => {
      quoteSaleApi({
        items: cart.map((item) => ({
          variantId: item.variants[0]?.id ?? 0,
          quantity: item.quantity,
          discount: item.discount ?? null,
          uomConversionId: item.uomConversionId ?? null,
        })),
        cartDiscount: discount,
        vatPercent: vatPercent === null ? null : Number(vatPercent),
        couponCode: couponCode?.trim() || null,
        customerId,
      })
        .then((totals) => {
          if (!ignore) setQuoted(totals);
        })
        .catch(() => {
          if (!ignore) setQuoted(null); // fall back to local math
        });
    }, 250);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [cart, discount, vatPercent, couponCode, customerId]);

  if (quoted === null) return localTotals;
  // Trust the server quote for every money field; keep the client shape.
  return {
    itemsBase: quoted.itemsBase,
    itemDiscount: quoted.itemDiscount,
    itemsTotal: quoted.itemsTotal,
    cartDiscountAmount: quoted.cartDiscountAmount,
    afterDiscount: quoted.afterDiscount,
    vatPercent: quoted.usesTaxRules ? 0 : quoted.vatPercent,
    vat: quoted.vat,
    finalTotal: quoted.finalTotal,
    usesTaxRules: quoted.usesTaxRules,
    coupon: quoted.coupon ?? null,
    couponError: quoted.couponError ?? null,
    group: quoted.group ?? null,
  };
}

// ---------- customer info ----------
function CartCustomerInfo() {
  const showCustomerInfo = useCustomerStore((state) => state.showCustomerInfo);
  const [dueByCustomers, setDueByCustomers] = useState<CustomerDue[]>([]);
  const { name, phone, address, id } = showCustomerInfo || {};

  const [loyaltyBalance, setLoyaltyBalance] = useState<number | null>(null);
  const [storeCreditBalance, setStoreCreditBalance] = useState<number | null>(null);

  // reload when the customer changes, so the due is never stale
  useEffect(() => {
    let ignore = false;
    axios
      .get("due_by_customers")
      .then((res) => {
        if (!ignore) setDueByCustomers(res.data);
      })
      .catch((err) => console.error("Failed to load customer dues", err));
    if (id != null && id > 0) {
      axios
        .get(`/customers/${id}/loyalty`)
        .then((res) => {
          if (!ignore) setLoyaltyBalance(Number(res.data?.data?.balance ?? 0));
        })
        .catch(() => !ignore && setLoyaltyBalance(null));
      axios
        .get(`/customers/${id}/store-credit`)
        .then((res) => {
          if (!ignore) setStoreCreditBalance(Number(res.data?.data?.balance ?? 0));
        })
        .catch(() => !ignore && setStoreCreditBalance(null));
    } else {
      setLoyaltyBalance(null);
      setStoreCreditBalance(null);
    }
    return () => {
      ignore = true;
    };
  }, [id]);

  if (!name && !phone) return null;

  const customerDue = dueByCustomers.find((c) => c.customerId === id);

  return (
    <Card className="my-2">
      <CardContent className="grid grid-cols-2 gap-1">
        <span>Name: {name}</span>
        <span>Phone: {phone}</span>
        <span className="col-span-2">Address: {address}</span>
        <span className="col-span-2">
          {customerDue
            ? `Total Amount: ${customerDue.totalAmount ?? 0}, Total Paid: ${customerDue.totalPaid ?? 0}, Total Due: ${customerDue.totalDue ?? 0}`
            : "No Due"}
        </span>
        {loyaltyBalance !== null && (
          <span className="col-span-2 text-xs">
            Loyalty points: {loyaltyBalance.toFixed(2)}
          </span>
        )}
        {storeCreditBalance !== null && (
          <span className="col-span-2 text-xs">
            Store credit: ৳{storeCreditBalance.toFixed(2)}
          </span>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- coupon entry (Module 6) ----------
function CouponInput({ form }: { form: ShowCustomerInfoProps["form"] }) {
  const value = useWatch({ control: form.control, name: "couponCode" });
  return (
    <Input
      placeholder="Coupon code (optional)"
      maxLength={60}
      value={value ?? ""}
      onChange={(e) =>
        form.setValue("couponCode", e.target.value.toUpperCase() || undefined)
      }
      className="uppercase"
    />
  );
}

// ---------- cart list ----------
export default function CartItems() {
  const cart = useCartStore((state) => state.cart);

  return (
    <>
      <CartCustomerInfo />
      {cart.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center">
          <ShoppingCart className="size-20" />
          <span>Cart is empty</span>
          <span>Scan a barcode or click products to start a sale.</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {cart.map((item) => (
            <CartItemRow
              // Lines are keyed by (variant, unit): a Box line and a Pcs line
              // of the same variant must not share a React key.
              key={`${item.variants[0]?.id ?? item.id}:${item.uomConversionId ?? "base"}`}
              item={item}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ---------- one cart row ----------
function CartItemRow({ item }: { item: CartItem }) {
  // P2: stock returns/units now adjust the CANONICAL catalog's variant
  // quantity — the same store the POS grid reads (fixes the store-drift bug).
  // Packaging lines convert entered units to BASE deltas with the line's
  // conversionFactor (adding 1 Box takes 12 pcs from the pool).
  const returnVariantStock = useProductStore((s) => s.returnVariantStock);
  const takeVariantStock = useProductStore((s) => s.takeVariantStock);
  const addCartQuantity = useCartStore((s) => s.addCartQuantity);
  const removeCartQuantity = useCartStore((s) => s.removeCartQuantity);
  const removeCartItem = useCartStore((s) => s.removeCartItem);
  const addCustomCartQuantity = useCartStore((s) => s.addCustomCartQuantity);
  const switchLineUnit = useCartStore((s) => s.switchLineUnit);
  const addDiscount = useCartStore((s) => s.addDiscount);
  const { addSerialItem } = useCartStore();

  const variant = item.variants[0];
  if (!variant || variant.id === undefined) return null;
  const variantId = variant.id;
  const cartSerials =
    useCartStore(
      (state) =>
        state.cart
          .find(
            (p) =>
              p.variants.some((v) => v.id === variantId) &&
              (p.uomConversionId ?? null) === (item.uomConversionId ?? null),
          )
          ?.serialNumbers,
    ) ?? [];

  const quantity = Number(item.quantity);
  const lineUnit = item.uomConversionId ?? null;
  // Base unit when the field is absent (legacy/persisted lines, serials).
  const conversionFactor =
    item.conversionFactor && item.conversionFactor > 0
      ? item.conversionFactor
      : 1;
  const isUomLine = lineUnit !== null;
  const unitPrice = item.unitPrice ?? Number(variant.sellingPrice);
  const line = getLinePricing(unitPrice, quantity, item.discount);
  const isSerial = item.trackingType === "serial";
  const [isSerialOpen, setIsSerialOpen] = useState(false);

  // Sell units for the switcher chip — lazily fetched per cart line and
  // cached; single-unit products never render any of this UI.
  const { data: sellUnits } = useSellUnits(variantId, !isSerial);
  const units = sellUnits?.units ?? [];
  const hasPackagingUnits = units.length > 1;
  const baseUnitLabel =
    sellUnits?.baseUnit?.abbreviation ?? sellUnits?.baseUnit?.name ?? null;
  const chipLabel =
    (isUomLine ? item.unitAbbreviation ?? item.unitName : null) ??
    (hasPackagingUnits ? baseUnitLabel : null);

  const handleSwitchUnit = (unit: SellUnitOption) => {
    const result = switchLineUnit(variantId, lineUnit, unit);
    if (!result.ok) {
      toast.add({
        type: "error",
        description:
          result.reason === "below-one-package"
            ? `That is less than 1 ${unit.unitName} — line left unchanged.`
            : "Could not switch the unit.",
      });
      return;
    }
    // Keep the stock pool consistent: release the old base amount, reserve
    // the converted one (the floored remainder stays sellable).
    returnVariantStock(variantId, quantity * conversionFactor);
    takeVariantStock(variantId, result.convertedQuantity * unit.conversionFactor);
  };

  return (
    <Card className="overflow-hidden shadow-none">
      <CardContent className="p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap">
          <img
            className="size-16 shrink-0 rounded-xl object-cover sm:size-20"
            src={item.imageUrl ?? FALLBACK_IMAGE}
            alt={item.name}
          />

          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate font-medium">{item.name}</span>
            <span className="text-sm text-muted-foreground">
              {unitPrice.toFixed(2)} × {quantity}
              {isUomLine && item.unitAbbreviation ? ` ${item.unitAbbreviation}` : ""}{" "}
              ={" "}
              <span className="font-semibold text-foreground">
                {line.base.toFixed(2)}
              </span>
              {isUomLine && (
                <span className="ml-1.5 text-xs">
                  = {money(quantity * conversionFactor)}
                  {baseUnitLabel ? ` ${baseUnitLabel}` : ""}
                </span>
              )}
            </span>

            {(isUomLine || hasPackagingUnits) && !isSerial && sellUnits && (
              <UnitSwitcher
                units={units}
                currentUomConversionId={lineUnit}
                currentLabel={chipLabel}
                onSwitch={handleSwitchUnit}
              />
            )}

            <CartItemDiscount
              variantId={variantId}
              discount={item.discount}
              lineBase={line.base}
              lineTotal={line.total}
              hasDiscount={line.discountAmount > 0}
              addDiscount={addDiscount}
            />
          </div>

          {isSerial ? (
            <>
              <SerialPickerDialog
                serialDialogOpen={isSerialOpen}
                setSerialDialogOpen={setIsSerialOpen}
                variantId={variantId}
                selected={cartSerials}
                onConfirm={(serials) => {
                  addSerialItem(
                    { ...item, name: item.name },
                    variantId,
                    serials,
                  );
                  toast.add({
                    description: `${item.name} added to cart!`,
                  });
                }}
              />
              <div className="ml-auto flex w-full items-center justify-end gap-2 text-xl sm:w-auto">
                <Button
                  type="button"
                  onClick={() => {
                    setIsSerialOpen(true);
                  }}
                >
                  {" "}
                  Serials ({item.serialNumbers?.length ?? 0})
                </Button>
                <button
                  type="button"
                  aria-label="Remove item"
                  onClick={() => {
                    returnVariantStock(variantId, quantity * conversionFactor);
                    removeCartItem(variantId, lineUnit);
                  }}
                  className="cursor-pointer rounded-full text-muted-foreground transition hover:text-destructive"
                >
                  <MdDeleteOutline />
                </button>
              </div>
            </>
          ) : (
            <div className="ml-auto flex w-full items-center justify-end gap-2 text-xl sm:w-auto">
              <button
                type="button"
                aria-label="Decrease quantity"
                disabled={quantity <= 1}
                onClick={() => {
                  // Steps in ENTERED units (±1 box); the pool moves in base.
                  returnVariantStock(variantId, conversionFactor);
                  removeCartQuantity(variantId, lineUnit);
                }}
                className="cursor-pointer rounded-full transition hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FiMinusCircle />
              </button>

              <CartQuantityInput
                itemId={variantId}
                quantity={quantity}
                addCustomCartQuantity={(id, newQty) => {
                  const deltaBase = (newQty - quantity) * conversionFactor;
                  if (deltaBase > 0) {
                    takeVariantStock(variantId, deltaBase);
                  } else if (deltaBase < 0) {
                    returnVariantStock(variantId, -deltaBase);
                  }
                  addCustomCartQuantity(id, newQty, lineUnit);
                }}
              />

              <button
                type="button"
                aria-label="Increase quantity"
                onClick={() => {
                  takeVariantStock(variantId, conversionFactor);
                  addCartQuantity(variantId, lineUnit);
                }}
                className="cursor-pointer rounded-full transition hover:text-primary"
              >
                <MdOutlineAddCircleOutline />
              </button>

              <button
                type="button"
                aria-label="Remove item"
                onClick={() => {
                  returnVariantStock(variantId, quantity * conversionFactor);
                  removeCartItem(variantId, lineUnit);
                }}
                className="cursor-pointer rounded-full text-muted-foreground transition hover:text-destructive"
              >
                <MdDeleteOutline />
              </button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- totals + action buttons ----------
export function CartCalculation({
  form,
  isPaymentDialogOpen,
  setIsPaymentDialogOpen,
}: ShowCustomerInfoProps) {
  const totals = useCartTotals(form);

  return (
    <div className="space-y-2">
      <CartTextModal totals={totals} />
      <div className="grid grid-cols-6 gap-1 py-2">
        <div className="col-span-2">
          <ClearCartDialog />
        </div>
        <div className="col-span-2">
          <HoldDropdownMenu />
        </div>
        <div className="col-span-2">
          {/* discount is applied on the amount after item discounts */}
          <DiscountModal form={form} subTotal={totals.itemsTotal} />
        </div>
        <CouponInput form={form} />
        <div className="col-span-6">
          {/* payment gets the amount after discount, plus VAT */}
          <PaymentModal
            isPaymentDialogOpen={isPaymentDialogOpen}
            setIsPaymentDialogOpen={setIsPaymentDialogOpen}
            form={form}
            subTotal={totals.afterDiscount}
            vat={totals.vat}
          />
        </div>
      </div>
    </div>
  );
}

function CartTextModal({
  totals,
}: {
  totals: CartTotalsView;
}) {
  const cart = useCartStore((state) => state.cart);
  const totalItemsCount = cart.length;
  const totalQuantityCount = cart.reduce(
    (total, item) => total + (Number(item.quantity) || 0),
    0,
  );

  return (
    <>
      <div className="flex justify-between border-b pb-2 text-sm text-muted-foreground">
        <span>
          {totalItemsCount} {totalItemsCount === 1 ? "line item" : "line items"}
        </span>
        {/* Neutral label: mixed Box/Pcs lines make "units" ambiguous. */}
        <span>Qty: {totalQuantityCount}</span>
      </div>
      <div className="flex justify-between py-1.5 text-sm">
        <span>Subtotal</span>
        <span>{tk(totals.itemsBase)}</span>
      </div>
      {totals.itemDiscount > 0 && (
        <div className="flex justify-between py-1.5 text-sm text-emerald-700">
          <span>Item discounts</span>
          <span>-{tk(totals.itemDiscount)}</span>
        </div>
      )}
      {totals.cartDiscountAmount > 0 && (
        <div className="flex justify-between py-1.5 text-sm text-emerald-700">
          <span>Discount</span>
          <span>-{tk(totals.cartDiscountAmount)}</span>
        </div>
      )}
      {"group" in totals && totals.group && totals.group.discountAmount > 0 && (
        <div className="flex justify-between py-1.5 text-sm text-emerald-700">
          <span>{totals.group.name} pricing</span>
          <span>-{tk(totals.group.discountAmount)}</span>
        </div>
      )}
      {"coupon" in totals && totals.coupon && (
        <div className="flex justify-between py-1.5 text-sm text-emerald-700">
          <span>Coupon {totals.coupon.code}</span>
          <span>-{tk(totals.coupon.discountAmount)}</span>
        </div>
      )}
      {"couponError" in totals && totals.couponError && (
        <div className="py-1 text-xs text-destructive">{totals.couponError}</div>
      )}
      {totals.vat > 0 && (
        <div className="flex justify-between py-1.5 text-sm">
          <span>
            {"usesTaxRules" in totals && totals.usesTaxRules
              ? "VAT / Tax (product rules)"
              : `VAT: ${totals.vatPercent}%`}
          </span>
          <span>{tk(totals.vat)}</span>
        </div>
      )}
      <div className="flex items-center justify-between border-t pt-2 font-semibold">
        <span>Total due</span>
        <span className="text-lg tracking-tight">{tk(totals.finalTotal)}</span>
      </div>
    </>
  );
}

// ---------- per-item discount ----------
type CartItemDiscountProps = {
  variantId: number;
  discount: CartItem["discount"]; // current value from the store
  lineBase: number; // price x qty, the max for a fixed discount
  lineTotal: number;
  hasDiscount: boolean;
  addDiscount: (id: number, value: number, type: DiscountType) => void;
};

export function CartItemDiscount({
  variantId,
  discount,
  lineBase,
  lineTotal,
  hasDiscount,
  addDiscount,
}: CartItemDiscountProps) {
  const [value, setValue] = useState(discount ? String(discount.value) : "");
  const [type, setType] = useState<DiscountType>(
    discount?.type ?? "percentage",
  );

  // keep the input in sync with the store (clear cart, hold/restore, clamped values)
  useEffect(() => {
    setValue(discount ? String(discount.value) : "");
    if (discount) setType(discount.type);
  }, [discount?.value, discount?.type]);

  const commit = (nextValue: string, nextType: DiscountType) => {
    const raw = Number(nextValue);

    // empty / 0 / invalid -> remove the discount
    if (nextValue === "" || !Number.isFinite(raw) || raw <= 0) {
      setValue("");
      addDiscount(variantId, 0, nextType);
      return;
    }

    const max = nextType === "percentage" ? 100 : lineBase;
    const clamped = Math.min(raw, max);
    setValue(String(clamped));
    addDiscount(variantId, clamped, nextType);
  };

  return (
    <div className="flex items-center space-x-2">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => commit(value, type)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault(); // Enter must not submit the cart form
            commit(value, type);
          }
        }}
        className="h-8 w-20"
        type="number"
        min={0}
        placeholder={`${type === "percentage" ? "%" : "৳"} off`}
        aria-label="Item discount"
      />
      <Switch
        checked={type === "fixed"}
        onCheckedChange={(checked) => {
          const nextType: DiscountType = checked ? "fixed" : "percentage";
          setType(nextType);
          if (value) commit(value, nextType);
        }}
        id={`discount-mode-${variantId}`}
        aria-label="Fixed amount discount"
      />
      {hasDiscount && (
        <span className="text-sm font-medium text-green-600">
          = {tk(lineTotal)}
        </span>
      )}
    </div>
  );
}

// ---------- quantity input ----------
interface CartQuantityInputProps {
  itemId: number;
  quantity: number; // from the cart store
  addCustomCartQuantity: (id: number, qty: number) => void;
}

export function CartQuantityInput({
  itemId,
  quantity,
  addCustomCartQuantity,
}: CartQuantityInputProps) {
  const [inputValue, setInputValue] = useState(String(quantity));

  // changes from the +/- buttons or the product grid update the input
  useEffect(() => {
    setInputValue(String(quantity));
  }, [quantity]);

  const commitChange = (val: string) => {
    const parsed = Math.floor(Number(val));
    // empty, 0, negative or invalid -> go back to the current quantity
    const newQty = Number.isFinite(parsed) && parsed >= 1 ? parsed : quantity;

    if (newQty !== quantity) {
      addCustomCartQuantity(itemId, newQty);
    }

    // Show what the store really holds (it may clamp to available stock).
    // Zustand updates synchronously, so this reads the new value.
    const stored =
      useCartStore.getState().cart.find((i) => i.id === itemId)?.quantity ??
      quantity;
    setInputValue(String(stored));
  };

  return (
    <Input
      className="h-8 w-15 text-center"
      type="number"
      min={1}
      step={1}
      value={inputValue}
      aria-label="Quantity"
      onChange={(e) => setInputValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => commitChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitChange(e.currentTarget.value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
