import { useEffect, useState } from "react";
import { ProductList } from "@/features/pos/components/pos/ProductList.js";
import { CartHeader } from "@/features/pos/components/pos/CartHeader.js";
import CartItems, {
  CartCalculation,
} from "@/features/pos/components/pos/CartItems.js";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  cartSchema,
  CartSchemaType,
  CreateSalePayload,
  createSalePayloadSchema,
} from "../schemas/cart.schema.js";
import { useCartStore } from "@/features/pos/stores/useCartStore.js";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card.js";
import { toast } from "@/components/ui/toast.js";
import { useSalesStore } from "../stores/useSalesStore.js";
import { createEntityPromiseToast } from "@/lib/toast-utils.js";
import { useCustomerStore } from "@/store/useCustomerStore.js";
import type { SaleReceiptData } from "../types/receipt.types.js";
import { SaleSuccessDialog } from "../components/receipt/SaleSuccessDialog.js";
import { LocationBadge } from "@/components/common/LocationBadge";
import { RegisterDialog } from "@/features/cashRegisters/components/RegisterDialog";
import { SyncStatusIndicator } from "@/features/pos/components/pos/SyncStatus.js";
import { NotificationBell } from "@/features/pos/components/pos/NotificationBell.js";
import { useHardwareStore } from "@/hardware/deviceManager.js";
import { useOfflineStore } from "@/features/pos/offline/offlineStore.js";
import { useRealtimeStore } from "@/features/pos/offline/realtime.js";
import axios from "../../../api/axios.js";
import { useProductStore } from "@/features/products/usedashboardProductStore.js";

function Pos() {
  const { cart, resetCart } = useCartStore();
  const { setShowCustomerInfo } = useCustomerStore();
  const { createSale } = useSalesStore();
  const [lastReceipt, setLastReceipt] = useState<SaleReceiptData | null>(null);
  const [isSuccessDialogOpen, setIsSuccessDialogOpen] = useState(false);

  // Real-time register updates (Module 11): server-pushed signals bump
  // revision counters; the affected stores refresh through their normal
  // APIs (revalidated server-side). Other registers selling at this
  // location update this register's stock view within seconds.
  const stockRevision = useRealtimeStore((s) => s.stockRevision);
  const holdsRevision = useRealtimeStore((s) => s.holdsRevision);
  const notificationRevision = useRealtimeStore((s) => s.notificationRevision);
  useEffect(() => {
    useRealtimeStore.getState().start();
    return () => useRealtimeStore.getState().stop();
  }, []);
  useEffect(() => {
    if (stockRevision > 0) {
      void useProductStore.getState().getProducts();
    }
  }, [stockRevision]);
  useEffect(() => {
    if (holdsRevision > 0) {
      void import("../stores/useCartStore.js").then((m) =>
        m.useHoldCartStore.getState().refreshHolds(),
      );
    }
  }, [holdsRevision]);

  const form = useForm<CartSchemaType>({
    resolver: zodResolver(cartSchema),
    defaultValues: {
      saleDate: new Date(),
      customerId: null,
      payments: [],
      discount: null,
      vatPercent: null,
      couponCode: undefined,
    },
  });
  const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);

  async function onSubmit(data: CartSchemaType) {
    // Claim the checkout key before anything else: every retry of THIS
    // checkout (double-click, network failure, resubmit) reuses it, so the
    // backend replays the original sale instead of creating a duplicate.
    const idempotencyKey = useCartStore.getState().beginCheckout();
    const rawPayload = {
      ...data,
      idempotencyKey,
      items: cart.map((item) => ({
        variantId: item.variants[0]?.id ?? 0,
        quantity: item.quantity,
        unitPrice: item.variants[0]?.sellingPrice ?? 0,
        discount: item.discount ?? null,
        serialNumbers:
          item.trackingType === "serial" ? item.serialNumbers : undefined,
      })),
    };

    const result = createSalePayloadSchema.safeParse(rawPayload);
    if (!result.success) {
      console.error("Payload validation failed:", result.error.flatten());
      toast.add({
        type: "error",
        description: "Cart data is invalid. Please refresh and try again.",
        priority: "high",
      });
      return;
    }

    const payload: CreateSalePayload = result.data;
    // Offline sales (Module 10): cash and due sales can be recorded without
    // connectivity — the payload (with its claimed idempotency key) goes to
    // the durable outbox and replays safely when the connection returns.
    const offlineEligible = payload.payments.every(
      (payment) => payment.method === "cash" || payment.method === "due",
    );
    const recordOffline = async () => {
      const total = payload.payments.reduce(
        (sum, payment) => sum + Number(payment.amount ?? 0),
        0,
      );
      await useOfflineStore.getState().recordOfflineSale({
        payload,
        summary: {
          total,
          itemCount: payload.items.length,
          customerName: null,
        },
      });
      toast.add({
        type: "info",
        description:
          "No connection — the sale is recorded offline and will sync automatically (duplicates are impossible).",
        priority: "high",
      });
      // Clear checkout inputs and modal
      resetCart();
      setIsPaymentDialogOpen(false);
      setShowCustomerInfo(null);
      form.reset();
    };

    if (!navigator.onLine && offlineEligible) {
      await recordOffline();
      return;
    }

    try {
      const response = await createEntityPromiseToast({
        data: payload,
        apiCall: createSale,
        entityName: "Create Sale",
        getSuccessMessage: (res) =>
          `${res.data.sale.invoiceNumber} ${res.message}`,
      });

      // Clear checkout inputs and modal
      resetCart();
      setIsPaymentDialogOpen(false);
      setShowCustomerInfo(null);
      form.reset();

      // Auto-open the drawer after cash sales (Module 9): fire-and-forget —
      // a drawer/printer problem never touches the completed sale. The kick
      // is audited server-side.
      if (
        payload.payments.some((payment) => payment.method === "cash")
      ) {
        const hardware = useHardwareStore.getState();
        if (hardware.autoDrawerKick) {
          void hardware.kickDrawer().then((result) => {
            if (result.ok) {
              void axios
                .post("/hardware/drawer-kick", { saleInvoice: response?.data?.sale?.invoiceNumber ?? null })
                .catch(() => undefined);
            }
          });
        }
      }

      // Open professional receipt confirmation dialog if receipt exists
      if (response?.data?.receipt) {
        setLastReceipt(response.data.receipt);
        setIsSuccessDialogOpen(true);
      }
    } catch (error) {
      // Connection dropped mid-checkout: cash/due sales fall back to the
      // outbox instead of losing the cart; everything else keeps the cart
      // (electronic payments genuinely need connectivity).
      const isNetworkError =
        Boolean(error) &&
        typeof error === "object" &&
        "response" in error &&
        (error as { response?: unknown }).response === undefined;
      if (isNetworkError && offlineEligible) {
        await recordOffline();
        return;
      }
      console.error("Sale submission error:", error);
    }
  }

  return (
    <main className="min-h-dvh bg-muted/40 p-3 sm:p-4 lg:h-dvh lg:min-h-0 lg:overflow-hidden">
      <div className="mx-auto flex min-h-[calc(100dvh-1.5rem)] max-w-[1800px] flex-col gap-3 sm:min-h-[calc(100dvh-2rem)] lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,1.55fr)_minmax(380px,0.9fr)] lg:gap-4">
        <div className="col-span-full flex items-center justify-between">
          <LocationBadge />
          <div className="flex items-center gap-2">
            <NotificationBell revision={notificationRevision} />
            <SyncStatusIndicator />
            <RegisterDialog />
          </div>
        </div>
        <section className="flex h-[60dvh] min-h-[420px] shrink-0 flex-col overflow-hidden rounded-xl border bg-background shadow-sm lg:h-full lg:min-h-0 lg:shrink">
          <ProductList />
        </section>

        <form
          id="cart-form"
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex min-h-[620px] flex-col lg:min-h-0"
        >
          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden shadow-sm">
            <CardHeader className="shrink-0 border-b bg-muted/20 p-4">
              <CartHeader form={form} cartItemCount={cart.length} />
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                <CartItems />
              </div>
              <div className="shrink-0 border-t bg-background p-3 sm:p-4">
                <CartCalculation
                  isPaymentDialogOpen={isPaymentDialogOpen}
                  setIsPaymentDialogOpen={setIsPaymentDialogOpen}
                  form={form}
                />
              </div>
            </CardContent>
          </Card>
        </form>
      </div>

      {/* Post-sale confirmation and receipt printing */}
      <SaleSuccessDialog
        receipt={lastReceipt}
        open={isSuccessDialogOpen}
        onOpenChange={setIsSuccessDialogOpen}
        onNewSale={() => {
          setLastReceipt(null);
          setIsSuccessDialogOpen(false);
        }}
      />
    </main>
  );
}

export default Pos;
