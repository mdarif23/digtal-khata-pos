import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { Loader2, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { useCreateWarrantyClaim } from "../hooks/useWarrantyClaims";
import { useWarrantyLookup } from "../hooks/useWarranties";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { durationLabel } from "../lib/warranty-format";
import type {
  WarrantyClaimRow,
  WarrantyListRow,
  WarrantyLookupType,
} from "../types/warranty.types";

const LOOKUP_TYPE_META: Record<
  WarrantyLookupType,
  { label: string; placeholder: string }
> = {
  serial: { label: "Serial number", placeholder: "Enter the serial number…" },
  invoice: { label: "Invoice number", placeholder: "e.g. INV-2026-000123" },
  phone: { label: "Customer phone", placeholder: "e.g. 01712345678" },
  number: { label: "Warranty number", placeholder: "e.g. WAR-2026-000123" },
};

const LOOKUP_TYPE_ORDER: WarrantyLookupType[] = [
  "serial",
  "invoice",
  "phone",
  "number",
];

const claimFormSchema = z.object({
  claimType: z.enum(["repair", "replacement", "parts_replacement", "service"]),
  reportedProblem: z
    .string()
    .trim()
    .min(5, "Describe the reported problem (at least 5 characters).")
    .max(1000, "Keep the description under 1000 characters."),
  receivedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a valid date."),
});

type ClaimFormValues = z.infer<typeof claimFormSchema>;

/** Statuses the shop can no longer claim against (backend enforces too). */
const BLOCKED_STATUSES = new Set(["voided", "replaced", "suspended"]);

function todayInputValue(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function EligibilityNotice({ warranty }: { warranty: WarrantyListRow }) {
  if (warranty.status === "expired") {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        This warranty expired
        {warranty.expiryDate ? ` on ${new Date(warranty.expiryDate).toLocaleDateString()}` : ""}.
        You can still file the claim — the shop decides whether to honour it.
      </p>
    );
  }
  if (BLOCKED_STATUSES.has(warranty.status)) {
    return (
      <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
        This warranty is {warranty.status} — no new claims can be filed against it.
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
      <ShieldCheck className="size-3.5" aria-hidden="true" />
      Warranty active — eligible for a claim
      {warranty.expiryDate ? ` until ${new Date(warranty.expiryDate).toLocaleDateString()}` : ""}.
    </p>
  );
}

interface ClaimCreationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Registry "Create claim" preselects the row and skips the search step. */
  preselectedWarranty?: WarrantyListRow | null | undefined;
  onCreated?: ((claim: WarrantyClaimRow) => void) | undefined;
}

export function ClaimCreationDialog({
  open,
  onOpenChange,
  preselectedWarranty = null,
  onCreated,
}: ClaimCreationDialogProps) {
  const [lookupType, setLookupType] = useState<WarrantyLookupType>("serial");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<WarrantyListRow | null>(null);
  const [serverError, setServerError] = useState("");

  const debouncedQuery = useDebouncedValue(query.trim());
  const lookup = useWarrantyLookup(lookupType, debouncedQuery, open && !preselectedWarranty);
  const createClaim = useCreateWarrantyClaim();

  const activeType = LOOKUP_TYPE_META[lookupType];
  const activeWarranty = preselectedWarranty ?? selected;

  const form = useForm<ClaimFormValues>({
    resolver: zodResolver(claimFormSchema),
    defaultValues: {
      claimType: "repair",
      reportedProblem: "",
      receivedDate: todayInputValue(),
    },
  });

  // Fresh state each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setServerError("");
    setSelected(null);
    setQuery("");
    setLookupType("serial");
    form.reset({
      claimType: "repair",
      reportedProblem: "",
      receivedDate: todayInputValue(),
    });
  }, [open, form]);

  const submitClaim = form.handleSubmit(async (values) => {
    if (!activeWarranty) return;
    setServerError("");
    try {
      const claim = await createClaim.mutateAsync({
        warrantyId: activeWarranty.id,
        claimType: values.claimType,
        reportedProblem: values.reportedProblem,
        receivedDate: values.receivedDate,
      });
      toast.add({
        type: "success",
        title: `Claim ${claim.claimNumber} created`,
        description: `Filed against warranty ${activeWarranty.warrantyNumber}.`,
      });
      onCreated?.(claim);
      onOpenChange(false);
    } catch (error) {
      setServerError(getErrorMessage(error));
      toast.add({ type: "error", title: "Could not create the claim", description: getErrorMessage(error) });
    }
  });

  const claimBlocked =
    activeWarranty !== null && BLOCKED_STATUSES.has(activeWarranty.status);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create warranty claim</DialogTitle>
          <DialogDescription>
            {preselectedWarranty
              ? "File a customer claim against this warranty."
              : "Find the customer's warranty, confirm eligibility, then file the claim."}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1 — find and pick the warranty (skipped when preselected) */}
        {!preselectedWarranty && (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                value={lookupType}
                onValueChange={(value) => setLookupType(value as WarrantyLookupType)}
              >
                <SelectTrigger className="sm:w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOOKUP_TYPE_ORDER.map((type) => (
                    <SelectItem key={type} value={type}>
                      {LOOKUP_TYPE_META[type].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="relative flex-1">
                <Search
                  className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={activeType.placeholder}
                  aria-label={activeType.label}
                  className="pl-8"
                />
              </div>
            </div>

            {query.trim().length > 0 && query.trim().length < 3 && (
              <p className="text-xs text-slate-400">Type at least 3 characters…</p>
            )}
            {lookup.isFetching && (
              <p className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                Searching warranties…
              </p>
            )}
            {lookup.isError && (
              <p className="text-xs text-rose-600">{getErrorMessage(lookup.error)}</p>
            )}
            {lookup.data && lookup.data.length === 0 && debouncedQuery.length >= 3 && (
              <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                No warranties matched this {activeType.label.toLowerCase()}.
              </p>
            )}
            {lookup.data && lookup.data.length > 0 && (
              <ul className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-slate-200 p-1.5">
                {lookup.data.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(row);
                        setServerError("");
                      }}
                      className={`w-full rounded-md border px-3 py-2 text-left text-xs transition ${
                        selected?.id === row.id
                          ? "border-emerald-300 bg-emerald-50"
                          : "border-transparent hover:bg-slate-50"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-slate-900">
                          {row.warrantyNumber}
                        </span>
                        <span className="font-medium capitalize text-slate-600">
                          {row.status}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-slate-500">
                        {row.productName}
                        {row.variantOptionLabel ? ` · ${row.variantOptionLabel}` : ""}
                        {row.customerName ? ` · ${row.customerName}` : ""}
                        {row.invoiceNumber ? ` · ${row.invoiceNumber}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Step 2 — eligibility + claim details */}
        {activeWarranty && (
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-xs">
              <p className="font-mono text-sm font-semibold text-slate-900">
                {activeWarranty.warrantyNumber}
              </p>
              <p className="mt-0.5 text-slate-600">
                {activeWarranty.productName}
                {activeWarranty.variantOptionLabel ? ` · ${activeWarranty.variantOptionLabel}` : ""}
              </p>
              <p className="text-slate-500">
                {activeWarranty.customerName ?? "Walk-in"} ·{" "}
                {durationLabel(activeWarranty.duration, activeWarranty.durationUnit)} ·{" "}
                Qty {activeWarranty.quantity}
              </p>
            </div>

            <EligibilityNotice warranty={activeWarranty} />

            <form className="space-y-3" onSubmit={submitClaim} noValidate>
              <Controller
                name="claimType"
                control={form.control}
                render={({ field }) => (
                  <div className="space-y-1.5">
                    <Label htmlFor="claim-type">Claim type</Label>
                    <Select
                      value={field.value}
                      onValueChange={(value) => field.onChange(value)}
                    >
                      <SelectTrigger id="claim-type" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="repair">Repair</SelectItem>
                        <SelectItem value="replacement">Replacement</SelectItem>
                        <SelectItem value="parts_replacement">
                          Parts replacement
                        </SelectItem>
                        <SelectItem value="service">Service</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              />

              <div className="space-y-1.5">
                <Label htmlFor="reported-problem">Reported problem</Label>
                <Textarea
                  id="reported-problem"
                  rows={3}
                  placeholder="What problem did the customer report?"
                  {...form.register("reportedProblem")}
                />
                {form.formState.errors.reportedProblem && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.reportedProblem.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="received-date">Item received on (optional)</Label>
                <Input
                  id="received-date"
                  type="date"
                  {...form.register("receivedDate")}
                />
                {form.formState.errors.receivedDate && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.receivedDate.message}
                  </p>
                )}
              </div>

              {serverError && (
                <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700" role="alert">
                  {serverError}
                </p>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={createClaim.isPending || claimBlocked}>
                  {createClaim.isPending && (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  )}
                  Create claim
                </Button>
              </DialogFooter>
            </form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
