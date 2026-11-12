/**
 * Warranty Management domain types. Shapes mirror the backend warranty
 * module payloads (all wrapped in `{ success, data, meta? }` envelopes by
 * the api layer).
 */

// ---------------- Customer warranties ----------------

/** Derived warranty health shown in the registry (backend-computed). */
export type WarrantyStatus =
  | "active"
  | "expiring"
  | "expired"
  | "voided"
  | "replaced"
  | "suspended";

/** One row of GET /warranties (list + lookup share the shape). */
export interface WarrantyListRow {
  id: number;
  warrantyNumber: string;
  status: WarrantyStatus;
  /** Raw DB status before the backend derives the health bucket. */
  storedStatus: string;
  provider: string | null;
  warrantyType: string;
  duration: number;
  durationUnit: string;
  startDate: string;
  expiryDate: string | null;
  quantity: number;
  returnedQuantity: number;
  serialNumber: string | null;
  voidReason: string | null;
  saleId: number | null;
  invoiceNumber: string | null;
  customerId: number | null;
  customerName: string | null;
  customerPhone: string | null;
  productId: number;
  productName: string;
  variantId: number;
  variantOptionLabel: string | null;
  locationName: string | null;
  createdAt: string;
}

export interface WarrantyListFilters {
  status?: string | undefined;
  search?: string | undefined;
  customerId?: number | undefined;
  productId?: number | undefined;
  variantId?: number | undefined;
  provider?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  locationId?: number | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export type WarrantyLookupType = "serial" | "invoice" | "phone" | "number";

/** GET /warranties/:id — facts plus the full warranty record. */
export interface WarrantyDetail {
  warranty: WarrantyListRow;
  invoiceNumber: string | null;
  saleDate: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  customerAddress: string | null;
  productName: string;
  variantOptionLabel: string | null;
  locationName: string | null;
  claims: WarrantyClaimRow[];
}

export interface WarrantyBranding {
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  website: string | null;
  vatBin: string | null;
  tagline: string | null;
  logoUrl: string | null;
}

/** GET /warranties/:id/certificate */
export interface WarrantyCertificateData {
  warranty: WarrantyDetail;
  branding: WarrantyBranding;
}

/** GET /warranty-overview */
export interface WarrantyOverviewData {
  activeWarranties: number;
  expiringSoon: number;
  expiredWarranties: number;
  coveredUnits: number;
  openClaims: number;
  pendingInspections: number;
  inRepair: number;
  readyForPickup: number;
  totalRepairCost: number;
  openSupplierClaims: number;
}

// ---------------- Customer warranty claims ----------------

export type WarrantyClaimType =
  | "repair"
  | "replacement"
  | "parts_replacement"
  | "service";

export type WarrantyClaimStatus =
  | "submitted"
  | "under_inspection"
  | "approved"
  | "rejected"
  | "repairing"
  | "waiting_parts"
  | "ready_for_pickup"
  | "replaced"
  | "closed"
  | "cancelled";

/** One row of GET /warranty-claims. */
export interface WarrantyClaimRow {
  id: number;
  claimNumber: string;
  claimType: WarrantyClaimType;
  status: WarrantyClaimStatus | string;
  resolutionType: string | null;
  reportedProblem: string;
  repairCost: number;
  assignedUserId: number | null;
  serialNumber: string | null;
  createdAt: string;
  closedDate: string | null;
  warrantyId: number;
  warrantyNumber: string;
  customerName: string | null;
  customerPhone: string | null;
  productName: string;
  variantOptionLabel: string | null;
  locationName: string | null;
}

export interface WarrantyClaimsFilters {
  status?: string | undefined;
  search?: string | undefined;
  assignedUserId?: number | undefined;
  claimType?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  locationId?: number | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

/** Full claim record inside GET /warranty-claims/:id. */
export interface WarrantyClaim extends WarrantyClaimRow {
  receivedDate: string | null;
  inspectionNotes: string | null;
  repairDescription: string | null;
  partsUsed: string | null;
  replacementVariantId: number | null;
  replacementSerialNumber: string | null;
  replacementDate: string | null;
  pickupDate: string | null;
  resolutionNotes: string | null;
}

export interface WarrantyClaimEvent {
  id: number;
  eventType: string;
  previousStatus: string | null;
  newStatus: string | null;
  actorType: string;
  actorUserId: number | null;
  note: string | null;
  metadata: unknown;
  createdAt: string;
}

/** GET /warranty-claims/:id */
export interface WarrantyClaimDetail {
  claim: WarrantyClaim;
  warrantyNumber: string;
  warrantyStartDate: string | null;
  warrantyExpiryDate: string | null;
  warrantyStatus: string;
  warrantyDuration: number;
  warrantyDurationUnit: string;
  warrantyProvider: string | null;
  warrantyTerms: string | null;
  invoiceNumber: string | null;
  saleId: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  customerAddress: string | null;
  productName: string;
  variantOptionLabel: string | null;
  locationName: string | null;
  events: WarrantyClaimEvent[];
  siblingClaims: WarrantyClaimRow[];
  allowedTransitions: string[];
}

export interface CreateWarrantyClaimInput {
  warrantyId: number;
  claimType: WarrantyClaimType;
  reportedProblem: string;
  receivedDate?: string | undefined;
}

// ---------------- Supplier warranties ----------------

export type SupplierWarrantyStatus =
  | "active"
  | "expiring"
  | "expired"
  | "voided"
  | "exhausted";

export interface SupplierWarrantyRow {
  id: number;
  supplierId: number;
  supplierName: string;
  purchaseId: number;
  purchaseItemId: number;
  productId: number;
  productName: string;
  variantId: number;
  variantOptionLabel: string | null;
  duration: number;
  durationUnit: string;
  terms: string | null;
  quantity: number;
  claimedQuantity: number;
  startDate: string | null;
  expiryDate: string | null;
  status: SupplierWarrantyStatus | string;
  storedStatus: string;
  source: string;
}

export interface SupplierWarrantyFilters {
  status?: string | undefined;
  supplierId?: number | undefined;
  search?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface CreateSupplierWarrantyInput {
  purchaseItemId: number;
  duration: number;
  durationUnit: string;
  provider?: string | undefined;
  terms?: string | undefined;
}

// ---------------- Supplier warranty claims ----------------

export interface SupplierWarrantyClaimRow {
  id: number;
  claimNumber: string;
  status: string;
  defectiveQuantity: number;
  replacementQuantity: number;
  recoveryAmount: number;
  recoveryMethod: string | null;
  costAmount: number;
  issueDescription: string | null;
  createdAt: string;
  closedDate: string | null;
  supplierName: string;
  productName: string;
  variantOptionLabel: string | null;
  supplierWarrantyId: number;
  customerWarrantyClaimId: number | null;
}

export interface SupplierClaimFilters {
  status?: string | undefined;
  supplierId?: number | undefined;
  search?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

/** Full claim record inside GET /supplier-warranty-claims/:id. */
export interface SupplierWarrantyClaim extends SupplierWarrantyClaimRow {
  resolutionNotes: string | null;
  recoveryReferenceId: string | null;
}

export interface SupplierWarrantyClaimDetail {
  claim: SupplierWarrantyClaim;
  supplierName: string;
  supplierPhone: string | null;
  productName: string;
  variantOptionLabel: string | null;
  warrantyDuration: number;
  warrantyDurationUnit: string;
  warrantyStartDate: string | null;
  warrantyExpiryDate: string | null;
  events: WarrantyClaimEvent[];
  allowedTransitions: string[];
}

export interface CreateSupplierClaimInput {
  supplierWarrantyId: number;
  defectiveQuantity: number;
  serialIds?: number[] | undefined;
  issueDescription: string;
  customerWarrantyClaimId?: number | undefined;
}

// ---------------- Reports ----------------

/** GET /reports/warranty/expiry — snake_case straight from the raw SQL. */
export interface WarrantyExpiryReportRow {
  id: number;
  warrantyNumber: string;
  bucket: string;
  status: string;
  serialNumber: string | null;
  quantity: number;
  provider: string | null;
  start_date: string | null;
  expiry_date: string | null;
  invoice_number: string | null;
  customer_name: string | null;
  product_name: string;
  variant_label: string | null;
  location_name: string | null;
}

export interface WarrantyExpiryReportFilters {
  locationId?: number | undefined;
  page?: number | undefined;
  limit?: number | undefined;
  bucket?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
}

export interface WarrantyClaimsReportData {
  byStatus: {
    status: string;
    claimType: string;
    claimCount: number;
  }[];
  byProduct: {
    productId: number;
    productName: string;
    claimCount: number;
    unitsAffected: number;
    repairCost: number;
    coveredUnitsIssued: number;
    claimRate: number;
  }[];
}

export interface WarrantyCostsReportData {
  totalRepairCost: number;
  replacementsGiven: number;
  repairsDone: number;
  claimsRejected: number;
  replacementStockValue: number;
  perMonth: {
    month: string;
    repairCost: number;
    claimCount: number;
  }[];
}

export interface WarrantySupplierRecoveryRow {
  supplierId: number;
  supplierName: string;
  claimCount: number;
  defectiveUnits: number;
  replacementUnits: number;
  recoveredAmount: number;
  shopCost: number;
  netRecovery: number;
}
