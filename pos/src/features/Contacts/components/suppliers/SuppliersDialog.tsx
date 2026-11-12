import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, FieldPath, useForm, UseFormReturn } from "react-hook-form";
import { useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Plus, Save } from "lucide-react";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";

import { Spinner } from "@/components/ui/spinner";

import { createEntityPromiseToast } from "@/lib/toast-utils";
import { InputField } from "@/components/common/InputField";
import useProductStore from "@/features/products/useProductStore";
import { SelectOptions } from "@/components/common/SelectOptions";
import { entityStatus } from "@/constants/entity-status";
import {
  supplierSchema,
  SupplierSchemaTypeInput,
  SupplierSchemaTypeOutput,
} from "../../schemas/supplier.schema";
import { useContactStore } from "../../useContactStore";

export function SupplierDialog() {
  const [open, setOpen] = useState(false);
  const form = useForm<
    SupplierSchemaTypeInput,
    unknown,
    SupplierSchemaTypeOutput
  >({
    resolver: zodResolver(supplierSchema),
    defaultValues: {
      supplierName: "",
      phone: "",
      email: "",
      address: "",
      status: "active",
    },
  });
  const { createSupplier } = useContactStore();
  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      form.reset();
    }
  }
  async function onSubmit(data: SupplierSchemaTypeOutput) {
    try {
      await createEntityPromiseToast({
        data,
        apiCall: createSupplier,
        entityName: "Supplier",
        displayName: data.supplierName,
      });
      form.reset();
      setOpen(false);
    } catch {
      // The promise toast displays the API error; keep the dialog open for correction.
    }
  }
  const isSubmitting = form.formState.isSubmitting;
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline">
            <Plus />
            Add Supplier
          </Button>
        }
      />
      <DialogContent className="sm:max-w-sm">
        <form id="supplier-form" onSubmit={form.handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Add Supplier</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <InputField
              name="supplierName"
              form={form}
              fieldLabel="Supplier Name"
              placeholder="Type Supplier Name"
            />{" "}
            <InputField
              name="phone"
              form={form}
              fieldLabel="Phone"
              placeholder="Type Phone Number"
            />
            <InputField
              name="email"
              form={form}
              fieldLabel="Email"
              placeholder="Type Email"
            />
            <InputField
              name="address"
              form={form}
              fieldLabel="Address"
              placeholder="Type Address"
            />
            <SelectOptions
              name="status"
              form={form}
              label="Status"
              options={entityStatus}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />

            <Button disabled={isSubmitting} form="supplier-form" type="submit">
              {isSubmitting ? (
                <>
                  <Spinner /> Creating
                </>
              ) : (
                <>
                  <Save />
                  Create Supplier
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
