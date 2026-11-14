import { useState, type FormEvent, type ReactElement } from "react";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pencil, Plus, Save } from "lucide-react";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { useCustomerStore } from "@/store/useCustomerStore";

const customerFormSchema = z.object({
  name: z.string().trim().min(1, "Customer name is required."),
  phone: z.string().trim().min(1, "Phone number is required."),
  address: z.string().trim(),
});

const initialForm = { name: "", phone: "", address: "" };

/** Customer snapshot for the edit path (E1-004). */
export interface EditableCustomer {
  id: number;
  name: string;
  phone: string;
  address: string;
}

/**
 * Add/EDIT customer dialog (same one the /customer page uses). `trigger`
 * swaps the default labeled button — e.g. POS renders an icon-only button.
 * With `editCustomer` the dialog prefills and PATCHes the customer instead
 * of creating one (E1-004: details were permanently uncorrectable).
 */
export function CustomerDialog({
  trigger,
  editCustomer,
}: {
  trigger?: ReactElement;
  editCustomer?: EditableCustomer;
}) {
  const isEdit = editCustomer !== undefined;
  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState({
    name: editCustomer?.name ?? "",
    phone: editCustomer?.phone ?? "",
    address: editCustomer?.address ?? "",
  });
  const [formError, setFormError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const addCustomer = useCustomerStore((state) => state.addCustomer);
  const updateCustomer = useCustomerStore((state) => state.updateCustomer);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    setFormError("");
    if (!nextOpen && !isSubmitting) {
      setFormData(
        isEdit
          ? {
              name: editCustomer.name,
              phone: editCustomer.phone,
              address: editCustomer.address,
            }
          : initialForm,
      );
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = customerFormSchema.safeParse(formData);
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Check the form fields.");
      return;
    }

    setFormError("");
    setIsSubmitting(true);
    try {
      await createEntityPromiseToast({
        data: { id: isEdit ? editCustomer.id : 0, ...result.data },
        apiCall: isEdit
          ? (payload: { id: number; name: string; phone: string; address: string }) =>
              updateCustomer(payload.id, payload)
          : addCustomer,
        entityName: isEdit ? "Customer updated" : "Customer",
        displayName: result.data.name,
      });
      setFormData(initialForm);
      setOpen(false);
    } catch (error: unknown) {
      setFormError(
        getErrorMessage(error),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          trigger ??
          (isEdit ? (
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs">
              <Pencil />
              Edit
            </Button>
          ) : (
            <Button>
              <Plus />
              Add customer
            </Button>
          ))
        }
      />
      <DialogContent className="sm:max-w-lg">
        <form className="space-y-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {isEdit ? "Edit customer" : "Add customer"}
            </DialogTitle>
            <DialogDescription>
              {isEdit
                ? "Correct the customer's contact information."
                : "Add contact information to your customer directory."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="customer-name">Name</Label>
              <Input
                id="customer-name"
                autoComplete="name"
                placeholder="Customer name"
                value={formData.name}
                onChange={(event) =>
                  setFormData((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer-phone">Phone</Label>
              <Input
                id="customer-phone"
                type="tel"
                autoComplete="tel"
                placeholder="Phone number"
                value={formData.phone}
                onChange={(event) =>
                  setFormData((current) => ({
                    ...current,
                    phone: event.target.value,
                  }))
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer-address">Address</Label>
              <Input
                id="customer-address"
                autoComplete="street-address"
                placeholder="Address (optional)"
                value={formData.address}
                onChange={(event) =>
                  setFormData((current) => ({
                    ...current,
                    address: event.target.value,
                  }))
                }
              />
            </div>
            {formError ? (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                "Saving…"
              ) : (
                <>
                  <Save />
                  Save customer
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
