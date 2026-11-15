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
import { Pencil, Plus, Save, Trash2 } from "lucide-react";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import {
  variantOptionSchema,
  VariantOptionSchemaType,
} from "../../schemas/variant.schema";
import { VariantOptionGroup } from "../../product.types";
import { Input } from "@/components/ui/input";

type VariantOptionDialogProps = {
  activeVariant: VariantOptionGroup;
  option?: { optionId: number; value: string };
};

export function VariantOptionDialog({
  activeVariant,
  option,
}: VariantOptionDialogProps) {
  const { createVariantOption, updateVariantOption, deleteVariantOption } =
    productOptionActions;
  const [inputError, setInputError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [optionInput, setOptionInput] = useState(option?.value ?? "");
  const form = useForm<VariantOptionSchemaType>({
    resolver: zodResolver(variantOptionSchema),
    defaultValues: {
      variantOptionName: option ? [option.value] : [],
      variantTypeId: activeVariant.typeId,
    },
  });

  useEffect(() => {
    const nextValue = option ? [option.value] : [];
    form.reset({
      variantOptionName: nextValue,
      variantTypeId: activeVariant.typeId,
    });
    setOptionInput(option?.value ?? "");
  }, [activeVariant, option, form]);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      form.reset();
      setOptionInput(option?.value ?? "");
    }
  }

  async function onSubmit(data: VariantOptionSchemaType) {
    const isEditing = Boolean(option);
    await createEntityPromiseToast({
      data,
      apiCall: isEditing
        ? () => updateVariantOption(option!.optionId, data.variantOptionName[0])
        : createVariantOption,
      entityName: "Variant Option",
      displayName: data.variantOptionName.join(", "),
    });
    form.reset();
    setOptionInput("");
    setOpen(false);
  }

  const isSubmitting = form.formState.isSubmitting;
  const options = form.watch("variantOptionName") || [];
  const errors = form.formState.errors.variantOptionName;

  const handleAddOption = () => {
    if (!optionInput.trim()) {
      setInputError("Option name cannot be empty");
      return;
    }
    setInputError(null);
    form.setValue("variantOptionName", [optionInput.trim()], {
      shouldValidate: true,
    });
    setOptionInput("");
  };

  const handleRemoveOption = () => {
    form.setValue("variantOptionName", [], { shouldValidate: true });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <form id={option ? `edit-option-${option.optionId}` : "option-form"} onSubmit={form.handleSubmit(onSubmit)}>
        <DialogTrigger
          render={
            <Button
              variant={option ? "ghost" : "outline"}
              size={option ? "icon-sm" : "default"}
              aria-label={option ? `Edit ${option.value}` : undefined}
            >
              {option ? <Pencil /> : <Plus />}
              {!option ? "Add Option" : null}
            </Button>
          }
        />
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{option ? "Edit Option" : "Add Option"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-3">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Variant Type
            </span>
            <span className="text-lg font-semibold">{activeVariant.typeName}</span>
          </div>
          <div className="space-y-2">
            {options.map((value, index) => (
              <div
                className="flex items-center justify-between rounded-md border px-3 py-2"
                key={`${value}-${index}`}
              >
                <span>{value}</span>
                {!option && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleRemoveOption()}
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          <Field>
            <FieldLabel>
              {errors && <FieldError>{errors.message}</FieldError>}
              {inputError && (
                <p className="mt-1 text-sm font-medium text-destructive">{inputError}</p>
              )}
            </FieldLabel>
            <div className="flex gap-3 items-center justify-center">
              <Input
                value={optionInput}
                onChange={(event) => {
                  setOptionInput(event.target.value);
                  if (inputError) setInputError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddOption();
                  }
                }}
                placeholder="Type option and press Enter"
                type="text"
              />
              <Button type="button" onClick={handleAddOption} variant="outline">
                <Plus />
              </Button>
            </div>
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              disabled={isSubmitting}
              form={option ? `edit-option-${option.optionId}` : "option-form"}
              type="submit"
            >
              {isSubmitting ? (
                <>
                  <Spinner /> {option ? "Saving" : "Creating"}
                </>
              ) : (
                <>
                  <Save /> {option ? "Save Changes" : "Add Option"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </form>
    </Dialog>
  );
}
