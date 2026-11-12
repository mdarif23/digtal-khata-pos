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
  /**
   * Supplier warranty capture (migration 0064): optional per-line terms
   * recorded inside the receive transaction. Absent = no supplier warranty
   * recorded for this delivery.
   */
  warranty?: {
    duration: number;
    durationUnit: "days" | "months" | "years";
    provider?: string | undefined;
    terms?: string | null | undefined;
  } | undefined;
  /**
   * UOM (migration 0062): the packaging unit the operator entered
   * receiveNow/rejectedQuantity/batches in. NULL/absent = the product's
   * base unit. After normalization (see normalizeReceiveItemsToBase) every
   * quantity on this object is BASE-unit and `uomSnapshot` preserves what
   * was typed for the receiving record.
   */
  uomConversionId?: number | null | undefined;
  uomSnapshot?: {
    conversionId: number;
    enteredQuantity: number;
    enteredUnitPrice: number;
    conversionFactor: number;
  } | undefined;
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
  /** UOM snapshot on the ORDER line (null = ordered in base units). */
  uomConversionId: number | null;
  conversionFactor: number | null;
  enteredQuantity: number | null;
  enteredUnitPrice: number | null;
}
