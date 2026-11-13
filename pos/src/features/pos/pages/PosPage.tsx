import { useEffect, useState } from "react";
import { ProductList } from "@/features/pos/components/pos/ProductList.js";
import { SpeedKeyGrid } from "@/features/pos/speedKeys/SpeedKeyGrid";
import { CartHeader } from "@/features/pos/components/pos/CartHeader.js";
import CartItems, {
  CartCalculation,
  useCartTotals,
} from "@/features/pos/components/pos/CartItems.js";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  cartSchema,
  CartSchemaType,
  CreateSalePayload,
  createSalePayloadSchema,
} from "../schemas/cart.schema.js";
import { useHotkeyAction } from "../hotkeys/hotkeyBus";
import { PosHotkeyManager } from "../hotkeys/PosHotkeyManager";
import { usePrintReceipt } from "../hooks/usePrintReceipt";
import { CfdManageDialog } from "../cfd/CfdManageDialog";
import { SalespersonSelect } from "../components/pos/SalespersonSelect";
import { pushCfdPayloadApi } from "../cfd/cfd.api";
import { buildCfdCartPayload, buildCfdPaidPayload } from "../cfd/cfdPayload";
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
import { requestDrawerOpen } from "@/features/hardware/drawerCommands";
import { useOfflineStore } from "@/features/pos/offline/offlineStore.js";
import { useRealtimeStore } from "@/features/pos/offline/realtime.js";
import axios from "../../../api/axios.js";
import useProductStore from "@/features/products/useProductStore.js";
import { TerminalBindingDialog } from "@/features/pos/components/pos/TerminalBindingDialog.js";

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
  // Multi-terminal: catalog edits and customer creates from OTHER terminals
  // refresh this register's caches within seconds.
  const productRevision = useRealtimeStore((s) => s.productRevision);
  const customerRevision = useRealtimeStore((s) => s.customerRevision);
  useEffect(() => {
    useRealtimeStore.getState().start();
    return () => useRealtimeStore.getState().stop();
  }, []);
  useEffect(() => {
    if (stockRevision > 0 || productRevision > 0) {
      void useProductStore.getState().getProducts();
    }
  }, [stockRevision, productRevision]);
  useEffect(() => {
    if (customerRevision > 0) {
      void useCustomerStore.getState().getCustomers();
    }
  }, [customerRevision]);
  useEffect(() => {
    if (holdsRevision > 0) {
      void import("../stores/useCartStore.js").then((m) =>
        m.useHoldCartStore.getState().refreshHolds(),
      );
    }
  }, [holdsRevision]);

  // Phase 5 (Feature 13): the salesperson attributed to new sales — a
  // business member chosen per register (persisted locally).
  const [salespersonUserId, setSalespersonUserId] = useState<number | null>(() => {
    const stored = localStorage.getItem("ezpos.pos.salespersonUserId");
    return stored ? Number(stored) : null;
  });

  const form = useForm<CartSchemaType>({
    resolver: zodResolver(cartSchema),
    defaultValues: {
      saleDate: new Date(),
      customerId: null,
      salespersonUserId: salespersonUserId ?? null,
      payments: [],
      discount: null,
      vatPercent: null,
      couponCode: undefined,
    },
  });
  const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);

  // Phase 3 hotkeys: F6 payment, F7 reprint last receipt, F5 customer
  // search focus. The manager component renders the ? cheatsheet.
  useHotkeyAction("payment", () => setIsPaymentDialogOpen(true));
  useHotkeyAction("customer", () => {
    document
      .querySelector<HTMLElement>('[data-hotkey-target="customer-search"]')
      ?.focus();
  });
  const { printReceipt } = usePrintReceipt();
  useHotkeyAction("print-receipt", () => {
    if (lastReceipt) void printReceipt(lastReceipt);
  });

  // ---- Customer-facing display push (Phase 3) ----------------------------
  // Totals come from the SAME useCartTotals instance the cart panel uses —
  // server-quoted when available (tax rules, group pricing, promotions,
  // coupon), local fallback otherwise. The display must never disagree with
  // what checkout will charge.
  const cartValue = useCartStore((state) => state.cart);
  const cfdDisplayId = useCfdDisplayId();
  const totals = useCartTotals(form);
  const cartKey = JSON.stringify(
    cartValue.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discount: item.discount ?? null,
    })),
  );
  // Money signature of the totals view: covers cart discount, group pricing,
  // promotions, coupon and VAT — changes the display even when the items
  // themselves did not change.
  const totalsKey = [
    totals.itemDiscount,
    totals.cartDiscountAmount,
    totals.group?.discountAmount ?? 0,
    totals.promotions?.total ?? 0,
    totals.coupon?.discountAmount ?? 0,
    totals.vat,
    totals.finalTotal,
  ].join("|");
  useEffect(() => {
    if (cfdDisplayId === null) return;
    // The completed sale pushes its own "paid" screen with the receipt's
    // authoritative numbers — suppress the cart-clearing "idle" push while
    // the success dialog is up so the thank-you is never overwritten.
    if (isSuccessDialogOpen) return;
    const timer = setTimeout(() => {
      const payload = buildCfdCartPayload(cartValue, totals);
      void pushCfdPayloadApi(cfdDisplayId, payload).catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- totalsKey stands in for the totals object (identity changes every render)
  }, [cfdDisplayId, cartKey, cartValue, totalsKey, isSuccessDialogOpen]);

  async function onSubmit(data: CartSchemaType) {
    // Claim the checkout key before anything else: every retry of THIS
    // checkout (double-click, network failure, resubmit) reuses it, so the
    // backend replays the original sale instead of creating a duplicate.
    const idempotencyKey = useCartStore.getState().beginCheckout();
    const cartState = useCartStore.getState();
    const rawPayload = {
      ...data,
      idempotencyKey,
      // Phase 6: mandatory approval reason when a line lands below its floor.
      belowMinimumReason: cartState.belowMinimumReason.trim() || undefined,
      items: cart.map((item) => ({
        variantId: item.variants[0]?.id ?? 0,
        // Quantity is in the SELECTED unit (2 = two boxes); unitPrice is per
        // selected unit — both advisory, the server re-resolves them.
        quantity: item.quantity,
        unitPrice: item.unitPrice ?? item.variants[0]?.sellingPrice ?? 0,
        discount: item.discount ?? null,
        serialNumbers:
          item.trackingType === "serial" ? item.serialNumbers : undefined,
        uomConversionId: item.uomConversionId ?? null,
        priceOverride: item.priceOverride ?? null,
      })),
      // Phase 5 (Feature 13): salesperson attribution on the invoice.
      salespersonUserId: salespersonUserId,
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
      // a drawer/printer problem never touches the completed sale. The
      // backend authors an audited command for the paired terminal; the
      // WebUSB printer path is the fallback.
      if (
        payload.payments.some((payment) => payment.method === "cash")
      ) {
        const hardware = useHardwareStore.getState();
        if (hardware.autoDrawerKick) {
          void requestDrawerOpen({ saleId: response?.data?.sale?.id }).then(
            (result) => {
              if (result.via === "usb" && result.opened) {
                void axios
                  .post("/hardware/drawer-kick", {
                    saleInvoice: response?.data?.sale?.invoiceNumber ?? null,
                  })
                  .catch(() => undefined);
              }
              if (!result.opened && result.error) {
                toast.add({
                  title: "Drawer did not open",
                  description: result.error,
                  type: "info",
                });
              }
            },
          );
        }
      }

      // Open professional receipt confirmation dialog if receipt exists
      if (response?.data?.receipt) {
        setLastReceipt(response.data.receipt);
        setIsSuccessDialogOpen(true);
      }

      // Customer display: the authoritative post-payment screen (receipt
      // numbers, not the cart's running estimate). Fire-and-forget — a
      // display problem never touches the completed sale.
      if (cfdDisplayId !== null && response?.data?.receipt) {
        void pushCfdPayloadApi(
          cfdDisplayId,
          buildCfdPaidPayload(response.data.receipt.items, response.data.receipt),
        ).catch(() => undefined);
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
      // Phase 1: surface server rejections (e.g. require_open_drawer 409,
      // payment validation) — previously this was console-only.
      const serverMessage =
        typeof error === "object" &&
        error !== null &&
        "response" in error &&
        typeof (error as { response?: { data?: { message?: string } } }).response
          ?.data?.message === "string"
          ? (error as { response: { data: { message: string } } }).response.data
              .message
          : null;
      toast.add({
        title: serverMessage ?? "The sale could not be completed.",
        type: "error",
      });
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
            <SalespersonSelect
              value={salespersonUserId}
              onChange={(userId) => {
                setSalespersonUserId(userId);
                form.setValue("salespersonUserId", userId);
                if (userId === null) {
                  localStorage.removeItem("ezpos.pos.salespersonUserId");
                } else {
                  localStorage.setItem("ezpos.pos.salespersonUserId", String(userId));
                }
              }}
            />
            <PosHotkeyManager />
            <CfdManageDialog />
          </div>
        </div>
        <section className="flex h-[60dvh] min-h-[420px] shrink-0 flex-col overflow-hidden rounded-xl border bg-background shadow-sm lg:h-full lg:min-h-0 lg:shrink">
          {/* Page-scoped wedge capture pauses while checkout/receipt dialogs
              are up — scans must never edit the cart mid-payment. */}
          <SpeedKeyGrid />
          <ProductList
            scannerEnabled={!isPaymentDialogOpen && !isSuccessDialogOpen}
          />
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
                  totals={totals}
                />
              </div>
            </CardContent>
          </Card>
        </form>
      </div>

      {/* Multi-terminal: ask once whether this PC is a registered terminal. */}
      <TerminalBindingDialog />

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

/** Locally-persisted target display for the POS cart push (Phase 3). */
function useCfdDisplayId(): number | null {
  const [displayId, setDisplayId] = useState<number | null>(null);
  useEffect(() => {
    const stored = localStorage.getItem("ezpos.cfd.pushDisplayId");
    setDisplayId(stored ? Number(stored) : null);
    const onChange = (event: StorageEvent) => {
      if (event.key === "ezpos.cfd.pushDisplayId") {
        setDisplayId(event.newValue ? Number(event.newValue) : null);
      }
    };
    window.addEventListener("storage", onChange);
    return () => window.removeEventListener("storage", onChange);
  }, []);
  return displayId;
}
