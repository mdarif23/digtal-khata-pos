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
  /**
   * UOM (migration 0062): the packaging unit the line is entered in.
   * Null = the product's base unit. purchaseQty/purchasePrice are in THIS
   * unit; the server converts authoritatively from uomConversionId.
   */
  uomConversionId: number | null;
  unitName: string;
  /** Base units per selected unit (1 for the base). */
  conversionFactor: number;
  /**
   * False while the async default-purchase-unit resolution is still allowed
   * to overwrite the prefill; set once the operator edits any line field.
   */
  unitTouched: boolean;
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
  /**
   * UOM snapshot on the ORDER line (migration 0062). quantity/unitCost are
   * stored BASE figures; enteredQuantity/enteredUnitPrice preserve what the
   * operator ordered in uomConversionId's unit (null = base-ordered line).
   */
  uomConversionId: number | null;
  enteredQuantity: number | null;
  enteredUnitPrice: number | null;
  conversionFactor: number | null;
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

/** Purchase details drawer (Phase 11): one item line of GET /purchases/:id. */
export interface PurchaseDetailItem {
  id: number;
  purchaseId: number;
  variantId: number;
  productId: number;
  productName: string;
  variantSku: string | null;
  variantName: string;
  variantOptions: string | undefined;
  productUnit: string | null;
  trackingType: string;
  quantity: number;
  receivedQuantity: number;
  rejectedQuantity: number;
  cancelledQuantity: number;
  unitCost: number;
  discount: number;
  tax: number;
  sellingPrice: number;
  availableStock: number | null;
  /**
   * UOM snapshot on the order line (migration 0062): the unit the operator
   * ordered in, with the entered quantity/price they typed. Null entered
   * figures = a legacy base-ordered line (drawers render it unchanged).
   */
  uomConversionId: number | null;
  enteredQuantity: number | null;
  enteredUnitPrice: number | null;
  conversionFactor: number | null;
}

/**
 * Return-module context (Phase 1): return eligibility is evaluated at the
 * purchase's RECEIVING location — never the caller's active location. The
 * return service deducts stock there, so availability, previously-returned
 * quantities and clamps must come from this context.
 */
export interface PurchaseReturnContextItem {
  purchaseItemId: number;
  orderedQuantity: number;
  receivedQuantity: number;
  returnedQuantity: number;
  /** Stock of the line's VARIANT at the receiving location. */
  availableStock: number;
}

export interface PurchaseReturnContext {
  locationId: number | null;
  locationName: string | null;
  canReturn: boolean;
  reason: "no_supplier" | "not_received" | null;
  items: PurchaseReturnContextItem[];
}

/** Phase 5: in-stock serials eligible for return, per serial-tracked line. */
export interface ReturnableSerials {
  purchaseId: number;
  items: {
    purchaseItemId: number;
    serials: { id: number; serialNumber: string }[];
  }[];
}

/** GET /purchases/:id — the drawer's payload (header mirrors the list row
 *  plus the raw receiving `status`, so the two views can never disagree). */
export interface PurchaseDetail {
  purchase: {
    id: number;
    purchaseOrderNumber: string;
    purchaseDate: string;
    supplierId: number | null;
    supplierName: string | null;
    supplierPhone: string | null;
    status: "ordered" | "partially_received" | "received";
    returnStatus: "Returned" | "Partially returned" | null;
    landedCostStatus: "pending" | "allocated" | null;
    subtotal: number;
    discount: number;
    tax: number;
    shippingCost: number;
    totalAmount: number;
    paidAmount: number;
    dueAmount: number;
    paymentStatus: "paid" | "unpaid" | "partial";
    notes: string | null;
    /** Phase 3: the supplier's recorded credit balance (returns +
     *  cancellations). Credit-only ledger, nothing consumes credits —
     *  presentation only, never treated as cash. */
    supplierCreditBalance: number;
  };
  items: PurchaseDetailItem[];
  returnContext: PurchaseReturnContext;
}

/**
 * Server-authoritative return preview (Phase 2): what THIS return would
 * pay, computed by the same pure valuation the committing return uses.
 * Informational — the submission recalculates transactionally.
 */
export interface PurchaseReturnPreview {
  purchaseId: number;
  canSubmit: boolean;
  issues: string[];
  quantities: {
    purchaseItemId: number;
    orderedQuantity: number;
    receivedQuantity: number;
    previouslyReturned: number;
    eligibleQuantity: number;
    availableStock: number;
    requestedQuantity: number;
    remainingAfterReturn: number;
  }[];
  goodsCredit: {
    total: number;
    lineCredits: {
      purchaseItemId: number;
      quantity: number;
      goodsCredit: number;
    }[];
  };
  landedCost: {
    applies: boolean;
    state: "no_document" | "draft" | "posted" | "adjusted" | "reversed";
    expectedReversal: number;
    pendingAllocation: number | null;
    reason: string | null;
  };
  inventory: {
    valuationReduction: number;
    batchBreakdown: {
      batchId: number;
      quantity: number;
      unitCost: number;
      unitAdditionalCost: number;
    }[];
  };
  supplierBalance: {
    outstandingBefore: number;
    goodsCredit: number;
    outstandingAfter: number;
    supplierCreditCreated: number;
  };
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
  /**
   * Base units when uomConversionId is null/absent; otherwise the quantity
   * in that packaging unit (the server converts authoritatively).
   */
  quantity: number;
  /** UOM (migration 0062): the packaging unit this quantity is entered in. */
  uomConversionId?: number | null;
}
export interface PurchaseReturnInput {
  orderId: number;
  reason?: string;
  changedItems: (ChangedItems & {
    /** Phase 5: explicit serial selection for serial-tracked lines.
     *  Absent = the backend's documented auto-pick fallback. */
    serialIds?: number[];
  })[];
}
export interface PurchaseReturnResponse {
  success: boolean;
  message: string;
  data: {
    purchaseReturnId: number;
    totalAmount: number;
    landedCost: LandedCostFeedback;
    /** Phase 3: the credit split — a credit beyond the outstanding due is
     *  a supplier credit balance, never a cash refund. */
    supplierBalance: {
      outstandingBefore: number;
      goodsCredit: number;
      outstandingAfter: number;
      supplierCreditCreated: number;
    };
    /** Phase 5 traceability: the serial numbers actually marked returned. */
    returnedSerials: string[];
  };
}
/** Landed-cost feedback returned by the receive/return backends
 *  (authoritative). Phase 7: state + reason explain WHY a reversal is or
 *  is not applicable — the frontend never infers the state itself. */
export type LandedCostFeedback = {
  adjusted: boolean;
  amount: number;
  documentId: number | null;
  state?: "posted" | "adjusted" | "draft" | "reversed" | "no_document";
  reason?: string | null;
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
  /** In the ENTERED unit when uomConversionId is set (null = base unit). */
  quantity: number;
  /** Per entered unit. */
  purchasePrice: number;
  discount: number;
  tax: number;
  /** UOM (migration 0062): the packaging unit this line is entered in. */
  uomConversionId?: number | null;
};

export type CreatePurchaseInput = {
  items: CreatePurchaseItem[];
  supplierId: number | null;
  purchaseDate: string;
  notes: string;
  discount: number;
  /** Percentage discounts resolve to the fixed amount server-side. */
  discountBasis?: "fixed" | "percentage" | undefined;
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
