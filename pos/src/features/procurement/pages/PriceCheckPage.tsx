import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { Pencil, ScanSearch } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { SupplierDialog } from "@/features/Contacts/components/suppliers/SuppliersDialog";
import useProductStore from "@/features/products/useProductStore";
import { useContactStore } from "@/features/Contacts/useContactStore";
import { usePermissions } from "@/hooks/usePermissions";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { createEntityPromiseToast } from "@/lib/toast-utils";
import {
  formatCurrency,
  formatDate,
} from "@/features/reports/utils/reportUtils";
import { perUnitPrice } from "../utils/priceMath";
import {
  useCreateObservation,
  useDeleteObservation,
  usePriceCheckObservations,
  useUpdateObservation,
} from "../hooks/useProcurement";
import type {
  CreateObservationInput,
  ObservationRow,
  PriceCheckFilters,
  UpdateObservationInput,
} from "../api/procurement.api";

const PAGE_SIZE = 20;

const moneyString = z
  .string()
  .trim()
  .min(1, "Enter an amount")
  .refine(
    (value) => Number.isFinite(Number(value)) && Number(value) >= 0,
    "Enter a valid amount",
  );

const createObservationFormSchema = z.object({
  variantId: z.string().min(1, "Select a product variant"),
  supplierId: z.string().min(1, "Select a supplier"),
  quotedPrice: moneyString,
  packageQuantity: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? Number(value) : null))
    .refine(
      (value) => value === null || (Number.isFinite(value) && value > 0),
      "Package size must be a positive number",
    ),
  observationDate: z.string().min(1, "Pick the observation date"),
  notes: z.string().max(500, "Keep notes under 500 characters").optional(),
});
type CreateFormValues = z.input<typeof createObservationFormSchema>;
type CreateFormOutput = z.output<typeof createObservationFormSchema>;

const editObservationFormSchema = z.object({
  supplierId: z.string().min(1, "Select a supplier"),
  quotedPrice: moneyString,
  packageQuantity: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? Number(value) : null))
    .refine(
      (value) => value === null || (Number.isFinite(value) && value > 0),
      "Package size must be a positive number",
    ),
  observationDate: z.string().min(1, "Pick the observation date"),
  notes: z.string().max(500, "Keep notes under 500 characters").optional(),
});
type EditFormValues = z.input<typeof editObservationFormSchema>;
type EditFormOutput = z.output<typeof editObservationFormSchema>;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Price Check History + Quick Price Check (Smart Procurement Phase 2).
 * Records what OTHER suppliers quote at the wholesale market even when no
 * purchase happens — every row is a quotation, never a purchase.
 */
export function PriceCheckPage() {
  const [searchParams] = useSearchParams();
  const preselectedVariantId = searchParams.get("variantId");
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("purchases.price_check");

  const products = useProductStore((state) => state.products);
  const unitOptions = useProductStore(
    (state) => state.productSelectOptions.units,
  );
  const { suppliers, getSuppliers } = useContactStore();

  const [variantSearch, setVariantSearch] = useState("");
  const [search, setSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ObservationRow | null>(null);
  const [deleting, setDeleting] = useState<ObservationRow | null>(null);

  useEffect(() => {
    void getSuppliers();
  }, [getSuppliers]);

  const variantOptions = useMemo(() => {
    const options: { value: string; label: string; unitId: number | null }[] = [];
    for (const product of products) {
      for (const variant of product.variants ?? []) {
        options.push({
          value: String(variant.id),
          label: `${product.name}${variant.sku ? ` · ${variant.sku}` : ""}`,
          unitId: product.unitId ?? null,
        });
      }
    }
    return options;
  }, [products]);

  const filteredVariantOptions = useMemo(() => {
    const needle = variantSearch.trim().toLowerCase();
    if (!needle) return variantOptions;
    return variantOptions.filter((option) =>
      option.label.toLowerCase().includes(needle),
    );
  }, [variantOptions, variantSearch]);

  const unitNameFor = (variantId: string) => {
    const option = variantOptions.find((candidate) => candidate.value === variantId);
    if (!option?.unitId) return null;
    return unitOptions.find((unit) => unit.value === option.unitId)?.label ?? null;
  };

  const filters = useMemo<PriceCheckFilters>(
    () => ({
      search: search || undefined,
      supplierId: supplierFilter !== "all" ? Number(supplierFilter) : undefined,
      from: from || undefined,
      to: to || undefined,
      page,
      limit: PAGE_SIZE,
    }),
    [search, supplierFilter, from, to, page],
  );

  const { data, isLoading, isError, error } = usePriceCheckObservations(filters);
  const createObservation = useCreateObservation();
  const updateObservation = useUpdateObservation();
  const deleteObservation = useDeleteObservation();

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const createForm = useForm<CreateFormValues, unknown, CreateFormOutput>({
    resolver: zodResolver(createObservationFormSchema),
    defaultValues: {
      variantId: preselectedVariantId ?? "",
      supplierId: "",
      quotedPrice: "",
      packageQuantity: "",
      observationDate: today(),
      notes: "",
    },
  });

  // Re-prefill when navigating from a variant history page.
  useEffect(() => {
    if (preselectedVariantId) {
      createForm.setValue("variantId", preselectedVariantId);
    }
  }, [preselectedVariantId, createForm]);

  const editForm = useForm<EditFormValues, unknown, EditFormOutput>({
    resolver: zodResolver(editObservationFormSchema),
    defaultValues: { supplierId: "", quotedPrice: "", packageQuantity: "", observationDate: today(), notes: "" },
  });

  const openEdit = (row: ObservationRow) => {
    setEditing(row);
    editForm.reset({
      supplierId: row.supplierId ? String(row.supplierId) : "",
      quotedPrice: String(row.quotedPrice),
      packageQuantity: row.packageQuantity === null ? "" : String(row.packageQuantity),
      observationDate: row.observationDate,
      notes: row.notes ?? "",
    });
  };

  const onCreate = createForm.handleSubmit(async (values) => {
    const payload: CreateObservationInput = {
      variantId: Number(values.variantId),
      supplierId: Number(values.supplierId),
      quotedPrice: Number(values.quotedPrice),
      packageQuantity: values.packageQuantity,
      observationDate: values.observationDate,
      notes: values.notes?.trim() || null,
    };
    await createEntityPromiseToast({
      data: payload,
      apiCall: (input) => createObservation.mutateAsync(input),
      entityName: "Price observation",
    });
    createForm.reset({
      variantId: "",
      supplierId: "",
      quotedPrice: "",
      packageQuantity: "",
      observationDate: today(),
      notes: "",
    });
  });

  const onEdit = editForm.handleSubmit(async (values) => {
    if (!editing) return;
    const payload: UpdateObservationInput = {
      supplierId: Number(values.supplierId),
      quotedPrice: Number(values.quotedPrice),
      packageQuantity: values.packageQuantity,
      observationDate: values.observationDate,
      notes: values.notes?.trim() || null,
    };
    await createEntityPromiseToast({
      data: { id: editing.id, payload },
      apiCall: (input) =>
        updateObservation.mutateAsync({
          id: input.id,
          payload: input.payload,
        }),
      entityName: "Price observation",
      getSuccessMessage: () => "Price observation updated",
    });
    setEditing(null);
  });

  const selectedVariantId = createForm.watch("variantId");

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              Quick Price Check
              <Badge variant="secondary">Quotation</Badge>
            </CardTitle>
            <CardDescription>
              Visiting the wholesale market? Record what each shop quotes —
              even when you buy from only one of them. Quotations never count
              as purchases; they stay available for comparison.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onCreate} className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="variant-search">Product variant</FieldLabel>
                  <Input
                    id="variant-search"
                    placeholder="Search products or SKUs…"
                    value={variantSearch}
                    onChange={(event) => setVariantSearch(event.target.value)}
                  />
                  <Controller
                    control={createForm.control}
                    name="variantId"
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid}>
                        <Select
                          items={filteredVariantOptions}
                          value={field.value}
                          onValueChange={(value) => field.onChange(value ?? "")}
                        >
                          <SelectTrigger aria-label="Select product variant">
                            <SelectValue placeholder="Select a variant" />
                          </SelectTrigger>
                          <SelectContent>
                            {filteredVariantOptions.length === 0 ? (
                              <div className="px-3 py-2 text-sm text-slate-400">
                                No matching variants
                              </div>
                            ) : (
                              filteredVariantOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        {fieldState.error ? (
                          <FieldError>{fieldState.error.message}</FieldError>
                        ) : null}
                      </Field>
                    )}
                  />
                  {selectedVariantId ? (
                    <p className="text-xs text-slate-400">
                      Comparable unit: {unitNameFor(selectedVariantId) ?? "—"} —
                      packaged quotes are normalized per unit automatically.
                    </p>
                  ) : null}
                </Field>

                <Field>
                  <FieldLabel htmlFor="supplier-select">Supplier</FieldLabel>
                  <div className="flex items-center gap-2">
                    <Controller
                      control={createForm.control}
                      name="supplierId"
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid} className="flex-1">
                          <Select
                            items={suppliers.map((supplier) => ({
                              value: String(supplier.id),
                              label: supplier.name,
                            }))}
                            value={field.value}
                            onValueChange={(value) => field.onChange(value ?? "")}
                          >
                            <SelectTrigger id="supplier-select" aria-label="Select supplier">
                              <SelectValue placeholder="Select a supplier" />
                            </SelectTrigger>
                            <SelectContent>
                              {suppliers.length === 0 ? (
                                <div className="px-3 py-2 text-sm text-slate-400">
                                  No suppliers yet
                                </div>
                              ) : (
                                suppliers.map((supplier) => (
                                  <SelectItem key={supplier.id} value={String(supplier.id)}>
                                    {supplier.name}
                                  </SelectItem>
                                ))
                              )}
                            </SelectContent>
                          </Select>
                          {fieldState.error ? (
                            <FieldError>{fieldState.error.message}</FieldError>
                          ) : null}
                        </Field>
                      )}
                    />
                    <SupplierDialog />
                  </div>
                </Field>

                <Controller
                  control={createForm.control}
                  name="quotedPrice"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="quoted-price">Quoted price (৳)</FieldLabel>
                      <Input
                        id="quoted-price"
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="e.g. 1500"
                        value={field.value}
                        onChange={field.onChange}
                      />
                      {fieldState.error ? (
                        <FieldError>{fieldState.error.message}</FieldError>
                      ) : null}
                    </Field>
                  )}
                />

                <Controller
                  control={createForm.control}
                  name="packageQuantity"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="package-quantity">
                        Package size (optional)
                      </FieldLabel>
                      <Input
                        id="package-quantity"
                        type="number"
                        step="0.001"
                        min="0"
                        placeholder="e.g. 25 for a 25 Kg sack"
                        value={field.value}
                        onChange={field.onChange}
                      />
                      {fieldState.error ? (
                        <FieldError>{fieldState.error.message}</FieldError>
                      ) : null}
                    </Field>
                  )}
                />

                <Controller
                  control={createForm.control}
                  name="observationDate"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="observation-date">Observation date</FieldLabel>
                      <Input
                        id="observation-date"
                        type="date"
                        value={field.value}
                        onChange={field.onChange}
                      />
                      {fieldState.error ? (
                        <FieldError>{fieldState.error.message}</FieldError>
                      ) : null}
                    </Field>
                  )}
                />

                <Controller
                  control={createForm.control}
                  name="notes"
                  render={({ field }) => (
                    <Field>
                      <FieldLabel htmlFor="observation-notes">Notes (optional)</FieldLabel>
                      <Textarea
                        id="observation-notes"
                        rows={2}
                        placeholder="e.g. shop location, bargaining context…"
                        value={field.value}
                        onChange={field.onChange}
                      />
                    </Field>
                  )}
                />
              </div>
              <div>
                <Button type="submit" disabled={createObservation.isPending}>
                  <ScanSearch aria-hidden className="size-4" />
                  Record observation
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Quick Price Check</CardTitle>
            <CardDescription>
              You can review recorded quotations below, but recording new
              observations requires the price check permission.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Price check history</CardTitle>
          <CardDescription>
            {total} recorded quotation{total === 1 ? "" : "s"} — source:
            manual observation (actual purchases live in Product Price
            Monitoring).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              aria-label="Search observations"
              placeholder="Search product or SKU…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
            <Select
              items={[
                { value: "all", label: "All suppliers" },
                ...suppliers.map((supplier) => ({
                  value: String(supplier.id),
                  label: supplier.name,
                })),
              ]}
              value={supplierFilter}
              onValueChange={(value) => {
                setSupplierFilter(value ?? "all");
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="Filter by supplier">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All suppliers</SelectItem>
                {suppliers.map((supplier) => (
                  <SelectItem key={supplier.id} value={String(supplier.id)}>
                    {supplier.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="From date"
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
            <Input
              aria-label="To date"
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </div>

          {isError ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            >
              Could not load price check history. {getErrorMessage(error)}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="text-right">Quoted</TableHead>
                    <TableHead className="text-right">Per unit</TableHead>
                    <TableHead>Notes</TableHead>
                    {canManage ? <TableHead className="text-right">Actions</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading
                    ? Array.from({ length: 4 }).map((_, index) => (
                        <TableRow key={index}>
                          {Array.from({ length: canManage ? 7 : 6 }).map((_, cell) => (
                            <TableCell key={cell}>
                              <Skeleton className="h-4 w-full" />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    : rows.length === 0
                      ? (
                          <TableRow>
                            <TableCell colSpan={canManage ? 7 : 6}>
                              <div className="flex flex-col items-center gap-1 py-10 text-center">
                                <p className="text-sm font-medium text-slate-600">
                                  No quotations recorded yet
                                </p>
                                <p className="text-xs text-slate-400">
                                  Use Quick Price Check above after your next
                                  market visit.
                                </p>
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      : rows.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell>{formatDate(row.observationDate)}</TableCell>
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="font-medium">{row.productName}</span>
                                <span className="text-xs text-slate-400">
                                  {row.sku ?? "—"}
                                  {row.unitName ? ` · ${row.unitName}` : ""}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>{row.supplierName ?? "—"}</TableCell>
                            <TableCell className="text-right">
                              <div className="flex flex-col">
                                <span className="font-medium">
                                  {formatCurrency(row.quotedPrice)}
                                </span>
                                {row.packageQuantity !== null ? (
                                  <span className="text-xs text-slate-400">
                                    for {row.packageQuantity}
                                  </span>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              {row.unitPrice !== null ? (
                                <Badge
                                  variant="secondary"
                                  className="bg-sky-100 text-sky-700 hover:bg-sky-100"
                                >
                                  {formatCurrency(row.unitPrice)}
                                </Badge>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </TableCell>
                            <TableCell className="max-w-48 truncate text-sm text-slate-500">
                              {row.notes ?? "—"}
                            </TableCell>
                            {canManage ? (
                              <TableCell className="text-right">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Edit observation for ${row.productName}`}
                                    onClick={() => openEdit(row)}
                                  >
                                    <Pencil aria-hidden className="size-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="text-destructive"
                                    aria-label={`Delete observation for ${row.productName}`}
                                    onClick={() => setDeleting(row)}
                                  >
                                    ✕
                                  </Button>
                                </div>
                              </TableCell>
                            ) : null}
                          </TableRow>
                        ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 text-sm text-slate-500">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <span>
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || isLoading}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit price observation</DialogTitle>
          </DialogHeader>
          <form onSubmit={onEdit} className="flex flex-col gap-4">
            <Controller
              control={editForm.control}
              name="supplierId"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel>Supplier</FieldLabel>
                  <Select
                    items={suppliers.map((supplier) => ({
                      value: String(supplier.id),
                      label: supplier.name,
                    }))}
                    value={field.value}
                    onValueChange={(value) => field.onChange(value ?? "")}
                  >
                    <SelectTrigger aria-label="Select supplier">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {suppliers.map((supplier) => (
                        <SelectItem key={supplier.id} value={String(supplier.id)}>
                          {supplier.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {fieldState.error ? (
                    <FieldError>{fieldState.error.message}</FieldError>
                  ) : null}
                </Field>
              )}
            />
            <Controller
              control={editForm.control}
              name="quotedPrice"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="edit-quoted-price">Quoted price (৳)</FieldLabel>
                  <Input
                    id="edit-quoted-price"
                    type="number"
                    step="0.01"
                    min="0"
                    value={field.value}
                    onChange={field.onChange}
                  />
                  {fieldState.error ? (
                    <FieldError>{fieldState.error.message}</FieldError>
                  ) : null}
                </Field>
              )}
            />
            <Controller
              control={editForm.control}
              name="packageQuantity"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="edit-package-quantity">
                    Package size (optional)
                  </FieldLabel>
                  <Input
                    id="edit-package-quantity"
                    type="number"
                    step="0.001"
                    min="0"
                    value={field.value}
                    onChange={field.onChange}
                  />
                  {fieldState.error ? (
                    <FieldError>{fieldState.error.message}</FieldError>
                  ) : null}
                </Field>
              )}
            />
            <Controller
              control={editForm.control}
              name="observationDate"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="edit-observation-date">Observation date</FieldLabel>
                  <Input
                    id="edit-observation-date"
                    type="date"
                    value={field.value}
                    onChange={field.onChange}
                  />
                  {fieldState.error ? (
                    <FieldError>{fieldState.error.message}</FieldError>
                  ) : null}
                </Field>
              )}
            />
            <Controller
              control={editForm.control}
              name="notes"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="edit-observation-notes">Notes (optional)</FieldLabel>
                  <Textarea
                    id="edit-observation-notes"
                    rows={2}
                    value={field.value}
                    onChange={field.onChange}
                  />
                </Field>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateObservation.isPending}>
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete price observation"
        description="This permanently removes the recorded quotation. Actual purchase history is not affected."
        entityName={deleting ? `quotation for ${deleting.productName}` : ""}
        onConfirm={async () => {
          if (!deleting) return;
          await deleteObservation.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}
