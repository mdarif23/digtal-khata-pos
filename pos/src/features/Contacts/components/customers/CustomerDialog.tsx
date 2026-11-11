import { useState, type FormEvent, type ReactElement } from "react";
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
import { Plus, Save } from "lucide-react";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import { useCustomerStore } from "@/store/useCustomerStore";

const customerFormSchema = z.object({
  name: z.string().trim().min(1, "Customer name is required."),
  phone: z.string().trim().min(1, "Phone number is required."),
  address: z.string().trim(),
});

const initialForm = { name: "", phone: "", address: "" };

/**
 * Add-customer dialog (same one the /customer page uses). `trigger` swaps
 * the default labeled button — e.g. POS renders an icon-only button.
 */
export function CustomerDialog({ trigger }: { trigger?: ReactElement }) {
  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState(initialForm);
  const [formError, setFormError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const addCustomer = useCustomerStore((state) => state.addCustomer);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    setFormError("");
    if (!nextOpen && !isSubmitting) setFormData(initialForm);
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
        data: { id: 0, ...result.data },
        apiCall: addCustomer,
        entityName: "Customer",
        displayName: result.data.name,
      });
      setFormData(initialForm);
      setOpen(false);
    } catch (error: unknown) {
      setFormError(
        error instanceof Error ? error.message : "Could not create customer.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          trigger ?? (
            <Button>
              <Plus />
              Add customer
            </Button>
          )
        }
      />
      <DialogContent>
        <form className="space-y-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add customer</DialogTitle>
            <DialogDescription>
              Add contact information to your customer directory.
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
