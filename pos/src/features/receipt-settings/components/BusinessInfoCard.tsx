import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Loader2 } from "lucide-react";
import { useBusinessProfile, useUpdateBusinessProfile } from "../hooks/useDocumentSettings.js";
import { LogoUploader } from "./LogoUploader.js";

/** Optional text field: "" / whitespace becomes null, the rest is trimmed. */
function optionalField<T extends z.ZodType>(inner: T) {
  return z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const trimmed = v.trim();
      return trimmed === "" ? null : trimmed;
    },
    inner.nullable(),
  );
}

const businessInfoSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Enter your business name")
    .max(100, "Business name is too long"),
  phone: optionalField(
    z.string().regex(/^\+?[0-9\s-]{6,20}$/, "Enter a valid phone number"),
  ),
  email: optionalField(z.email("Enter a valid email address").max(255)),
  address: optionalField(z.string().max(500, "Address is too long")),
  website: optionalField(
    z
      .string()
      .max(255, "Website is too long")
      .regex(/^https?:\/\/\S+$/i, "Use a full URL starting with http:// or https://"),
  ),
  vatBin: optionalField(z.string().max(60, "VAT/BIN number is too long")),
  tagline: optionalField(z.string().max(160, "Tagline is too long")),
});

type BusinessInfoInput = z.input<typeof businessInfoSchema>;
type BusinessInfoOutput = z.output<typeof businessInfoSchema>;

interface BusinessInfoCardProps {
  canEdit: boolean;
}

/**
 * Business Information section — the document branding source of truth.
 * Saves to the existing business profile endpoint; fields here appear on
 * receipts and invoices according to each document's visibility settings.
 */
export function BusinessInfoCard({ canEdit }: BusinessInfoCardProps) {
  const { data: business, isLoading } = useBusinessProfile();
  const update = useUpdateBusinessProfile();
  const [formKey, setFormKey] = useState(0);

  const form = useForm<BusinessInfoInput, unknown, BusinessInfoOutput>({
    resolver: zodResolver(businessInfoSchema),
    defaultValues: {
      name: "",
      phone: "",
      email: "",
      address: "",
      website: "",
      vatBin: "",
      tagline: "",
    },
    mode: "onBlur",
  });

  useEffect(() => {
    if (business) {
      form.reset({
        name: business.name ?? "",
        phone: business.phone ?? "",
        email: business.email ?? "",
        address: business.address ?? "",
        website: business.website ?? "",
        vatBin: business.vatBin ?? "",
        tagline: business.tagline ?? "",
      });
      setFormKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset when the server copy loads/changes
  }, [business?.id, business?.name, business?.phone, business?.email, business?.address, business?.website, business?.vatBin, business?.tagline]);

  const onSubmit = form.handleSubmit((values) => {
    update.mutate({
      name: values.name,
      phone: values.phone,
      email: values.email,
      address: values.address,
      website: values.website,
      vatBin: values.vatBin,
      tagline: values.tagline,
    });
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Business Information</CardTitle>
        <CardDescription>
          Shown on your receipts and invoices according to each document's
          visibility settings. This is the same profile used across ezPos.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <LogoUploader logoUrl={business?.logoUrl ?? null} disabled={!canEdit} />
        <form key={formKey} onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="biz-name">Business Name</Label>
              <Input id="biz-name" {...form.register("name")} disabled={!canEdit} />
              {form.formState.errors.name && (
                <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="biz-phone">Phone Number</Label>
              <Input id="biz-phone" placeholder="+880 1XXX-XXXXXX" {...form.register("phone")} disabled={!canEdit} />
              {form.formState.errors.phone && (
                <p className="text-xs text-destructive">{form.formState.errors.phone.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="biz-email">Email</Label>
              <Input id="biz-email" type="text" placeholder="hello@business.com" {...form.register("email")} disabled={!canEdit} />
              {form.formState.errors.email && (
                <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
              )}
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="biz-address">Address</Label>
              <Textarea id="biz-address" rows={2} {...form.register("address")} disabled={!canEdit} />
              {form.formState.errors.address && (
                <p className="text-xs text-destructive">{form.formState.errors.address.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="biz-website">Website</Label>
              <Input id="biz-website" placeholder="https://yourshop.com" {...form.register("website")} disabled={!canEdit} />
              {form.formState.errors.website && (
                <p className="text-xs text-destructive">{form.formState.errors.website.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="biz-vatbin">VAT / BIN Number</Label>
              <Input id="biz-vatbin" placeholder="BIN-0000000-0000" {...form.register("vatBin")} disabled={!canEdit} />
              {form.formState.errors.vatBin && (
                <p className="text-xs text-destructive">{form.formState.errors.vatBin.message}</p>
              )}
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="biz-tagline">Tagline (optional)</Label>
              <Input id="biz-tagline" placeholder="Quality you can trust" {...form.register("tagline")} disabled={!canEdit} />
              {form.formState.errors.tagline && (
                <p className="text-xs text-destructive">{form.formState.errors.tagline.message}</p>
              )}
            </div>
          </div>
          {canEdit && (
            <div className="flex justify-end">
              <Button type="submit" disabled={update.isPending || !form.formState.isDirty}>
                {update.isPending && <Loader2 className="size-4 animate-spin" />}
                Save Business Information
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
