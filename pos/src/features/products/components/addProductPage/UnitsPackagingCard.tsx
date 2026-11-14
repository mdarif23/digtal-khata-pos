import { useState } from "react";
import {
  Ban,
  Boxes,
  Lock,
  PackageOpen,
  Pencil,
  Plus,
  RotateCcw,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import useProductStore from "../../useProductStore";
import type { UnitOption } from "../../product.types";
import {
  buildAddPackagingUnitPayload,
  buildUpdatePackagingUnitPayload,
} from "../../uom.api.js";
import {
  useAddPackagingUnit,
  useDeactivatePackagingUnit,
  useProductUom,
  useUpdatePackagingUnit,
} from "../../hooks/useProductUom.js";
import type {
  PackagingUnitFormValues,
  ProductUomConfig,
  UomBaseUnit,
  UomConfigRow,
} from "../../uom.types.js";

/**
 * Units & Packaging (product-form section).
 *
 * The product's unitId IS its base unit — stock is always tracked there and
 * the base unit never gets a conversion row (design rule 1). Packaging
 * units are a post-create step: without a productId (create mode) the
 * section renders an informational empty state. A product with no rows is
 * a plain single-unit product and looks unchanged apart from the base-unit
 * line and the "Add packaging unit" button (zero-touch rule 2).
 */

const moneyFormatter = new Intl.NumberFormat("en-BD", {
  style: "currency",
  currency: "BDT",
  maximumFractionDigits: 2,
});

function formatMoney(value: number): string {
  return moneyFormatter.format(value);
}

function formatFactor(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : String(value);
}

/** Axios errors carry the backend's { message }; prefer it over generic ones. */
function apiErrorMessage(error: unknown, fallback: string): string {
  const message = (
    error as { response?: { data?: { message?: string } } } | null
  )?.response?.data?.message;
  return message ?? fallback;
}

const LOCKED_FACTOR_TOOLTIP =
  "Used by transactions or package barcodes — deactivate and add a new packaging unit instead";

type DialogState = { mode: "add" } | { mode: "edit"; row: UomConfigRow } | null;

export function UnitsPackagingCard({ productId }: { productId: number | null }) {
  const isCreateMode = productId === null;
  const uomQuery = useProductUom(isCreateMode ? null : productId);
  const unitOptions = useProductStore(
    (state) => state.productSelectOptions.units,
  );
  const [dialogState, setDialogState] = useState<DialogState>(null);

  const config: ProductUomConfig | undefined = uomQuery.data;
  const baseUnit = config?.baseUnit ?? null;
  const rows = config?.units ?? [];
  // Unit pickers: the base unit NEVER gets a conversion row (rule 1); units
  // that already have a row (any status) would 409 — reactivate instead.
  const configuredUnitIds = new Set(rows.map((row) => row.unitId));

  // Hooks stay unconditional; the add mutation only fires from the dialog,
  // which is never rendered in create mode.
  const addUnit = useAddPackagingUnit(productId ?? 0);
  const updateUnit = useUpdatePackagingUnit();
  const deactivateUnit = useDeactivatePackagingUnit();

  function handleDeactivate(row: UomConfigRow) {
    void toast.promise(deactivateUnit.mutateAsync(row.id), {
      loading: `Deactivating ${row.unitName}…`,
      success: (result) => result.message ?? "Packaging unit deactivated",
      error: (error: unknown) =>
        apiErrorMessage(error, "Could not deactivate the packaging unit."),
    });
  }

  function handleReactivate(row: UomConfigRow) {
    void toast.promise(
      updateUnit.mutateAsync({
        conversionId: row.id,
        payload: { status: "active" },
      }),
      {
        loading: `Reactivating ${row.unitName}…`,
        success: (result) => result.message ?? "Packaging unit reactivated",
        error: (error: unknown) =>
          apiErrorMessage(error, "Could not reactivate the packaging unit."),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Boxes className="text-blue-500" />
          Units &amp; Packaging
        </CardTitle>
        <CardDescription>
          Sell or purchase in packs, boxes, or dozens — stock stays in the base
          unit
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isCreateMode ? (
          <div
            className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
            role="note"
          >
            <PackageOpen
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                Packaging units are configured after the product exists
              </p>
              <p>
                Save the product first, then configure packaging units. The
                product unit selected above becomes the base unit — stock is
                always tracked in it.
              </p>
            </div>
          </div>
        ) : uomQuery.isPending ? (
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Spinner />
            Loading packaging units
          </div>
        ) : uomQuery.isError ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-destructive">
              Couldn’t load the packaging configuration: {uomQuery.error.message}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void uomQuery.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : (
          <>
            {/* Rule 1: the base unit is always visible, read-only. */}
            {baseUnit && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                <Badge variant="secondary">Base unit</Badge>
                <span className="font-medium">
                  {baseUnit.name}
                  {baseUnit.abbreviation ? (
                    <span className="text-muted-foreground">
                      {" "}
                      ({baseUnit.abbreviation})
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground">
                  — stock is tracked in this unit
                </span>
              </div>
            )}

            {rows.length > 0 && (
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Unit</TableHead>
                      <TableHead>Contains</TableHead>
                      <TableHead>Capabilities</TableHead>
                      <TableHead>Pricing</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <PackagingRow
                        key={row.id}
                        row={row}
                        baseUnit={baseUnit}
                        onEdit={() => setDialogState({ mode: "edit", row })}
                        onDeactivate={() => handleDeactivate(row)}
                        onReactivate={() => handleReactivate(row)}
                        actionPending={
                          deactivateUnit.isPending || updateUnit.isPending
                        }
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDialogState({ mode: "add" })}
              >
                <Plus aria-hidden="true" />
                Add packaging unit
              </Button>
              <p className="text-xs text-muted-foreground">
                e.g. 1 Box = 12{" "}
                {baseUnit?.abbreviation ?? baseUnit?.name ?? "base units"}
              </p>
            </div>
          </>
        )}
      </CardContent>

      {dialogState && !isCreateMode && (
        <PackagingUnitDialog
          key={
            dialogState.mode === "edit" ? `edit-${dialogState.row.id}` : "add"
          }
          mode={dialogState.mode}
          row={dialogState.mode === "edit" ? dialogState.row : null}
          baseUnit={baseUnit}
          unitOptions={unitOptions}
          configuredUnitIds={configuredUnitIds}
          addUnit={addUnit}
          updateUnit={updateUnit}
          onClose={() => setDialogState(null)}
        />
      )}
    </Card>
  );
}

function PackagingRow({
  row,
  baseUnit,
  onEdit,
  onDeactivate,
  onReactivate,
  actionPending,
}: {
  row: UomConfigRow;
  baseUnit: UomBaseUnit | null;
  onEdit: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  actionPending: boolean;
}) {
  const baseLabel = baseUnit?.abbreviation ?? baseUnit?.name ?? "base units";
  const isActive = row.status === "active";
  const derivedSalePrice =
    row.salePrice === null ? row.derivedSalePrice : null;
  const capabilities: string[] = [];
  if (row.isDefaultSale) capabilities.push("Default sale");
  if (row.isDefaultPurchase) capabilities.push("Default purchase");
  if (!row.isSaleEnabled) capabilities.push("Sale off");
  if (!row.isPurchaseEnabled) capabilities.push("Purchase off");

  return (
    <TableRow data-status={row.status}>
      <TableCell>
        <div className="font-medium">
          {row.unitName}
          {row.unitAbbreviation ? (
            <span className="text-muted-foreground">
              {" "}
              ({row.unitAbbreviation})
            </span>
          ) : null}
        </div>
        {row.variantId !== null && (
          <div className="text-xs text-muted-foreground">
            Variant #{row.variantId}
          </div>
        )}
      </TableCell>
      <TableCell>
        {row.isLocked ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex cursor-help items-center gap-1 underline decoration-dotted underline-offset-2" />
              }
            >
              {formatFactor(row.conversionFactor)} {baseLabel}
              <Lock
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              {LOCKED_FACTOR_TOOLTIP}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span>
            {formatFactor(row.conversionFactor)} {baseLabel}
          </span>
        )}
      </TableCell>
      <TableCell>
        {capabilities.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {capabilities.map((capability) => (
              <Badge
                key={capability}
                variant={
                  capability.startsWith("Default") ? "default" : "outline"
                }
              >
                {capability}
              </Badge>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell>
        <div className="space-y-0.5 text-sm">
          <div>
            {row.salePrice !== null ? (
              <span>Sale {formatMoney(row.salePrice)}</span>
            ) : derivedSalePrice !== null ? (
              <span className="text-muted-foreground">
                Sale ≈ {formatMoney(derivedSalePrice)} per {baseLabel}
                <span className="ms-1">(derived)</span>
              </span>
            ) : (
              <span className="text-muted-foreground">Sale: base price</span>
            )}
          </div>
          <div className="text-muted-foreground">
            {row.purchasePrice !== null
              ? `Purchase ${formatMoney(row.purchasePrice)}`
              : "Purchase: supplier price"}
          </div>
        </div>
      </TableCell>
      <TableCell>
        {isActive ? (
          <Badge
            variant="outline"
            className="border-success/30 bg-success/10 text-success"
          >
            Active
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="border-warning/30 bg-warning/10 text-warning"
          >
            Inactive
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onEdit}
            disabled={actionPending}
          >
            <Pencil aria-hidden="true" />
            Edit
          </Button>
          {isActive ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDeactivate}
              disabled={actionPending}
            >
              <Ban aria-hidden="true" />
              Deactivate
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onReactivate}
              disabled={actionPending}
            >
              <RotateCcw aria-hidden="true" />
              Reactivate
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function PackagingUnitDialog({
  mode,
  row,
  baseUnit,
  unitOptions,
  configuredUnitIds,
  addUnit,
  updateUnit,
  onClose,
}: {
  mode: "add" | "edit";
  row: UomConfigRow | null;
  baseUnit: UomBaseUnit | null;
  unitOptions: UnitOption[];
  configuredUnitIds: Set<number>;
  addUnit: ReturnType<typeof useAddPackagingUnit>;
  updateUnit: ReturnType<typeof useUpdatePackagingUnit>;
  onClose: () => void;
}) {
  const isEdit = mode === "edit" && row !== null;
  const [unitId, setUnitId] = useState<number | null>(
    isEdit && row ? row.unitId : null,
  );
  const [contains, setContains] = useState(
    isEdit && row ? String(row.conversionFactor) : "",
  );
  const [isPurchaseEnabled, setIsPurchaseEnabled] = useState(
    isEdit && row ? row.isPurchaseEnabled : false,
  );
  const [isSaleEnabled, setIsSaleEnabled] = useState(
    isEdit && row ? row.isSaleEnabled : true,
  );
  const [isDefaultPurchase, setIsDefaultPurchase] = useState(
    isEdit && row ? row.isDefaultPurchase : false,
  );
  const [isDefaultSale, setIsDefaultSale] = useState(
    isEdit && row ? row.isDefaultSale : false,
  );
  const [salePrice, setSalePrice] = useState(
    isEdit && row && row.salePrice !== null ? String(row.salePrice) : "",
  );
  const [purchasePrice, setPurchasePrice] = useState(
    isEdit && row && row.purchasePrice !== null
      ? String(row.purchasePrice)
      : "",
  );
  const [formError, setFormError] = useState<string | null>(null);

  const isLocked = isEdit && row !== null ? row.isLocked : false;
  const isPending = addUnit.isPending || updateUnit.isPending;
  const baseLabel = baseUnit?.abbreviation ?? baseUnit?.name ?? "base units";

  async function handleSubmit() {
    setFormError(null);
    if (!isEdit && unitId === null) {
      setFormError("Select a packaging unit.");
      return;
    }
    const values: PackagingUnitFormValues = {
      unitId: unitId ?? 0,
      contains,
      isPurchaseEnabled,
      isSaleEnabled,
      isDefaultPurchase,
      isDefaultSale,
      salePrice,
      purchasePrice,
    };
    try {
      if (isEdit && row) {
        await toast.promise(
          updateUnit.mutateAsync({
            conversionId: row.id,
            payload: buildUpdatePackagingUnitPayload(values, {
              includeFactor: !isLocked,
            }),
          }),
          {
            loading: `Updating ${row.unitName}…`,
            success: (result) => result.message ?? "Packaging unit updated",
            error: (error: unknown) =>
              apiErrorMessage(error, "Could not update the packaging unit."),
          },
        );
      } else {
        await toast.promise(
          addUnit.mutateAsync(buildAddPackagingUnitPayload(values)),
          {
            loading: "Adding packaging unit…",
            success: (result) => result.message ?? "Packaging unit added",
            error: (error: unknown) =>
              apiErrorMessage(error, "Could not add the packaging unit."),
          },
        );
      }
      onClose();
    } catch {
      // The promise toast displays the API error.
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit && row ? `Edit ${row.unitName}` : "Add packaging unit"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Flags and prices can change any time; the factor locks once transactions reference it."
              : `Example: 1 Box = 12 ${baseLabel}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {isEdit ? (
            <div className="grid gap-1.5">
              <Label>Unit</Label>
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                {row?.unitName}
                {row?.unitAbbreviation ? ` (${row.unitAbbreviation})` : ""}
                <span className="ms-2 text-xs text-muted-foreground">
                  can’t change
                </span>
              </div>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="packaging-unit-select">Unit</Label>
              <Select
                items={unitOptions}
                value={unitId}
                onValueChange={(value) => setUnitId(value as number | null)}
              >
                <SelectTrigger id="packaging-unit-select" className="w-full">
                  <SelectValue placeholder="Select a unit" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {unitOptions.map((unit) => {
                      const isBase =
                        baseUnit !== null && unit.value === baseUnit.id;
                      const isConfigured = configuredUnitIds.has(unit.value);
                      return (
                        <SelectItem
                          key={unit.value}
                          value={unit.value}
                          disabled={isBase || isConfigured}
                        >
                          {unit.label}
                          {isBase
                            ? " — base unit (stock unit)"
                            : isConfigured
                              ? " — already configured"
                              : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The base unit is excluded — it never gets a conversion.
              </p>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="packaging-unit-factor">
              Contains (qty of base unit)
            </Label>
            {isLocked ? (
              <Tooltip>
                <TooltipTrigger render={<div className="cursor-not-allowed" />}>
                  <Input
                    id="packaging-unit-factor"
                    type="number"
                    min="0"
                    step="any"
                    value={contains}
                    disabled
                    aria-label="Contains (qty of base unit) — locked"
                  />
                </TooltipTrigger>
                <TooltipContent className="max-w-72">
                  {LOCKED_FACTOR_TOOLTIP}
                </TooltipContent>
              </Tooltip>
            ) : (
              <Input
                id="packaging-unit-factor"
                type="number"
                min="0"
                step="any"
                placeholder={`e.g. 12 (${baseLabel})`}
                value={contains}
                onChange={(event) => setContains(event.target.value)}
              />
            )}
            <p className="text-xs text-muted-foreground">
              1 {isEdit && row ? row.unitName.toLowerCase() : "unit"} = N{" "}
              {baseLabel}
            </p>
          </div>

          <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span>
              Purchasable
              <span className="block text-xs text-muted-foreground">
                Offer this unit on purchases
              </span>
            </span>
            <Switch
              checked={isPurchaseEnabled}
              onCheckedChange={(checked) => setIsPurchaseEnabled(checked)}
              aria-label="Enable purchasing in this unit"
            />
          </label>
          <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span>
              Sellable
              <span className="block text-xs text-muted-foreground">
                Offer this unit on sales
              </span>
            </span>
            <Switch
              checked={isSaleEnabled}
              onCheckedChange={(checked) => setIsSaleEnabled(checked)}
              aria-label="Enable selling in this unit"
            />
          </label>
          <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span>
              Default purchase unit
              <span className="block text-xs text-muted-foreground">
                Pre-selected on purchase lines
              </span>
            </span>
            <Switch
              checked={isDefaultPurchase}
              onCheckedChange={(checked) => {
                setIsDefaultPurchase(checked);
                if (checked) setIsPurchaseEnabled(true);
              }}
              aria-label="Use as the default purchase unit"
            />
          </label>
          <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span>
              Default sale unit
              <span className="block text-xs text-muted-foreground">
                Pre-selected at the POS
              </span>
            </span>
            <Switch
              checked={isDefaultSale}
              onCheckedChange={(checked) => {
                setIsDefaultSale(checked);
                if (checked) setIsSaleEnabled(true);
              }}
              aria-label="Use as the default sale unit"
            />
          </label>

          <div className="grid gap-1.5">
            <Label htmlFor="packaging-unit-sale-price">
              Sale price (optional)
            </Label>
            <Input
              id="packaging-unit-sale-price"
              type="number"
              min="0"
              step="any"
              placeholder="Leave empty to derive"
              value={salePrice}
              onChange={(event) => setSalePrice(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to derive from the base price × factor
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="packaging-unit-purchase-price">
              Purchase price (optional)
            </Label>
            <Input
              id="packaging-unit-purchase-price"
              type="number"
              min="0"
              step="any"
              placeholder="Leave empty"
              value={purchasePrice}
              onChange={(event) => setPurchasePrice(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Overrides the supplier price for this unit
            </p>
          </div>
        </div>

        {formError && (
          <p className="text-sm text-destructive" role="alert">
            {formError}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isPending}
          >
            {isPending ? <Spinner /> : null}
            {isEdit ? "Save changes" : "Add packaging unit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
