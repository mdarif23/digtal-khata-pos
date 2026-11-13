import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import type { CartSchemaType } from "../../schemas/cart.schema";
import { useCartStore } from "@/features/pos/stores/useCartStore";

const money = (n: number) => Math.round(n * 100) / 100;

const PERCENT_PRESETS = [5, 10, 15];
const FLAT_PRESETS = [10, 25, 50, 100];
const VAT_PRESETS = [5, 7.5, 10, 15];

// Shared: use this in the parent, in PaymentModal, and copy the logic to the backend
export function calcDiscountAmount(
  subTotal: number,
  discount: CartSchemaType["discount"],
): number {
  if (!discount) return 0;
  const raw =
    discount.type === "percentage"
      ? (subTotal * discount.value) / 100
      : discount.value;
  return money(Math.min(Math.max(raw, 0), subTotal)); // never below 0 or above subtotal
}

export function DiscountModal({
  subTotal,
  form,
  /** Phase 3 hotkey: increment to open (F4); the trigger button still works. */
  openSignal = 0,
}: {
  subTotal: number;
  form: UseFormReturn<CartSchemaType>;
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);
  const discount = useWatch({ control: form.control, name: "discount" });
  const vatPercent =
    useWatch({ control: form.control, name: "vatPercent" }) ?? 0;

  // only the text being typed; the real value lives in the form
  const [percentInput, setPercentInput] = useState("");
  const [flatInput, setFlatInput] = useState("");
  const [vatInput, setVatInput] = useState("");

  const discountAmount = calcDiscountAmount(subTotal, discount);
  const afterDiscount = money(subTotal - discountAmount);
  const vatAmount = money((afterDiscount * vatPercent) / 100); // confirm: VAT after discount?
  const currentTotal = money(afterDiscount + vatAmount);

  const applyPercent = (value: number) => {
    if (!Number.isFinite(value) || value < 0 || value > 100) return;
    form.setValue(
      "discount",
      value === 0 ? null : { type: "percentage", value },
    );
    setPercentInput(value === 0 ? "" : String(value));
    setFlatInput("");
  };

  const applyFlat = (value: number) => {
    if (!Number.isFinite(value) || value < 0) return;
    form.setValue(
      "discount",
      value === 0 ? null : { type: "fixed", value: Math.min(value, subTotal) },
    );
    setFlatInput(value === 0 ? "" : String(Math.min(value, subTotal)));
    setPercentInput("");
  };

  const applyVat = (value: number) => {
    if (!Number.isFinite(value) || value < 0 || value > 100) return;
    form.setValue("vatPercent", value);
    setVatInput(value === 0 ? "" : String(value));
  };

  const clearAll = () => {
    form.setValue("discount", null);
    form.setValue("vatPercent", 0);
    setPercentInput("");
    setFlatInput("");
    setVatInput("");
  };
  const cartLength = useCartStore((state) => state.cart.length);

  useEffect(() => {
    if (cartLength === 0) {
      form.setValue("discount", null);
      form.setValue("vatPercent", 0);

      setPercentInput("");
      setFlatInput("");
      setVatInput("");
    }
  }, [cartLength, form]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            className="w-full"
            onClick={() => setOpen(true)}
          >
            Discount
          </Button>
        }
      />
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Discounts & VAT</DialogTitle>
          <DialogDescription>
            Subtotal: ৳{subTotal.toFixed(2)} · Current total: ৳
            {currentTotal.toFixed(2)}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          {/* Percentage */}
          <Field>
            <Label htmlFor="discount-percent">Percentage discount</Label>
            <div className="flex gap-3">
              <Input
                id="discount-percent"
                type="number"
                min={0}
                max={100}
                value={percentInput}
                onChange={(e) => setPercentInput(e.target.value)}
                placeholder="0"
              />
              <Button
                type="button"
                onClick={() => applyPercent(Number(percentInput))}
              >
                Apply %
              </Button>
            </div>
            <div className="flex gap-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => applyPercent(0)}
              >
                No Discount
              </Button>
              {PERCENT_PRESETS.map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant="outline"
                  onClick={() => applyPercent(p)}
                >
                  {p}%
                </Button>
              ))}
            </div>
            <FieldDescription>
              {discount?.type === "percentage"
                ? `Applied: ${discount.value}% off (৳${discountAmount.toFixed(2)})`
                : "No percentage discount"}
            </FieldDescription>
          </Field>

          {/* Flat */}
          <Field>
            <Label htmlFor="discount-flat">Flat discount</Label>
            <div className="flex gap-3">
              <Input
                id="discount-flat"
                type="number"
                min={0}
                value={flatInput}
                onChange={(e) => setFlatInput(e.target.value)}
                placeholder="0.00"
              />
              <Button
                type="button"
                onClick={() => applyFlat(Number(flatInput))}
              >
                Apply ৳
              </Button>
            </div>
            <div className="flex gap-1">
              {FLAT_PRESETS.map((v) => (
                <Button
                  key={v}
                  type="button"
                  variant="outline"
                  onClick={() => applyFlat(v)}
                >
                  ৳{v}
                </Button>
              ))}
            </div>
            <FieldDescription>
              {discount?.type === "fixed"
                ? `Applied: ৳${discountAmount.toFixed(2)} flat off`
                : "No flat discount"}
            </FieldDescription>
          </Field>

          {/* VAT */}
          <Field>
            <Label htmlFor="vat-percent">VAT / TAX %</Label>
            <div className="flex gap-3">
              <Input
                id="vat-percent"
                type="number"
                min={0}
                max={100}
                value={vatInput}
                onChange={(e) => setVatInput(e.target.value)}
                placeholder="0"
              />
              <Button type="button" onClick={() => applyVat(Number(vatInput))}>
                Apply VAT
              </Button>
            </div>
            <div className="flex gap-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => applyVat(0)}
              >
                No VAT
              </Button>
              {VAT_PRESETS.map((v) => (
                <Button
                  key={v}
                  type="button"
                  variant="outline"
                  onClick={() => applyVat(v)}
                >
                  {v}%
                </Button>
              ))}
            </div>
            <FieldDescription>
              {vatPercent > 0
                ? `VAT: ${vatPercent}% (৳${vatAmount.toFixed(2)})`
                : "No VAT"}
            </FieldDescription>
          </Field>
        </FieldGroup>

        <Button type="button" variant="destructive" onClick={clearAll}>
          Clear all Discounts & VAT
        </Button>
        <DialogFooter>
          <DialogClose
            render={
              <Button type="button" variant="outline">
                Done (esc)
              </Button>
            }
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
