import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format";
import {
  useShipOrder,
  useUpdateShipment,
} from "../hooks/useOnlineOrders";
import type { OrderFulfillmentSnapshot } from "../types/onlineOrders.types";

const shipSchema = z.object({
  courierName: z.string().min(1, "Courier company is required").max(120),
  courierService: z.string().max(120).optional(),
  trackingNumber: z
    .string()
    .min(1, "Tracking / consignment number is required")
    .max(120),
  expectedDeliveryDate: z.string().optional(),
  shippingCost: z.coerce.number().nonnegative("Cost must be ≥ 0").optional(),
  notes: z.string().max(1000).optional(),
  referenceUrl: z.string().max(300).optional(),
});

type ShipFormValues = z.input<typeof shipSchema>;
type ShipFormOutput = z.output<typeof shipSchema>;

const SHIPPABLE_STATES = new Set(["confirmed", "processing", "packed", "ready_to_ship"]);

interface ShippingSectionProps {
  orderId: number;
  fulfillmentStatus: string;
  snapshot: OrderFulfillmentSnapshot | undefined;
  canShip: boolean;
}

/** Shipping details (module two §6.6) — manual courier tracking; no courier
 * API is required. */
export function ShippingSection({
  orderId,
  fulfillmentStatus,
  snapshot,
  canShip,
}: ShippingSectionProps) {
  const shipment = snapshot?.shipment ?? null;
  const alreadyShipped = fulfillmentStatus === "shipped" || fulfillmentStatus === "delivered";
  const canEdit = canShip && (SHIPPABLE_STATES.has(fulfillmentStatus) || alreadyShipped);

  const shipOrder = useShipOrder();
  const updateShipment = useUpdateShipment();

  const form = useForm<ShipFormValues, unknown, ShipFormOutput>({
    resolver: zodResolver(shipSchema),
    defaultValues: {
      courierName: "",
      trackingNumber: "",
      shippingCost: 0,
    },
  });

  useEffect(() => {
    if (!shipment) return;
    form.reset({
      courierName: shipment.courierName ?? "",
      courierService: shipment.courierService ?? "",
      trackingNumber: shipment.trackingNumber ?? "",
      expectedDeliveryDate: shipment.expectedDeliveryDate
        ? shipment.expectedDeliveryDate.slice(0, 10)
        : "",
      shippingCost: shipment.shippingCost != null ? Number(shipment.shippingCost) : 0,
      notes: shipment.notes ?? "",
      referenceUrl: shipment.referenceUrl ?? "",
    });
  }, [shipment, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (alreadyShipped) {
        await updateShipment.mutateAsync({ orderId, payload: values });
        toast.add({
          type: "success",
          title: "Shipment updated",
          description: "Courier and tracking information saved.",
        });
      } else {
        await shipOrder.mutateAsync({ orderId, payload: values });
        toast.add({
          type: "success",
          title: "Order shipped",
          description: "The order was marked as shipped.",
        });
      }
    } catch (err) {
      toast.add({
        type: "error",
        title: "Could not save the shipment",
        description:
          err instanceof Error ? err.message : "Unexpected error. Try again.",
      });
    }
  });

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Shipping</h2>
          {shipment ? (
            <p className="text-xs text-muted-foreground">
              {shipment.courierName ?? "—"}
              {shipment.courierService ? ` · ${shipment.courierService}` : ""} ·
              tracking {shipment.trackingNumber ?? "—"} ·{" "}
              <span className="capitalize">{shipment.status}</span>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              No shipment recorded yet.
            </p>
          )}
        </div>
        {shipment?.shippingCost != null ? (
          <p className="text-sm font-medium tabular-nums text-foreground">
            Courier cost {formatCurrency(shipment.shippingCost)}
          </p>
        ) : null}
      </header>

      {canEdit ? (
        <form
          onSubmit={(e) => void onSubmit(e)}
          className="space-y-3 px-4 py-3"
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Courier company *
              <input
                {...form.register("courierName")}
                className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
                placeholder="Steadfast / Pathao / Sundarban"
              />
              {form.formState.errors.courierName ? (
                <span className="text-xs text-destructive">
                  {form.formState.errors.courierName.message}
                </span>
              ) : null}
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Service
              <input
                {...form.register("courierService")}
                className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
                placeholder="Same day / Standard"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Tracking / consignment *
              <input
                {...form.register("trackingNumber")}
                className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
              />
              {form.formState.errors.trackingNumber ? (
                <span className="text-xs text-destructive">
                  {form.formState.errors.trackingNumber.message}
                </span>
              ) : null}
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Expected delivery
              <input
                type="date"
                {...form.register("expectedDeliveryDate")}
                className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Courier cost (৳)
              <input
                type="number"
                step="0.01"
                {...form.register("shippingCost")}
                className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Receipt / reference URL
              <input
                {...form.register("referenceUrl")}
                className="rounded-md border border-input bg-card px-2 py-1.5 text-sm"
              />
            </label>
          </div>
          <div className="flex items-center justify-between">
            <input
              {...form.register("notes")}
              className="flex-1 rounded-md border border-input bg-card px-2 py-1.5 text-sm"
              placeholder="Courier notes…"
            />
            <Button
              type="submit"
              className="ml-3"
              disabled={shipOrder.isPending || updateShipment.isPending}
            >
              {alreadyShipped
                ? updateShipment.isPending
                  ? "Saving…"
                  : "Update shipment"
                : shipOrder.isPending
                  ? "Shipping…"
                  : "Mark as shipped"}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
