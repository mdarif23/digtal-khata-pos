import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { formatCurrency } from "@/lib/format";
import {
  useAddPackage,
  usePackagingDefaults,
  useRemovePackage,
  useUpdatePackage,
} from "../hooks/useOnlineOrders";
import type { OrderFulfillmentSnapshot } from "../types/onlineOrders.types";

const packageSchema = z.object({
  packageType: z.string().max(50).optional(),
  weightKg: z.coerce.number().nonnegative("Weight must be ≥ 0").optional(),
  lengthCm: z.coerce.number().nonnegative().optional(),
  widthCm: z.coerce.number().nonnegative().optional(),
  heightCm: z.coerce.number().nonnegative().optional(),
  materialsNote: z.string().max(1000).optional(),
  packingCost: z.coerce.number().nonnegative("Cost must be ≥ 0").optional(),
  notes: z.string().max(1000).optional(),
});

type PackageFormValues = z.input<typeof packageSchema>;
type PackageFormOutput = z.output<typeof packageSchema>;

const EDITABLE_STATES = new Set([
  "unfulfilled",
  "confirmed",
  "processing",
  "packed",
  "ready_to_ship",
]);

interface PackagingSectionProps {
  orderId: number;
  fulfillmentStatus: string;
  snapshot: OrderFulfillmentSnapshot | undefined;
  canPack: boolean;
}

export function PackagingSection({
  orderId,
  fulfillmentStatus,
  snapshot,
  canPack,
}: PackagingSectionProps) {
  const editable = EDITABLE_STATES.has(fulfillmentStatus);
  const defaults = usePackagingDefaults(orderId, editable);
  const addPackage = useAddPackage();
  const updatePackage = useUpdatePackage();
  const removePackage = useRemovePackage();
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);

  const form = useForm<PackageFormValues, unknown, PackageFormOutput>({
    resolver: zodResolver(packageSchema),
    defaultValues: { packageType: "box", packingCost: 0 },
  });

  // Prefill from product-level shipping & packaging defaults (§6.4).
  useEffect(() => {
    const d = defaults.data;
    if (!d || !editable) return;
    if (!form.getValues("weightKg")) {
      form.setValue("weightKg", d.totalWeightKg || undefined);
    }
  }, [defaults.data, editable, form]);

  const onAdd = form.handleSubmit(async (values) => {
    try {
      await addPackage.mutateAsync({ orderId, payload: values });
      toast.add({
        type: "success",
        title: "Package recorded",
        description: "The package was added to the order.",
      });
      form.reset({ packageType: "box", packingCost: 0 });
    } catch (err) {
      toast.add({
        type: "error",
        title: "Could not record the package",
        description:
          err instanceof Error ? err.message : "Unexpected error. Try again.",
      });
    }
  });

  const packages = snapshot?.packages ?? [];
  const totalCost = packages.reduce(
    (sum, p) => sum + Number(p.packingCost ?? 0),
    0,
  );
  const totalWeight = packages.reduce(
    (sum, p) => sum + Number(p.weightKg ?? 0),
    0,
  );

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Packaging</h2>
          <p className="text-xs text-muted-foreground">
            {packages.length} package{packages.length === 1 ? "" : "s"} ·{" "}
            {totalWeight.toFixed(2)} kg · packing cost {formatCurrency(totalCost)}
            {defaults.data?.isFragile ? " · ⚠ fragile items" : ""}
          </p>
        </div>
      </header>

      <div className="divide-y divide-border">
        {packages.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            No packages recorded yet — record at least one package before
            marking the order ready to ship.
          </p>
        ) : (
          packages.map((pkg) => (
            <div
              key={pkg.id}
              className="flex items-start justify-between px-4 py-3 text-sm"
            >
              <div>
                <p className="font-medium text-foreground">
                  Package #{pkg.packageNo}
                  {pkg.packageType ? ` · ${pkg.packageType}` : ""}
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {pkg.weightKg ? `${Number(pkg.weightKg)} kg · ` : ""}
                  {pkg.lengthCm && pkg.widthCm && pkg.heightCm
                    ? `${Number(pkg.lengthCm)}×${Number(pkg.widthCm)}×${Number(pkg.heightCm)} cm · `
                    : ""}
                  {pkg.packingCost ? `${formatCurrency(pkg.packingCost)} · ` : ""}
                  {pkg.materialsNote ?? pkg.notes ?? ""}
                </p>
              </div>
              {canPack && editable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="text-destructive"
                  onClick={() => setDeleteTarget(pkg.id)}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))
        )}
      </div>

      {canPack && editable ? (
        <form
          onSubmit={(e) => void onAdd(e)}
          className="space-y-3 border-t border-border bg-muted/60 px-4 py-3"
        >
          {defaults.data && defaults.data.handlingInstructions.length > 0 ? (
            <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
              Handling: {defaults.data.handlingInstructions.join(" · ")}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Package type
              <input
                {...form.register("packageType")}
                className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
                placeholder="box / poly bag"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Weight (kg)
              <input
                type="number"
                step="0.001"
                {...form.register("weightKg")}
                className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              L×W×H (cm)
              <div className="flex gap-1">
                <input
                  type="number"
                  step="0.01"
                  {...form.register("lengthCm")}
                  className="w-full rounded-md border border-input bg-card px-1.5 py-1.5 text-sm"
                  placeholder="L"
                />
                <input
                  type="number"
                  step="0.01"
                  {...form.register("widthCm")}
                  className="w-full rounded-md border border-input bg-card px-1.5 py-1.5 text-sm"
                  placeholder="W"
                />
                <input
                  type="number"
                  step="0.01"
                  {...form.register("heightCm")}
                  className="w-full rounded-md border border-input bg-card px-1.5 py-1.5 text-sm"
                  placeholder="H"
                />
              </div>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Packing cost (৳)
              <input
                type="number"
                step="0.01"
                {...form.register("packingCost")}
                className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
              Materials / notes
              <input
                {...form.register("materialsNote")}
                className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-sm"
                placeholder="Bubble wrap, 2 boxes…"
              />
            </label>
            <Button
              type="submit"
              className="mt-4"
              disabled={addPackage.isPending}
            >
              {addPackage.isPending ? "Saving…" : "Add package"}
            </Button>
          </div>
          {form.formState.errors.weightKg ? (
            <p className="text-xs text-destructive">
              {form.formState.errors.weightKg.message}
            </p>
          ) : null}
        </form>
      ) : null}

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Remove package"
        description="This removes the package record from the order. This cannot be undone."
        entityName="package"
        onConfirm={async () => {
          if (deleteTarget === null) return;
          try {
            await removePackage.mutateAsync({
              orderId,
              packageId: deleteTarget,
            });
            toast.add({ type: "success", title: "Package removed" });
          } finally {
            setDeleteTarget(null);
          }
        }}
      />
    </section>
  );
}
