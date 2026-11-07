export type RejectionCategory = "damaged" | "incorrect" | "expired" | "other";

export interface Items {
  itemId: number;
  trackingType: string;
  /** ACCEPTED quantity — the only quantity that enters inventory. */
  receiveNow: number;
  /** Delivered but refused — never enters inventory or valuation. */
  rejectedQuantity: number;
  rejectionCategory?: RejectionCategory | undefined;
  rejectionReason?: string | undefined;
  /** Required when this line accepts more than the outstanding quantity. */
  overReceiveReason?: string | undefined;
  unitCost: number;
  sellingPrice: number;
  batches: {
    batchNumber: string;
    quantity: number;
    manufacturedDate: Date;
    expiryDate: Date;
  }[];
  serialNumbers: string[];
}

export interface PurchaseItem {
  id: number;
  purchaseId: number;
  variantId: number;
  quantity: number;
  receivedQuantity: number;
  deliveredQuantity: number;
  rejectedQuantity: number;
  cancelledQuantity: number;
  unitCost: number;
  discount: number;
  tax: number;
  total: number;
}
