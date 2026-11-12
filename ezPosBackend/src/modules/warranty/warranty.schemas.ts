import { z } from "zod";

/**
 * Zod contracts for the warranty module. Conventions follow
 * expenses.schema.ts: coerced numeric query params, exported const enum
 * arrays, money as JSON numbers, dates as ISO strings.
 */

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------
export const WARRANTY_PROVIDERS = [
  "manufacturer",
  "seller",
  "distributor",
  "supplier",
  "third_party",
] as const;
export const WARRANTY_TYPES = [
  "repair",
  "replacement",
  "service",
  "limited",
  "parts_only",
  "comprehensive",
] as const;
export const WARRANTY_DURATION_UNITS = ["days", "months", "years"] as const;
export const WARRANTY_CLAIM_TYPES = [
  "repair",
  "replacement",
  "parts_replacement",
  "service",
] as const;
export const WARRANTY_CLAIM_STATUSES = [
  "submitted",
  "under_inspection",
  "approved",
  "rejected",
  "repairing",
  "waiting_parts",
  "ready_for_pickup",
  "replaced",
  "closed",
  "cancelled",
] as const;
export const SUPPLIER_CLAIM_STATUSES = [
  "submitted",
  "sent_to_supplier",
  "under_repair",
  "replaced",
  "rejected",
  "closed",
  "cancelled",
] as const;
export const RECOVERY_METHODS = ["none", "credit_note", "replacement", "cash"] as const;

export const idSchema = z.coerce.number().int().positive();
export const optionalIdSchema = z.coerce.number().int().positive().optional();

// ---------------------------------------------------------------------------
// Product/variant warranty configuration
// ---------------------------------------------------------------------------
export const warrantyConfigWriteSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(WARRANTY_PROVIDERS).default("manufacturer"),
  warrantyType: z.enum(WARRANTY_TYPES).default("comprehensive"),
  duration: z.number().int().positive().max(360),
  durationUnit: z.enum(WARRANTY_DURATION_UNITS).default("months"),
  terms: z.string().max(5000).nullish(),
});
export type WarrantyConfigWrite = z.infer<typeof warrantyConfigWriteSchema>;

// ---------------------------------------------------------------------------
// Warranty registry queries
// ---------------------------------------------------------------------------
export const warrantyListQuerySchema = z.object({
  // Derived view: active = stored active AND unexpired; expired = unexpired
  // date passed; voided/replaced/suspended read the stored status.
  status: z
    .enum(["all", "active", "expiring", "expired", "voided", "replaced", "suspended"])
    .default("all"),
  search: z.string().trim().max(100).optional(),
  customerId: optionalIdSchema,
  productId: optionalIdSchema,
  variantId: optionalIdSchema,
  provider: z.enum(WARRANTY_PROVIDERS).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type WarrantyListQuery = z.infer<typeof warrantyListQuerySchema>;

export const warrantyLookupQuerySchema = z.object({
  type: z.enum(["serial", "invoice", "phone", "number"]),
  q: z.string().trim().min(2).max(100),
});

// ---------------------------------------------------------------------------
// Warranty claims
// ---------------------------------------------------------------------------
export const warrantyClaimCreateSchema = z.object({
  warrantyId: idSchema,
  claimType: z.enum(WARRANTY_CLAIM_TYPES).default("repair"),
  reportedProblem: z.string().trim().min(3).max(3000),
  receivedDate: z.iso.datetime().optional(),
});
export type WarrantyClaimCreate = z.infer<typeof warrantyClaimCreateSchema>;

export const warrantyClaimListQuerySchema = z.object({
  status: z.union([z.enum(WARRANTY_CLAIM_STATUSES), z.literal("all")]).default("all"),
  search: z.string().trim().max(100).optional(),
  assignedUserId: optionalIdSchema,
  claimType: z.enum(WARRANTY_CLAIM_TYPES).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type WarrantyClaimListQuery = z.infer<typeof warrantyClaimListQuerySchema>;

export const claimInspectionSchema = z.object({
  inspectionNotes: z.string().trim().max(5000).optional(),
  receivedDate: z.iso.datetime().optional(),
});

export const claimApprovalSchema = z.object({
  inspectionNotes: z.string().trim().max(5000).optional(),
  assignedUserId: optionalIdSchema,
  note: z.string().trim().max(2000).optional(),
});

export const claimRejectionSchema = z.object({
  resolutionNotes: z.string().trim().min(3).max(3000),
});

export const claimRepairSchema = z.object({
  status: z.enum(["repairing", "waiting_parts"]).default("repairing"),
  repairDescription: z.string().trim().max(5000).optional(),
  partsUsed: z.string().trim().max(2000).optional(),
  repairCost: z.number().finite().min(0).max(99_999_999).optional(),
  assignedUserId: optionalIdSchema,
  note: z.string().trim().max(2000).optional(),
});

export const claimAssignSchema = z.object({
  assignedUserId: idSchema,
  note: z.string().trim().max(2000).optional(),
});

export const claimReplacementSchema = z.object({
  replacementVariantId: idSchema,
  replacementSerialNumber: z.string().trim().max(100).nullish(),
  note: z.string().trim().max(2000).optional(),
});

export const claimNoteSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});

// ---------------------------------------------------------------------------
// Supplier warranties
// ---------------------------------------------------------------------------
export const supplierWarrantyCreateSchema = z.object({
  purchaseItemId: idSchema,
  duration: z.number().int().positive().max(360),
  durationUnit: z.enum(WARRANTY_DURATION_UNITS).default("months"),
  provider: z.enum(WARRANTY_PROVIDERS).default("supplier"),
  terms: z.string().max(5000).nullish(),
});

export const receiveWarrantySchema = z.object({
  duration: z.number().int().positive().max(360),
  durationUnit: z.enum(WARRANTY_DURATION_UNITS).default("months"),
  provider: z.enum(WARRANTY_PROVIDERS).default("supplier"),
  terms: z.string().max(5000).nullish(),
});
export type ReceiveWarranty = z.infer<typeof receiveWarrantySchema>;

export const supplierWarrantyListQuerySchema = z.object({
  status: z.enum(["all", "active", "expiring", "expired", "voided", "exhausted"]).default("all"),
  supplierId: optionalIdSchema,
  search: z.string().trim().max(100).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type SupplierWarrantyListQuery = z.infer<typeof supplierWarrantyListQuerySchema>;

export const supplierClaimCreateSchema = z.object({
  supplierWarrantyId: idSchema,
  defectiveQuantity: z.number().int().positive(),
  serialIds: z.array(z.number().int().positive()).max(500).optional(),
  issueDescription: z.string().trim().min(3).max(3000),
  customerWarrantyClaimId: optionalIdSchema,
});

export const supplierClaimResponseSchema = z.object({
  status: z.enum(["sent_to_supplier", "under_repair", "rejected"]),
  note: z.string().trim().max(2000).optional(),
});

export const supplierClaimReplacementSchema = z.object({
  replacementQuantity: z.number().int().positive(),
  replacementSerialNumbers: z.string().trim().max(2000).nullish(),
  /** 'adjust' runs a stock adjustment intake for non-serial products (D8). */
  intake: z.enum(["none", "adjust"]).default("none"),
  note: z.string().trim().max(2000).optional(),
});

export const supplierClaimRecoverySchema = z.object({
  recoveryAmount: z.number().finite().min(0).max(99_999_999),
  recoveryMethod: z.enum(RECOVERY_METHODS).refine((v) => v !== "none", {
    message: "Pick a recovery method",
  }),
  recoveryReferenceId: optionalIdSchema,
  note: z.string().trim().max(2000).optional(),
});

export const supplierClaimNoteSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});

export const supplierClaimListQuerySchema = z.object({
  status: z.union([z.enum(SUPPLIER_CLAIM_STATUSES), z.literal("all")]).default("all"),
  supplierId: optionalIdSchema,
  search: z.string().trim().max(100).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type SupplierClaimListQuery = z.infer<typeof supplierClaimListQuerySchema>;
