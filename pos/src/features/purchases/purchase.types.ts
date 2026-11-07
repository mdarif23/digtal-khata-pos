import {
  ProductType,
  ProductVariantType,
} from "../products/product.schema";
import { ReceiveItemsFormValues } from "./schemas/receiveItem.schema";

export interface PurchaseStoreType {
  id: number;
  supplierId: number | null;
  purchaseOrderNumber: string;
  purchaseDate: Date | string;
  subtotal: number;
  discount: string;
  tax: string;
  shippingCost: string;
  totalAmount: number;
  paidAmount: number;
  dueAmount: number;
  status: "ordered" | "received" | "partially_received";
  paymentStatus: "paid" | "unpaid" | "partial";
  notes: string | null;
  /** Landed-cost allocation indicator (Phase 4) — null = no document / reversed. */
  landedCostStatus?: "pending" | "allocated" | null;
  createdAt: Date;
  updatedAt: Date;
  supplierName: string | null;
  supplierPhone?: string | null;
  /** Derived (Phase 3): workflow-complete with ZERO accepted goods — never present as received. */
  fullyCancelled?: boolean;
}
export interface PurchaseCart extends Omit<ProductType, "variants"> {
  variants: [(ProductVariantType & { id: number })];
  purchaseQty: number;
  purchasePrice: number;
  purchaseDiscount: number;
  purchaseTax: number;
}
export interface PurchasesItems {
  productName: string;
  /** Variant identity from the API. */
  variantSku?: string | null | undefined;
  variantOptions?: string | undefined;
  variantName?: string | undefined;
  productUnit: string | null;
  sellingPrice: number;
  id: number;
  purchaseId: number;
  variantId: number;
  quantity: number;
  receivedQuantity: number;
  /** Quantity-discrepancy split (migration 0052). */
  deliveredQuantity: number;
  rejectedQuantity: number;
  cancelledQuantity: number;
  unitCost: number;
  discount: number;
  tax: number;
  total: number;
  productId: number;
  receiveNow: number;
  trackingType: string;
  availableStock: number | null;
}

export type RejectionCategory = "damaged" | "incorrect" | "expired" | "other";
export type OutstandingResolution = "receive_later" | "cancel" | "backordered";
export type DiscrepancyResolution = "supplier_credit" | "replacement";

export interface ResolveOutstandingInput {
  items: {
    purchaseItemId: number;
    quantity: number;
    resolution: OutstandingResolution;
    reason?: string;
  }[];
}

export interface ResolveOutstandingResponse {
  success: boolean;
  message: string;
  data: {
    purchaseId: number;
    status: string;
    resolved: {
      purchaseItemId: number;
      quantity: number;
      resolution: string;
      outstandingAfter: number;
    }[];
    cancelledValue: number;
    dueAmount: number;
    paymentStatus: string | null;
    landedCost: LandedCostFeedback;
  };
}

export interface ResolveDiscrepancyInput {
  resolution: DiscrepancyResolution;
  reason?: string;
}

export interface PurchaseReceivingRecord {
  id: number;
  purchaseItemId: number;
  variantId: number;
  locationId: number;
  deliveredQuantity: number;
  acceptedQuantity: number;
  rejectedQuantity: number;
  unitCost: number;
  rejectionCategory: string | null;
  rejectionReason: string | null;
  overReceived: boolean;
  approvalReason: string | null;
  receivedByUserId: number;
  approvedByUserId: number | null;
  createdAt: string;
}

export interface PurchaseDiscrepancy {
  id: number;
  purchaseItemId: number;
  type: "over_receival" | "shortage" | "rejection" | "cancellation";
  quantity: number;
  reason: string | null;
  category: string | null;
  status: "open" | "resolved" | "cancelled";
  resolution: string | null;
  resolvedByUserId: number | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface PurchaseListItem {
  id: number;
  purchaseOrderNumber: string;
  purchaseDate: string;
  supplierId: number | null;
  supplierName: string | null;
  supplierPhone: string | null;
  receivingStatus: "ordered" | "partially_received" | "received";
  returnStatus: "Returned" | "Partially returned" | null;
  fullyCancelled: boolean;

  totalItems: number;
  orderedQuantity: number;
  acceptedReceivedQuantity: number;
  rejectedQuantity: number;
  cancelledQuantity: number;
  returnedQuantity: number;
  outstandingQuantity: number;

  subtotal: number;
  discount: number;
  tax: number;
  shippingCost: number;
  landedCostStatus: "pending" | "allocated" | null;

  totalAmount: number;
  paidAmount: number;
  dueAmount: number;
  paymentStatus: "paid" | "unpaid" | "partial";

  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseListParams {
  page: number;
  pageSize: number;
  search?: string;
  receivingStatus?: "ordered" | "partially_received" | "received";
  returnStatus?: "Returned" | "Partially returned";
  fullyCancelled?: "true" | "false";
  supplierId?: number;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: "purchaseDate" | "totalAmount" | "dueAmount" | "purchaseOrderNumber";
  sortOrder?: "asc" | "desc";
}

export interface PurchaseListPage {
  data: PurchaseListItem[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  counts: {
    all: number;
    ordered: number;
    partially_received: number;
    received: number;
    partially_returned: number;
    returned: number;
    cancelled: number;
  };
  summary: {
    totalPurchases: number;
    awaitingReceipt: number;
    outstandingBalance: number;
  };
}

export interface PurchaseDiscrepancyResponse {
  success: boolean;
  data: {
    purchaseId: number;
    receivingRecords: PurchaseReceivingRecord[];
    discrepancies: PurchaseDiscrepancy[];
  };
}
export interface PurchasesReturnItems {
  purchaseItemId: number;
  returnQuantity: number;
  /** Identity fields from the variant-aware API. */
  variantId?: number | undefined;
  productId?: number;
  productName?: string;
  variantSku?: string | null | undefined;
  variantOptions?: string | undefined;
  variantName?: string | undefined;
}
export interface ChangedItems {
  purchaseItemId: number;
  quantity: number;
}
export interface PurchaseReturnInput {
  orderId: number;
  reason?: string;
  changedItems: ChangedItems[];
}
export interface PurchaseReturnResponse {
  success: boolean;
  message: string;
  data: {
    purchaseReturnId: number;
    totalAmount: number;
    landedCost: LandedCostFeedback;
  };
}
/** Landed-cost feedback returned by the receive backend (authoritative). */
export type LandedCostFeedback = {
  adjusted: boolean;
  amount: number;
  documentId: number | null;
};

export type ReceivePurchaseResponse = {
  success: boolean;
  message: string;
  data: {
    purchaseId: number;
    status: "received" | "partially_received";
    receivedAmount: number;
    paidAmount: number;
    dueAmount: number;
    landedCost: LandedCostFeedback;
  };
};
export type CreatePurchaseResponse = {
  success: boolean;
  message: string;
  data: {
    id: number;
    purchaseOrderNumber: string;
  };
};
export interface PurchasesStore {
  purchases: {
    orderedPurchase: PurchaseStoreType[];
    partiallyPaidPurchase: PurchaseStoreType[];
    completedPurchase: PurchaseStoreType[];
    allPurchases: PurchaseStoreType[];
  };
  purchasesItems: PurchasesItems[];
  purchasesReturnItems: PurchasesReturnItems[];
  loading: boolean;
  error: string | null;
  getPurchaseItems: () => Promise<void>;
  getPurchases: () => Promise<void>;
  getPurchasesReturnItems: () => Promise<void>;
  purchaseReturn: (
    data: PurchaseReturnInput,
  ) => Promise<PurchaseReturnResponse>;
  createReceivePurchase: (
    data: ReceiveItemsFormValues,
  ) => Promise<ReceivePurchaseResponse>;
  createPurchase: (
    data: CreatePurchaseInput,
  ) => Promise<CreatePurchaseResponse>;
}
export interface PurchaseNewProps {
  purchases: PurchaseStoreType[];
}

export interface Suppliers {
  name: string;
}
interface BaseCard {
  bg: string;
  circleBg: string;
  title: string;
}

interface TotalCard extends BaseCard {
  total: number;
}

interface StatusCard extends BaseCard {
  status: string;
}

export type PaymentsInfoCard = TotalCard | StatusCard;
export interface SummaryCardProps {
  card: PaymentsInfoCard;
  formatCurrency: (value: number) => string;
}
export interface GroupedVariantOption {
  typeName: string;
  optionsName: string[];
}
export type CreatePurchaseItem = {
  variantId: number;
  quantity: number;
  purchasePrice: number;
  discount: number;
  tax: number;
};

export type CreatePurchaseInput = {
  items: CreatePurchaseItem[];
  supplierId: number | null;
  purchaseDate: string;
  notes: string;
  discount: number;
  tax: number;
  shippingCost: number;
};
export interface ReceivePurchasePayload {
  purchaseId: number;
  items: {
    itemId: number;
    trackingType: string;
    receiveNow: number;
    unitCost: number;
    sellingPrice: number;
    batches: {
      batchNumber: string;
      quantity: number;
      manufacturedDate: Date;
      expiryDate: Date;
    }[];
    serialNumbers: string[];
  }[];
  paymentAmount: number;
  paymentMethod: string;
  paymentNotes?: string;
}
