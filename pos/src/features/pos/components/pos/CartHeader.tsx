import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldError } from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CustomerDialog } from "@/features/Contacts/components/customers/CustomerDialog";
import { useCustomerStore } from "@/store/useCustomerStore";
import { useState } from "react";
import { Controller, type UseFormReturn } from "react-hook-form";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { UserPlus } from "lucide-react";
import type { CartSchemaType } from "../../schemas/cart.schema";
export function CartHeader({
  form,
  cartItemCount,
}: {
  form: UseFormReturn<CartSchemaType>;
  cartItemCount: number;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Current sale
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight">
            Order details
          </h2>
          <p className="text-xs text-muted-foreground">
            {cartItemCount} {cartItemCount === 1 ? "line item" : "line items"}
          </p>
        </div>
        <div className="w-28 shrink-0 sm:w-40">
          <SaleDatePicker form={form} />
        </div>
      </div>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <CustomerInputAndSearch form={form} />
        </div>
        {/* Same dialog the /customer page uses — one form, one validation. */}
        <CustomerDialog
          trigger={
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Add a new customer"
            >
              <UserPlus />
            </Button>
          }
        />
      </div>
    </div>
  );
}
export function CustomerInputAndSearch({
  form,
}: {
  form: UseFormReturn<CartSchemaType>;
}) {
  const { customers, setShowCustomerInfo } = useCustomerStore();

  const customersValue = customers.map((customer) => ({
    label: customer.name,
    value: customer.id,
  }));

  return (
    <Controller
      name="customerId"
      control={form.control}
      render={({ field }) => {
        const selectedCustomer =
          customersValue.find((customer) => customer.value === field.value) ??
          null;

        return (
          <Combobox
            items={customersValue}
            value={selectedCustomer}
            onValueChange={(customer) => {
              if (!customer) {
                field.onChange(null);
                setShowCustomerInfo(null);
                return;
              }

              field.onChange(customer.value);

              const originalCustomer = customers.find(
                (c) => c.id === customer.value,
              );

              setShowCustomerInfo(originalCustomer ?? null);
            }}
            itemToStringValue={(customer) => customer.label}
          >
            <ComboboxInput
              className="w-full"
              placeholder="Select a customer"
              showClear
            />

            <ComboboxContent>
              <ComboboxEmpty>No customer found.</ComboboxEmpty>

              <ComboboxList>
                {(customer) => (
                  <ComboboxItem key={customer.value} value={customer}>
                    {customer.label}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        );
      }}
    />
  );
}
export function SaleDatePicker({
  form,
}: {
  form: UseFormReturn<CartSchemaType>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Controller
      name="saleDate"
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  id={field.name}
                  className="w-full justify-start font-normal"
                >
                  {field.value
                    ? new Date(field.value).toLocaleDateString()
                    : "Select date"}
                </Button>
              }
            />
            <PopoverContent
              className="w-auto overflow-hidden p-0"
              align="start"
            >
              <Calendar
                mode="single"
                selected={field.value ? new Date(field.value) : undefined}
                defaultMonth={field.value ? new Date(field.value) : new Date()}
                captionLayout="dropdown"
                onSelect={(date) => {
                  field.onChange(date);
                  setOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
          {fieldState.error && (
            <FieldError>{fieldState.error.message}</FieldError>
          )}
        </Field>
      )}
    />
  );
}
