/** Online Order Management — shared types (module one/two).
 * Mirrors the backend commerce module contracts. */

export type SalesChannel = "pos" | "woocommerce" | "custom_storefront";
export type OrderStatus =
  | "pending"
  | "completed"
  | "held"
  | "cancelled"
  | "refunded";
export type PaymentStatus = "paid" | "partial" | "unpaid";
export type FulfillmentState =
  | "unfulfilled"
  | "confirmed"
  | "processing"
  | "packed"
  | "ready_to_ship"
  | "shipped"
  | "delivered"
  | "return_requested"
  | "partially_returned"
  | "returned";

export const CHANNEL_LABELS: Record<SalesChannel, string> = {
  pos: "In-store (POS)",
  woocommerce: "WooCommerce",
  custom_storefront: "Storefront",
};

export const FULFILLMENT_LABELS: Record<FulfillmentState, string> = {
  unfulfilled: "Unfulfilled",
  confirmed: "Confirmed",
  processing: "Processing",
  packed: "Packed",
  ready_to_ship: "Ready to Ship",
  shipped: "Shipped",
  delivered: "Delivered",
  return_requested: "Return Requested",
  partially_returned: "Partially Returned",
  returned: "Returned",
};

export const PAYMENT_LABELS: Record<PaymentStatus, string> = {
  paid: "Paid",
  partial: "Partial",
  unpaid: "Unpaid",
};

export interface OnlineOrderRow {
  id: number;
  invoiceNumber: string;
  channel: SalesChannel;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentState;
  finalTotal: number | null;
  externalOrderNumber: string | null;
  customerName: string | null;
  locationName: string | null;
  createdAt: string | null;
  itemsCount: number;
}

export interface OnlineOrdersFilters {
  channel?: SalesChannel | undefined;
  status?: OrderStatus | undefined;
  fulfillmentStatus?: FulfillmentState | undefined;
  search?: string | undefined;
  locationId?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface OnlineOrdersList {
  orders: OnlineOrderRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrdersSummary {
  total: number;
  newOrders: number;
  confirmed: number;
  processing: number;
  packed: number;
  readyToShip: number;
  shipped: number;
  delivered: number;
  cancelled: number;
  returnRequests: number;
  completed: number;
  grossSales: number;
  refundedTotal: number;
  netSales: number;
  unpaidCount: number;
}

export interface OrderDetailItem {
  id: number;
  variantId: number;
  sku: string;
  productName: string;
  quantity: number;
  sellingPrice: number;
  lineTotal: number;
}

export interface OrderDetail {
  id: number;
  invoiceNumber: string;
  channel: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  subtotal: number | null;
  discount: number | null;
  vat: number | null;
  finalTotal: number | null;
  dueAmount: number | null;
  deliveryFee: number | null;
  note: string | null;
  externalOrderId: string | null;
  externalOrderNumber: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  locationName: string | null;
  shippingName: string | null;
  shippingPhone: string | null;
  shippingAddress: string | null;
  shippingCity: string | null;
  shippingArea: string | null;
  deliveryInstructions: string | null;
  createdAt: string | null;
  items: OrderDetailItem[];
}

export interface OrderTimelineEvent {
  id: number;
  eventType: string;
  previousStatus: string | null;
  newStatus: string | null;
  actorType: string;
  actorUserId: number | null;
  actorLabel: string | null;
  note: string | null;
  metadata: unknown;
  createdAt: string | null;
}

export interface OrderPackage {
  id: number;
  saleId: number;
  packageNo: number;
  packageType: string | null;
  weightKg: string | number | null;
  lengthCm: string | number | null;
  widthCm: string | number | null;
  heightCm: string | number | null;
  materialsNote: string | null;
  packingCost: string | number | null;
  packedByUserId: number | null;
  packedAt: string | null;
  notes: string | null;
  createdAt: string | null;
}

export interface OrderShipment {
  id: number;
  saleId: number;
  courierName: string | null;
  courierService: string | null;
  trackingNumber: string | null;
  shipmentDate: string | null;
  expectedDeliveryDate: string | null;
  shippingCost: string | number | null;
  status: string;
  notes: string | null;
  referenceUrl: string | null;
}

export interface OrderFulfillmentItem {
  saleItemId: number;
  variantId: number;
  productName: string;
  sku: string | null;
  quantity: number;
  stockAtLocation: number | null;
}

export interface OrderFulfillmentSnapshot {
  fulfillmentStatus: string;
  packages: OrderPackage[];
  shipment: OrderShipment | null;
  items: OrderFulfillmentItem[];
}

export interface PackagingDefaults {
  totalWeightKg: number;
  isFragile: boolean;
  packagingInstructions: string[];
  handlingInstructions: string[];
}

export interface PackageInput {
  packageType?: string | undefined;
  weightKg?: number | undefined;
  lengthCm?: number | undefined;
  widthCm?: number | undefined;
  heightCm?: number | undefined;
  materialsNote?: string | undefined;
  packingCost?: number | undefined;
  notes?: string | undefined;
}

export interface ShipmentInput {
  courierName?: string | undefined;
  courierService?: string | undefined;
  trackingNumber?: string | undefined;
  expectedDeliveryDate?: string | undefined;
  shippingCost?: number | undefined;
  notes?: string | undefined;
  referenceUrl?: string | undefined;
}

export interface DeliverInput {
  codCollected?: boolean | undefined;
  codAmount?: number | undefined;
  codMethod?: "cash" | "bangla_qr" | "card" | "sslcommerz" | undefined;
  codReference?: string | undefined;
}

export interface MarkPaidInput {
  method?: "cash" | "bangla_qr" | "card" | "sslcommerz" | undefined;
  reference?: string | undefined;
  amount?: number | undefined;
}
