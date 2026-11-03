import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Truck } from "lucide-react";
import type { UseFormReturn } from "react-hook-form";
import type { ProductTypeInput } from "../../product.schema";

/** Shipping & Packaging defaults (online orders §6.4). These are DEFAULTS —
 * they are copied into each order's package record at pack time; editing
 * them never rewrites an already-processed order. */
export function ShippingInfoCard({
  form,
}: {
  form: UseFormReturn<ProductTypeInput>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Truck className="text-blue-500" />
          Shipping &amp; Packaging
        </CardTitle>
        <CardDescription>
          Defaults for online orders — copied into each order when packing
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-600">Weight (kg)</span>
          <input
            type="number"
            step="0.001"
            min="0"
            {...form.register("shippingWeightKg")}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            placeholder="e.g. 0.5"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-600">Length (cm)</span>
          <input
            type="number"
            step="0.01"
            min="0"
            {...form.register("shippingLengthCm")}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-600">Width (cm)</span>
          <input
            type="number"
            step="0.01"
            min="0"
            {...form.register("shippingWidthCm")}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-600">Height (cm)</span>
          <input
            type="number"
            step="0.01"
            min="0"
            {...form.register("shippingHeightCm")}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="col-span-1 flex flex-col gap-1 text-sm md:col-span-2">
          <span className="font-medium text-slate-600">Packaging instructions</span>
          <textarea
            rows={2}
            {...form.register("packagingInstructions")}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            placeholder="Bubble-wrap the unit, include manual…"
          />
        </label>
        <label className="col-span-1 flex flex-col gap-1 text-sm md:col-span-2">
          <span className="font-medium text-slate-600">Special handling</span>
          <textarea
            rows={2}
            {...form.register("handlingInstructions")}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            placeholder="Keep upright, fragile…"
          />
        </label>
        <label className="col-span-1 flex items-center gap-2 text-sm md:col-span-2 lg:col-span-4">
          <input type="checkbox" {...form.register("isFragile")} className="h-4 w-4" />
          <span className="font-medium text-slate-600">
            Fragile item — highlight on packing
          </span>
        </label>
      </CardContent>
    </Card>
  );
}
