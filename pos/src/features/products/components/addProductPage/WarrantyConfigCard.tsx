import { useState, type ReactNode } from "react";
import { Pencil, ShieldCheck, ShieldOff } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { PermissionButton } from "@/components/common/PermissionGuard";
import { usePermissions } from "@/hooks/usePermissions";
import {
  useDeleteVariantWarrantyConfig,
  useProductWarrantyConfig,
  usePutProductWarrantyConfig,
  usePutVariantWarrantyConfig,
} from "../../hooks/useProductWarrantyConfig.js";
import type {
  ProductWarrantyConfigView,
  StoredWarrantyConfig,
  VariantWarrantyView,
  WarrantyConfigWrite,
  WarrantyDurationUnit,
  WarrantyProvider,
  WarrantyType,
} from "../../warrantyConfig.types.js";
import {
  WARRANTY_DURATION_UNIT_LABELS,
  WARRANTY_DURATION_UNITS,
  WARRANTY_PROVIDER_LABELS,
  WARRANTY_PROVIDERS,
  WARRANTY_TYPE_LABELS,
  WARRANTY_TYPES,
  formatWarrantyDurationLabel,
} from "../../warrantyConfig.types.js";

/**
 * Product warranty configuration (product-form section, post-create).
 *
 * Warranty config lives on SEPARATE endpoints from the product save payload
 * (PUT /api/products/:productId/warranty-config + per-variant overrides), so
 * this card only renders when the product exists — create mode shows an
 * informational empty state, mirroring UnitsPackagingCard. A variant without
 * its own row inherits the product default; a variant row with enabled=false
 * is an explicit opt-out ("No warranty (explicit)").
 *
 * Every action requires warranty.config.manage (PermissionButton/usePermissions);
 * the backend re-verifies each request.
 */

const WARRANTY_CONFIG_PERMISSION = "warranty.config.manage";

/** Axios errors carry the backend's { message }; prefer it over generic ones. */
function apiErrorMessage(error: unknown, fallback: string): string {
  const message = (
    error as { response?: { data?: { message?: string } } } | null
  )?.response?.data?.message;
  return message ?? fallback;
}

const providerItems = WARRANTY_PROVIDERS.map((value) => ({
  value,
  label: WARRANTY_PROVIDER_LABELS[value],
}));
const typeItems = WARRANTY_TYPES.map((value) => ({
  value,
  label: WARRANTY_TYPE_LABELS[value],
}));
const unitItems = WARRANTY_DURATION_UNITS.map((value) => ({
  value,
  label: WARRANTY_DURATION_UNIT_LABELS[value],
}));

export function WarrantyConfigCard({ productId }: { productId: number | null }) {
  const isCreateMode = productId === null;
  const configQuery = useProductWarrantyConfig(isCreateMode ? null : productId);
  const perms = usePermissions();
  const canManage = perms.hasPermission(WARRANTY_CONFIG_PERMISSION);

  // Hooks stay unconditional; mutations only fire from forms/dialogs that
  // are never rendered in create mode.
  const putDefault = usePutProductWarrantyConfig(productId ?? 0);
  const putVariant = usePutVariantWarrantyConfig(productId ?? 0);
  const deleteVariantOverride = useDeleteVariantWarrantyConfig(productId ?? 0);

  // Empty state → the "Configure warranty" CTA reveals the inline form.
  const [defaultFormOpen, setDefaultFormOpen] = useState(false);
  const [overrideVariant, setOverrideVariant] = useState<VariantWarrantyView | null>(
    null,
  );

  const view: ProductWarrantyConfigView | undefined = configQuery.data;
  const productDefault = view?.productDefault ?? null;

  async function handleSaveDefault(payload: WarrantyConfigWrite) {
    try {
      await toast.promise(putDefault.mutateAsync(payload), {
        loading: "Saving warranty configuration…",
        success: () => "Warranty configuration saved",
        error: (error: unknown) =>
          apiErrorMessage(error, "Could not save the warranty configuration."),
      });
      if (productDefault === null) setDefaultFormOpen(false);
    } catch {
      // The promise toast displays the API error.
    }
  }

  async function handleSaveVariantOverride(
    variantId: number,
    payload: WarrantyConfigWrite,
  ) {
    try {
      await toast.promise(putVariant.mutateAsync({ variantId, payload }), {
        loading: "Saving variant override…",
        success: () => "Variant warranty override saved",
        error: (error: unknown) =>
          apiErrorMessage(error, "Could not save the variant override."),
      });
      setOverrideVariant(null);
    } catch {
      // The promise toast displays the API error.
    }
  }

  async function handleRemoveVariantOverride(variantId: number) {
    try {
      await toast.promise(deleteVariantOverride.mutateAsync(variantId), {
        loading: "Removing override…",
        success: () => "Override removed — the variant inherits the product default again",
        error: (error: unknown) =>
          apiErrorMessage(error, "Could not remove the variant override."),
      });
      setOverrideVariant(null);
    } catch {
      // The promise toast displays the API error.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="text-emerald-500" />
          Warranty
        </CardTitle>
        <CardDescription>
          Default warranty offered on sales of this product — variants can
          override or opt out
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isCreateMode ? (
          <div
            className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
            role="note"
          >
            <ShieldCheck
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                Warranty is configured after the product exists
              </p>
              <p>
                Save the product first, then configure its default warranty and
                any per-variant overrides.
              </p>
            </div>
          </div>
        ) : configQuery.isPending ? (
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Spinner />
            Loading warranty configuration
          </div>
        ) : configQuery.isError ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-destructive">
              Couldn’t load the warranty configuration:{" "}
              {configQuery.error.message}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void configQuery.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : (
          <>
            {/* ---- Product default ---- */}
            {productDefault === null && !defaultFormOpen ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed bg-muted/30 p-4">
                <div className="flex items-start gap-3 text-sm text-muted-foreground">
                  <ShieldOff
                    className="mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="font-medium text-foreground">
                      No warranty configured
                    </p>
                    <p>
                      Sales of this product create no warranty records. Enable
                      one to issue warranties automatically.
                    </p>
                  </div>
                </div>
                <PermissionButton
                  type="button"
                  variant="outline"
                  size="sm"
                  permission={WARRANTY_CONFIG_PERMISSION}
                  onClick={() => setDefaultFormOpen(true)}
                >
                  Configure warranty
                </PermissionButton>
              </div>
            ) : (
              <WarrantyConfigFields
                key={`default-${productDefault?.id ?? "new"}`}
                initial={productDefault}
                canManage={canManage}
                isPending={putDefault.isPending}
                onSave={(payload) => void handleSaveDefault(payload)}
                onCancel={
                  productDefault === null
                    ? () => setDefaultFormOpen(false)
                    : undefined
                }
                defaultBadge
              />
            )}

            {/* ---- Variant overrides ---- */}
            {(view?.variants.length ?? 0) > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Variants</h3>
                  <p className="text-xs text-muted-foreground">
                    Without an override a variant inherits the product default
                  </p>
                </div>
                <div className="overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Variant</TableHead>
                        <TableHead>Warranty</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {view?.variants.map((variant) => {
                        const summary = describeVariantWarranty(
                          variant,
                          productDefault,
                        );
                        return (
                          <TableRow key={variant.variantId}>
                            <TableCell className="font-medium">
                              {variant.variantName}
                            </TableCell>
                            <TableCell>
                              <div className="space-y-0.5">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span>{summary.line}</span>
                                  {variant.override !== null && (
                                    <Badge variant="secondary">Override</Badge>
                                  )}
                                </div>
                                {summary.detail && (
                                  <div className="text-xs text-muted-foreground">
                                    {summary.detail}
                                  </div>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <PermissionButton
                                type="button"
                                variant="ghost"
                                size="sm"
                                permission={WARRANTY_CONFIG_PERMISSION}
                                onClick={() => setOverrideVariant(variant)}
                              >
                                <Pencil aria-hidden="true" />
                                Edit override
                              </PermissionButton>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>

      {overrideVariant !== null && !isCreateMode && (
        <VariantOverrideDialog
          variant={overrideVariant}
          productDefault={productDefault}
          canManage={canManage}
          isPending={putVariant.isPending || deleteVariantOverride.isPending}
          onSave={(payload) =>
            void handleSaveVariantOverride(overrideVariant.variantId, payload)
          }
          onRemove={() =>
            void handleRemoveVariantOverride(overrideVariant.variantId)
          }
          onClose={() => setOverrideVariant(null)}
        />
      )}
    </Card>
  );
}

/** Human summary of what a variant's warranty does. */
function describeVariantWarranty(
  variant: VariantWarrantyView,
  productDefault: StoredWarrantyConfig | null,
): { line: string; detail?: string } {
  const detail = (config: WarrantyConfigWrite) => {
    const bits = [
      WARRANTY_PROVIDER_LABELS[config.provider],
      WARRANTY_TYPE_LABELS[config.warrantyType],
    ];
    return bits.join(" · ");
  };

  // Explicit opt-out: an override row with enabled=false.
  if (variant.override && !variant.override.enabled) {
    return { line: "No warranty (explicit)" };
  }
  if (variant.override) {
    return {
      line: formatWarrantyDurationLabel(
        variant.override.duration,
        variant.override.durationUnit,
      ),
      detail: detail(variant.override),
    };
  }
  if (productDefault && productDefault.enabled) {
    return {
      line: `Inherits product default: ${formatWarrantyDurationLabel(productDefault.duration, productDefault.durationUnit)}`,
      detail: detail(productDefault),
    };
  }
  if (productDefault) {
    return { line: "No warranty (product default off)" };
  }
  return { line: "No warranty" };
}

/**
 * The shared config fields — used inline for the product default and inside
 * the variant override dialog. duration must be a whole number 1–360
 * (backend: z.number().int().positive().max(360)).
 */
function WarrantyConfigFields({
  initial,
  canManage,
  isPending,
  onSave,
  onCancel,
  defaultBadge = false,
  saveLabel = "Save warranty",
  footerLeft,
}: {
  initial: WarrantyConfigWrite | null;
  canManage: boolean;
  isPending: boolean;
  onSave: (payload: WarrantyConfigWrite) => void;
  // `| undefined` keeps the optional props assignable under
  // exactOptionalPropertyTypes (call sites pass undefined explicitly).
  onCancel?: (() => void) | undefined;
  defaultBadge?: boolean;
  saveLabel?: string;
  footerLeft?: ReactNode | undefined;
}) {
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [provider, setProvider] = useState<WarrantyProvider>(
    initial?.provider ?? "manufacturer",
  );
  const [warrantyType, setWarrantyType] = useState<WarrantyType>(
    initial?.warrantyType ?? "comprehensive",
  );
  const [duration, setDuration] = useState(
    initial ? String(initial.duration) : "12",
  );
  const [durationUnit, setDurationUnit] = useState<WarrantyDurationUnit>(
    initial?.durationUnit ?? "months",
  );
  const [terms, setTerms] = useState(initial?.terms ?? "");
  const [formError, setFormError] = useState<string | null>(null);

  function handleSave() {
    setFormError(null);
    const parsed = Number(duration);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 360) {
      setFormError("Duration must be a whole number between 1 and 360.");
      return;
    }
    onSave({
      enabled,
      provider,
      warrantyType,
      duration: parsed,
      durationUnit,
      terms: terms.trim() === "" ? null : terms.trim(),
    });
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          {defaultBadge ? <Badge variant="secondary">Product default</Badge> : null}
          Warranty configuration
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked)}
            disabled={!canManage || isPending}
            aria-label="Enable warranty"
          />
          Enable warranty
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="warranty-provider">Provider</Label>
          <Select
            items={providerItems}
            value={provider}
            onValueChange={(value) => setProvider(value as WarrantyProvider)}
            disabled={!canManage || isPending}
          >
            <SelectTrigger id="warranty-provider" className="w-full">
              <SelectValue placeholder="Select a provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {providerItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="warranty-type">Warranty type</Label>
          <Select
            items={typeItems}
            value={warrantyType}
            onValueChange={(value) => setWarrantyType(value as WarrantyType)}
            disabled={!canManage || isPending}
          >
            <SelectTrigger id="warranty-type" className="w-full">
              <SelectValue placeholder="Select a type" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {typeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="warranty-duration">Duration</Label>
          <Input
            id="warranty-duration"
            type="number"
            min="1"
            max="360"
            step="1"
            value={duration}
            disabled={!canManage || isPending}
            onChange={(event) => setDuration(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Whole number, 1–360
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="warranty-duration-unit">Duration unit</Label>
          <Select
            items={unitItems}
            value={durationUnit}
            onValueChange={(value) =>
              setDurationUnit(value as WarrantyDurationUnit)
            }
            disabled={!canManage || isPending}
          >
            <SelectTrigger id="warranty-duration-unit" className="w-full">
              <SelectValue placeholder="Select a unit" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {unitItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="warranty-terms">Terms (optional)</Label>
        <Textarea
          id="warranty-terms"
          rows={3}
          maxLength={5000}
          placeholder="What the warranty covers, exclusions, claim process…"
          value={terms}
          disabled={!canManage || isPending}
          onChange={(event) => setTerms(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Printed on the warranty certificate; max 5000 characters
        </p>
      </div>

      {formError && (
        <p className="text-sm text-destructive" role="alert">
          {formError}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>{footerLeft}</div>
        <div className="flex flex-wrap justify-end gap-2">
          {onCancel && (
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={isPending}
            >
              Cancel
            </Button>
          )}
          {canManage ? (
            <Button
              type="button"
              onClick={handleSave}
              disabled={isPending}
            >
              {isPending ? <Spinner /> : null}
              {saveLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function VariantOverrideDialog({
  variant,
  productDefault,
  canManage,
  isPending,
  onSave,
  onRemove,
  onClose,
}: {
  variant: VariantWarrantyView;
  productDefault: StoredWarrantyConfig | null;
  canManage: boolean;
  isPending: boolean;
  onSave: (payload: WarrantyConfigWrite) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
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
            Warranty override — {variant.variantName}
          </DialogTitle>
          <DialogDescription>
            {variant.override
              ? "This variant has its own warranty; saving replaces it. Removing it makes the variant inherit the product default again."
              : "This variant inherits the product default. Save an override to give it its own warranty — switching “Enable warranty” off marks it as explicitly without warranty."}
          </DialogDescription>
        </DialogHeader>

        <WarrantyConfigFields
          key={`override-${variant.variantId}-${variant.override?.id ?? "new"}`}
          initial={variant.override ?? productDefault}
          canManage={canManage}
          isPending={isPending}
          onSave={onSave}
          saveLabel="Save override"
          footerLeft={
            variant.override !== null && canManage ? (
              <Button
                type="button"
                variant="destructive"
                onClick={onRemove}
                disabled={isPending}
              >
                {isPending ? <Spinner /> : null}
                Remove override
              </Button>
            ) : undefined
          }
        />
      </DialogContent>
    </Dialog>
  );
}
