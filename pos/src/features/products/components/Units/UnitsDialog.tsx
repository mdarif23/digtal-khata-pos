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
import { Plus, Save } from "lucide-react";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { unitSchema, UnitSchemaType } from "../../schemas/unit.schema";
import { InputField } from "@/components/common/InputField";
import type { UnitOption } from "../../product.types";

export function UnitsDialog({ unit }: { unit?: UnitOption }) {
  const [open, setOpen] = useState(false);
  const { createUnit, updateUnit } = productOptionActions;
  const form = useForm<UnitSchemaType>({
    resolver: zodResolver(unitSchema),
    defaultValues: {
      unitName: unit?.label ?? "",
      abbreviation: unit?.abbreviation ?? "",
    },
  });

  useEffect(() => {
    form.reset({
      unitName: unit?.label ?? "",
      abbreviation: unit?.abbreviation ?? "",
    });
  }, [unit, form]);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      form.reset();
    }
  }

  async function onSubmit(data: UnitSchemaType) {
    const isEditing = Boolean(unit);
    await createEntityPromiseToast({
      data,
      apiCall: isEditing
        ? (payload) => updateUnit(unit!.value, payload)
        : createUnit,
      entityName: "Unit",
      displayName: data.unitName,
    });
    form.reset();
    setOpen(false);
  }

  const isSubmitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <form
        id={unit ? `edit-unit-${unit.value}` : "unit-form"}
        onSubmit={form.handleSubmit(onSubmit)}
      >
        <DialogTrigger
          render={
            <Button
              variant={unit ? "ghost" : "outline"}
              size={unit ? "icon-sm" : "default"}
            >
              <Plus className="size-4" />
              {!unit ? "Add Unit" : null}
            </Button>
          }
        />
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{unit ? "Edit Unit" : "Add Unit"}</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <InputField
              name="unitName"
              form={form}
              fieldLabel="Unit Name"
              placeholder="Type Unit Name"
            />
            <InputField
              name="abbreviation"
              form={form}
              fieldLabel="Abbreviation"
              placeholder="Type Abbreviation"
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              disabled={isSubmitting}
              form={unit ? `edit-unit-${unit.value}` : "unit-form"}
              type="submit"
            >
              {isSubmitting ? (
                <>
                  <Spinner /> {unit ? "Saving" : "Creating"}
                </>
              ) : (
                <>
                  <Save /> {unit ? "Save Changes" : "Create Unit"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </form>
    </Dialog>
  );
}
