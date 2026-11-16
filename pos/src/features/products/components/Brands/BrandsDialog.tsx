import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { useEffect, useState } from "react";
import { productOptionActions } from "../../hooks/useProductOptions.js";
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
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { brandSchema, BrandSchemaType } from "../../brand.schema";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { SelectOptions } from "@/components/common/SelectOptions";
import { brandsStatus } from "../../constants/status";
import type { BrandOption } from "../../product.types";

export function BrandsDialog({ brand }: { brand?: BrandOption }) {
  const [open, setOpen] = useState(false);
  const { createBrand, updateBrand } = productOptionActions;
  const form = useForm<BrandSchemaType>({
    resolver: zodResolver(brandSchema),
    defaultValues: {
      brandName: brand?.label ?? "",
      status: brand?.status ?? "active",
    },
  });

  useEffect(() => {
    form.reset({
      brandName: brand?.label ?? "",
      status: brand?.status ?? "active",
    });
  }, [brand, form]);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      form.reset();
    }
  }

  async function onSubmit(data: BrandSchemaType) {
    const isEditing = Boolean(brand);
    await createEntityPromiseToast({
      data,
      apiCall: isEditing
        ? (payload) => updateBrand(brand!.value, payload)
        : createBrand,
      entityName: "Brand",
      displayName: data.brandName,
    });
    form.reset();
    setOpen(false);
  }

  const isSubmitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <form
        id={brand ? `edit-brand-${brand.value}` : "add-brand-form"}
        onSubmit={form.handleSubmit(onSubmit)}
      >
        <DialogTrigger
          render={
            <Button
              variant={brand ? "ghost" : "outline"}
              size={brand ? "icon-sm" : "default"}
            >
              <Plus className="size-4" />
              {!brand ? "Add Brand" : null}
            </Button>
          }
        />
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{brand ? "Edit Brand" : "Add Brand"}</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Controller
              name="brandName"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={field.name}>Brand Name</FieldLabel>
                  <Input
                    id={field.name}
                    {...field}
                    placeholder="Type Brand Name"
                  />
                  {fieldState.error && (
                    <FieldError>{fieldState.error.message}</FieldError>
                  )}
                </Field>
              )}
            />
            <SelectOptions
              name="status"
              label="Status"
              form={form}
              options={brandsStatus}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              disabled={isSubmitting}
              form={brand ? `edit-brand-${brand.value}` : "add-brand-form"}
              type="submit"
            >
              {isSubmitting ? (
                <>
                  <Spinner /> {brand ? "Saving" : "Creating"}
                </>
              ) : (
                <>
                  <Save /> {brand ? "Save Changes" : "Create Brand"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </form>
    </Dialog>
  );
}
