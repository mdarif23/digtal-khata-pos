import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
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
import { Layers3, Pencil, Save } from "lucide-react";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { InputField } from "@/components/common/InputField";
import {
  variantTypeSchema,
  VariantTypeSchemaType,
} from "../../schemas/variant.schema";
import type { VariantOptionGroup } from "../../product.types";

export function VariantTypeDialog({ variant }: { variant?: VariantOptionGroup }) {
  const [open, setOpen] = useState(false);
  const form = useForm<VariantTypeSchemaType>({
    resolver: zodResolver(variantTypeSchema),
    defaultValues: {
      variantTypeName: variant?.typeName ?? "",
    },
  });
  const { createVariantType, updateVariantType } = productOptionActions;

  useEffect(() => {
    form.reset({
      variantTypeName: variant?.typeName ?? "",
    });
  }, [variant, form]);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      form.reset();
    }
  }

  async function onSubmit(data: VariantTypeSchemaType) {
    const isEditing = Boolean(variant);
    await createEntityPromiseToast({
      data,
      apiCall: isEditing
        ? (payload) => updateVariantType(variant!.typeId, payload)
        : createVariantType,
      entityName: "Variant Type",
      displayName: data.variantTypeName,
    });
    form.reset();
    setOpen(false);
  }

  const isSubmitting = form.formState.isSubmitting;
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <form
        id={variant ? `edit-variant-type-${variant.typeId}` : "type-form"}
        onSubmit={form.handleSubmit(onSubmit)}
      >
        <DialogTrigger
          render={
            <Button
              variant={variant ? "ghost" : "outline"}
              size={variant ? "icon-sm" : "default"}
              aria-label={variant ? `Edit ${variant.typeName}` : undefined}
            >
              {variant ? <Pencil /> : <Layers3 />}
              {!variant ? "Add Type" : null}
            </Button>
          }
        />
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{variant ? "Edit Type" : "Add Type"}</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <InputField
              name="variantTypeName"
              form={form}
              fieldLabel="Variant Type Name"
              placeholder="Type Variant Type Name"
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              disabled={isSubmitting}
              form={variant ? `edit-variant-type-${variant.typeId}` : "type-form"}
              type="submit"
            >
              {isSubmitting ? (
                <>
                  <Spinner /> {variant ? "Saving" : "Creating"}
                </>
              ) : (
                <>
                  <Save /> {variant ? "Save Changes" : "Create Type"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </form>
    </Dialog>
  );
}
