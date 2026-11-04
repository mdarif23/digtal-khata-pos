import api from "@/api/axios";

/** Mirrors ezPosBackend/src/modules/landed-cost — one document per purchase. */

export type LandedCostMethod = "quantity" | "value" | "weight" | "manual";
export type LandedCostStatus = "draft" | "posted" | "adjusted" | "reversed";
export type LandedCostExpenseType =
  | "shipping"
  | "loading"
  | "customs"
  | "transportation"
  | "insurance"
  | "handling"
  | "other";
export type LandedCostTaxTreatment = "none" | "recoverable" | "non_recoverable";
export type LandedCostSettlement =
  | "expense_payment"
  | "supplier_payable"
  | "cash"
  | "unpaid";

export interface LandedCostExpenseInput {
  expenseType: LandedCostExpenseType;
  amount: number;
  description?: string | null;
  taxAmount?: number;
  taxTreatment?: LandedCostTaxTreatment;
  isCapitalizable?: boolean;
  vendorId?: number | null;
  referenceNumber?: string | null;
  expenseDate?: string | null;
  settlementType?: LandedCostSettlement;
  settlementReferenceId?: number | null;
}

export interface ManualAllocationInput {
  purchaseItemId: number;
  amount: number;
}

export interface PreviewInput {
  method: LandedCostMethod;
  expenses: LandedCostExpenseInput[];
  manualAllocations?: ManualAllocationInput[];
}

export interface AllocationBatchPreview {
  batchId: number;
  batchNumber: string;
  quantitySnapshot: number;
  basisValue: number;
  allocatedAmount: number;
  allocatedPerUnit: number;
  weightSnapshot: number | null;
}

export interface AllocationLinePreview {
  purchaseItemId: number;
  variantId: number;
  batches: AllocationBatchPreview[];
  lineAllocatedAmount: number;
  lineTotalTargetAmount: number;
  lineReceivedTargetAmount: number;
  orderedQuantity: number;
  receivedQuantity: number;
}

export interface AccountingImpact {
  capitalizableToInventory: number;
  periodExpenses: number;
  bySettlement: { settlementType: string; amount: number }[];
}

export interface LandedCostPreview {
  totalExpenseAmount: number;
  totalCapitalizableAmount: number;
  totalNonCapitalizableAmount: number;
  allocation: {
    lines: AllocationLinePreview[];
    allocatedTotal: number;
    pendingTotal: number;
  };
  accountingImpact: AccountingImpact;
}

export interface LandedCostLineContext {
  purchaseItemId: number;
  variantId: number;
  productName: string;
  variantName: string;
  sku: string | null;
  unitCost: number;
  discount: number;
  receivedQuantity: number;
  orderedQuantity: number;
  variantWeight: number | null;
  variantWeightUnit: string | null;
  productDefaultWeightKg: number | null;
  batches: {
    batchId: number;
    batchNumber: string;
    quantityReceived: number;
    quantityRemaining: number;
  }[];
}

export interface LandedCostContext {
  purchase: {
    id: number;
    purchaseOrderNumber: string;
    status: string;
    supplierId: number | null;
    locationId: number | null;
  };
  lines: LandedCostLineContext[];
  existingStatus: LandedCostStatus | null;
  existingDocumentId: number | null;
}

export interface LandedCostDocument {
  id: number;
  purchaseId: number;
  status: LandedCostStatus;
  allocationMethod: LandedCostMethod;
  totalExpenseAmount: string;
  totalCapitalizableAmount: string;
  totalAllocatedAmount: string;
  pendingAllocationAmount: string;
}

export interface LandedCostDetail {
  document: LandedCostDocument;
  expenses: (LandedCostExpenseInput & {
    id: number;
    settlementType: LandedCostSettlement;
    amount: number;
  })[];
  allocations: {
    id: number;
    purchaseItemId: number;
    inventoryBatchId: number;
    variantId: number;
    allocatedAmount: string;
    allocatedPerUnit: string;
    quantitySnapshot: string;
    createdAt: string;
  }[];
  adjustments: {
    id: number;
    adjustmentType: "receive_delta" | "manual" | "reversal";
    previousAllocatedAmount: string;
    newAllocatedAmount: string;
    adjustmentAmount: string;
    inventoryAmount: string;
    cogsAmount: string;
    reason: string | null;
    createdAt: string;
  }[];
  auditLogs: {
    id: number;
    action: string;
    actorUserId: number | null;
    createdAt: string;
  }[];
  postings: {
    id: number;
    postingType: "capitalization" | "expense" | "cogs_adjustment" | "reversal";
    amount: string;
    paymentSource: LandedCostSettlement;
    paymentReferenceType: string | null;
    paymentReferenceId: number | null;
    description: string | null;
  }[];
}

const unwrap = <T>(res: { data: { data: T } }): T => res.data.data;

export const landedCostApi = {
  getContext: (purchaseId: number) =>
    api
      .get<{ success: boolean; data: LandedCostContext }>(
        `/purchases/${purchaseId}/landed-cost`,
      )
      .then((r) => unwrap<LandedCostContext>(r)),

  preview: (purchaseId: number, input: PreviewInput) =>
    api
      .post<{ success: boolean; data: LandedCostPreview }>(
        `/purchases/${purchaseId}/landed-cost/preview`,
        input,
      )
      .then((r) => unwrap<LandedCostPreview>(r)),

  createDocument: (purchaseId: number, input: PreviewInput) =>
    api
      .post<{ success: boolean; data: LandedCostDocument }>(
        `/purchases/${purchaseId}/landed-cost`,
        input,
      )
      .then((r) => unwrap<LandedCostDocument>(r)),

  getDocument: (documentId: number) =>
    api
      .get<{ success: boolean; data: LandedCostDetail }>(
        `/landed-costs/${documentId}`,
      )
      .then((r) => unwrap<LandedCostDetail>(r)),

  updateDocument: (documentId: number, input: PreviewInput) =>
    api
      .patch<{ success: boolean; data: LandedCostDocument }>(
        `/landed-costs/${documentId}`,
        input,
      )
      .then((r) => unwrap<LandedCostDocument>(r)),

  postDocument: (documentId: number) =>
    api
      .post<{ success: boolean; data: { documentId: number; totalAllocated: number } }>(
        `/landed-costs/${documentId}/post`,
        {},
      )
      .then((r) => unwrap(r)),
};
