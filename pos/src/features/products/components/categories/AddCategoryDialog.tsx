import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Plus, Save } from "lucide-react";
import { Controller, FieldPath, useForm, UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  addCategorySchema,
  AddCategorySchemaType,
} from "../../addCategory.schema";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { productOptionActions, EMPTY_SELECT_OPTIONS, useProductSelectOptionsQuery } from "../../hooks/useProductOptions.js";
import { Spinner } from "@/components/ui/spinner";
import { useEffect, useState } from "react";
import { addCategoryStatus } from "../../constants/status";
import { createEntityPromiseToast } from "@/lib/toast-utils";

type CategoryDraft = {
  id: number;
  name: string;
  description?: string | null;
  parentCategoryId?: number | null;
  status: "active" | "inactive";
};

type AddCategoryDialogProps = {
  existingCategory?: CategoryDraft;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function AddCategoryDialog({
  existingCategory,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: AddCategoryDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = typeof controlledOpen === "boolean";
  const open = isControlled ? controlledOpen : internalOpen;
  const form = useForm<AddCategorySchemaType>({
    resolver: zodResolver(addCategorySchema),
    defaultValues: {
      categoryName: existingCategory?.name ?? "",
      parentCategoryId: existingCategory?.parentCategoryId ?? null,
      description: existingCategory?.description ?? "",
      status: existingCategory?.status ?? "active",
    },
  });
  const { createCategory, updateCategory } = productOptionActions;
  const productSelectOptions = useProductSelectOptionsQuery().data ?? EMPTY_SELECT_OPTIONS;

  useEffect(() => {
    form.reset({
      categoryName: existingCategory?.name ?? "",
      parentCategoryId: existingCategory?.parentCategoryId ?? null,
      description: existingCategory?.description ?? "",
      status: existingCategory?.status ?? "active",
    });
  }, [existingCategory, form]);

  function handleOpenChange(nextOpen: boolean) {
    if (onOpenChange) {
      onOpenChange(nextOpen);
    }
    if (!isControlled) {
      setInternalOpen(nextOpen);
    }
    if (!nextOpen) {
      form.reset();
    }
  }

  async function onSubmit(data: AddCategorySchemaType) {
    const isEditing = Boolean(existingCategory);
    await createEntityPromiseToast({
      data,
      apiCall: isEditing
        ? (payload) => updateCategory(existingCategory!.id, payload)
        : createCategory,
      entityName: "Category",
      displayName: data.categoryName,
    });
    form.reset();
    handleOpenChange(false);
  }
  const isSubmitting = form.formState.isSubmitting;
  const filteredParentOptions = productSelectOptions.categories.filter(
    (option) => option.value !== existingCategory?.id,
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <form id={existingCategory ? `edit-category-${existingCategory.id}` : "add-category-form"} onSubmit={form.handleSubmit(onSubmit)}>
        {(!isControlled || trigger) && (
          <DialogTrigger
            render={
              trigger ?? (
                <Button variant="outline">
                  <Plus />
                  {existingCategory ? "Edit Category" : "Add Category"}
                </Button>
              )
            }
          />
        )}
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{existingCategory ? "Edit Category" : "Add Category"}</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Controller
              name="categoryName"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={field.name}>Category Name</FieldLabel>
                  <Input
                    id={field.name}
                    {...field}
                    placeholder="Type Category Name"
                  />
                  {fieldState.error && (
                    <FieldError>{fieldState.error.message}</FieldError>
                  )}
                </Field>
              )}
            />

            <AddCategorySelect
              name="parentCategoryId"
              label="Parent Category"
              form={form}
              options={filteredParentOptions.map((option) => ({
                label: option.label,
                value: option.value,
              }))}
            />
            <Controller
              name="description"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={field.name}>Description</FieldLabel>
                  <Textarea
                    id={field.name}
                    placeholder="Type your message here."
                    {...field}
                  />
                  {fieldState.error && (
                    <FieldError>{fieldState.error.message}</FieldError>
                  )}
                </Field>
              )}
            />
            <AddCategorySelect
              name="status"
              label="Status"
              form={form}
              options={addCategoryStatus}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button disabled={isSubmitting} form={existingCategory ? `edit-category-${existingCategory.id}` : "add-category-form"} type="submit">
              {isSubmitting ? (
                <>
                  <Spinner /> {existingCategory ? "Saving" : "Creating"}
                </>
              ) : (
                <>
                  <Save /> {existingCategory ? "Save Changes" : "Create Category"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </form>
    </Dialog>
  );
}

function AddCategorySelect({
  name,
  form,
  label,
  options,
}: {
  name: FieldPath<AddCategorySchemaType>;
  form: UseFormReturn<AddCategorySchemaType>;
  label: string;
  options: { label: string; value: string | number | null }[];
}) {
  const items =
    name === "parentCategoryId"
      ? [{ label: "None", value: null }, ...options]
      : options;
  return (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => {
        const selected = items.find(
          (o) => String(o.value ?? "") === String(field.value ?? ""),
        );
        return (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
            <Select
              name={field.name}
              value={field.value === null ? "" : String(field.value)}
              onValueChange={(nextValue) => {
                if (name === "parentCategoryId") {
                  field.onChange(nextValue === "" ? null : Number(nextValue));
                  return;
                }
                field.onChange(nextValue);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={label}>{selected?.label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {items.map((item) => (
                    <SelectItem key={String(item.value ?? "none")} value={String(item.value ?? "")}> 
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        );
      }}
    />
  );
}
