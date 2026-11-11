import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { resolveOptionalLocationParam as resolveLocationFilter } from "../../middleware/location.js";
import { sendSafeError } from "../../utils/safeError.js";
import { UnauthorizedError } from "../../utils/handleError.js";
import * as configService from "./warrantyConfig.service.js";
import * as warrantyService from "./warranty.service.js";
import * as claimsService from "./warrantyClaims.service.js";
import * as supplierService from "./supplierWarranty.service.js";
import * as reportsService from "./warrantyReports.service.js";
import {
  supplierClaimCreateSchema,
  supplierClaimListQuerySchema,
  supplierClaimNoteSchema,
  supplierClaimRecoverySchema,
  supplierClaimReplacementSchema,
  supplierClaimResponseSchema,
  supplierWarrantyCreateSchema,
  supplierWarrantyListQuerySchema,
  warrantyClaimCreateSchema,
  warrantyClaimListQuerySchema,
  warrantyConfigWriteSchema,
  warrantyListQuerySchema,
  warrantyLookupQuerySchema,
  claimApprovalSchema,
  claimAssignSchema,
  claimInspectionSchema,
  claimNoteSchema,
  claimRejectionSchema,
  claimRepairSchema,
  claimReplacementSchema,
} from "./warranty.schemas.js";

function getActorUserId(req: Request): number {
  if (!req.user) {
    throw new UnauthorizedError("Authentication required.");
  }
  return req.user.id;
}

function validationError(res: Response, message: string, errors: unknown) {
  return res.status(400).json({ success: false, message, errors });
}

// ---------------------------------------------------------------------------
// Product/variant warranty configuration
// ---------------------------------------------------------------------------
export async function getProductWarrantyConfig(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const productId = Number(req.params.productId);
    const data = await configService.getProductWarrantyConfig(businessId, productId);
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to load the warranty configuration.");
  }
}

export async function putProductWarrantyConfig(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const productId = Number(req.params.productId);
    const parsed = warrantyConfigWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, "Invalid warranty configuration", parsed.error.flatten());
    }
    const data = await configService.setProductWarrantyConfig(businessId, productId, parsed.data);
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to save the warranty configuration.");
  }
}

export async function putVariantWarrantyConfig(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const productId = Number(req.params.productId);
    const variantId = Number(req.params.variantId);
    const parsed = warrantyConfigWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, "Invalid warranty configuration", parsed.error.flatten());
    }
    const data = await configService.setVariantWarrantyConfig(
      businessId,
      productId,
      variantId,
      parsed.data,
    );
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to save the variant warranty override.");
  }
}

export async function deleteVariantWarrantyConfig(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const productId = Number(req.params.productId);
    const variantId = Number(req.params.variantId);
    const data = await configService.removeVariantWarrantyConfig(businessId, productId, variantId);
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to remove the variant warranty override.");
  }
}

// ---------------------------------------------------------------------------
// Warranty registry
// ---------------------------------------------------------------------------
export async function getWarranties(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const parsed = warrantyListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return validationError(res, "Invalid warranty filters", parsed.error.flatten());
    }
    // ?locationId= validated against the caller's accessible locations;
    // absent/'all' = business-wide.
    const locationId = await resolveLocationFilter(req);
    const { rows, total } = await warrantyService.listWarranties(
      businessId,
      parsed.data,
      locationId,
    );
    res.json({
      success: true,
      data: rows,
      meta: {
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / parsed.data.pageSize)),
      },
    });
  } catch (error) {
    sendSafeError(res, error, "Unable to load warranties.");
  }
}

export async function lookupWarranties(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const parsed = warrantyLookupQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return validationError(res, "Invalid lookup request", parsed.error.flatten());
    }
    const data = await warrantyService.lookupWarranties(
      businessId,
      parsed.data.type,
      parsed.data.q,
    );
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to look up warranties.");
  }
}

export async function getWarranty(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const warrantyId = Number(req.params.id);
    const data = await warrantyService.getWarrantyDetail(businessId, warrantyId);
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to load the warranty.");
  }
}

export async function getWarrantyCertificate(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const warrantyId = Number(req.params.id);
    const data = await warrantyService.getWarrantyCertificate(businessId, warrantyId);
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to load the warranty certificate.");
  }
}

// ---------------------------------------------------------------------------
// Warranty claims
// ---------------------------------------------------------------------------
export async function createWarrantyClaim(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const parsed = warrantyClaimCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, "Invalid warranty claim", parsed.error.flatten());
    }
    const data = await claimsService.createClaim(
      businessId,
      getActorUserId(req),
      parsed.data,
    );
    res.status(201).json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to create the warranty claim.");
  }
}

export async function getWarrantyClaims(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const parsed = warrantyClaimListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return validationError(res, "Invalid claim filters", parsed.error.flatten());
    }
    const { rows, total } = await claimsService.listClaims(businessId, parsed.data);
    res.json({
      success: true,
      data: rows,
      meta: {
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / parsed.data.pageSize)),
      },
    });
  } catch (error) {
    sendSafeError(res, error, "Unable to load warranty claims.");
  }
}

export async function getWarrantyClaim(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const claimId = Number(req.params.id);
    const data = await claimsService.getClaimDetail(businessId, claimId);
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to load the warranty claim.");
  }
}

type ClaimActionHandler = (
  businessId: number,
  actorUserId: number,
  claimId: number,
  data: unknown,
) => Promise<unknown>;

function claimAction(schema: { safeParse: (b: unknown) => { success: boolean; data?: unknown; error?: { flatten: () => unknown } } }, handler: ClaimActionHandler, fallback: string) {
  return async (req: Request, res: Response) => {
    try {
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return validationError(res, "Invalid claim update", parsed.error!.flatten());
      }
      const data = await handler(getBusinessId(req), getActorUserId(req), Number(req.params.id), parsed.data);
      res.json({ success: true, data });
    } catch (error) {
      sendSafeError(res, error, fallback);
    }
  };
}

export const inspectWarrantyClaim = claimAction(
  claimInspectionSchema,
  (b, u, id, d) => claimsService.updateClaimInspection(b, u, id, d as { inspectionNotes?: string; receivedDate?: string }),
  "Unable to record the inspection.",
);

export const approveWarrantyClaim = claimAction(
  claimApprovalSchema,
  (b, u, id, d) => claimsService.approveClaim(b, u, id, d as { inspectionNotes?: string; assignedUserId?: number; note?: string }),
  "Unable to approve the claim.",
);

export const rejectWarrantyClaim = claimAction(
  claimRejectionSchema,
  (b, u, id, d) => claimsService.rejectClaim(b, u, id, d as { resolutionNotes: string }),
  "Unable to reject the claim.",
);

export const updateWarrantyClaimRepair = claimAction(
  claimRepairSchema,
  (b, u, id, d) => claimsService.updateClaimRepair(b, u, id, d as Parameters<typeof claimsService.updateClaimRepair>[3]),
  "Unable to update the repair.",
);

export const assignWarrantyClaim = claimAction(
  claimAssignSchema,
  (b, u, id, d) => claimsService.assignClaim(b, u, id, d as { assignedUserId: number; note?: string }),
  "Unable to assign the claim.",
);

export const readyWarrantyClaim = claimAction(
  claimNoteSchema.partial(),
  (b, u, id) => claimsService.markClaimReady(b, u, id),
  "Unable to mark the claim ready for pickup.",
);

export const pickupWarrantyClaim = claimAction(
  claimNoteSchema.partial(),
  (b, u, id) => claimsService.recordClaimPickup(b, u, id),
  "Unable to record the customer pickup.",
);

export const replaceWarrantyClaim = claimAction(
  claimReplacementSchema,
  (b, u, id, d) => claimsService.replaceUnderWarranty(b, u, id, d as { replacementVariantId: number; replacementSerialNumber?: string | null; note?: string }),
  "Unable to record the warranty replacement.",
);

export const closeWarrantyClaim = claimAction(
  claimNoteSchema.partial(),
  (b, u, id) => claimsService.closeClaim(b, u, id),
  "Unable to close the claim.",
);

export const cancelWarrantyClaim = claimAction(
  claimNoteSchema.partial(),
  (b, u, id) => claimsService.cancelClaim(b, u, id),
  "Unable to cancel the claim.",
);

export const noteWarrantyClaim = claimAction(
  claimNoteSchema,
  (b, u, id, d) => claimsService.addClaimNote(b, u, id, (d as { note: string }).note),
  "Unable to add the note.",
);

// ---------------------------------------------------------------------------
// Supplier warranties
// ---------------------------------------------------------------------------
export async function getSupplierWarranties(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const parsed = supplierWarrantyListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return validationError(res, "Invalid supplier warranty filters", parsed.error.flatten());
    }
    const { rows, total } = await supplierService.listSupplierWarranties(businessId, parsed.data);
    res.json({
      success: true,
      data: rows,
      meta: {
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / parsed.data.pageSize)),
      },
    });
  } catch (error) {
    sendSafeError(res, error, "Unable to load supplier warranties.");
  }
}

export async function createSupplierWarranty(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const parsed = supplierWarrantyCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, "Invalid supplier warranty", parsed.error.flatten());
    }
    const data = await supplierService.createSupplierWarranty(
      businessId,
      getActorUserId(req),
      parsed.data,
    );
    res.status(201).json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to create the supplier warranty.");
  }
}

export async function getSupplierClaims(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const parsed = supplierClaimListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return validationError(res, "Invalid supplier claim filters", parsed.error.flatten());
    }
    const { rows, total } = await supplierService.listSupplierClaims(businessId, parsed.data);
    res.json({
      success: true,
      data: rows,
      meta: {
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / parsed.data.pageSize)),
      },
    });
  } catch (error) {
    sendSafeError(res, error, "Unable to load supplier warranty claims.");
  }
}

export async function createSupplierClaim(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const parsed = supplierClaimCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, "Invalid supplier warranty claim", parsed.error.flatten());
    }
    const data = await supplierService.createSupplierClaim(
      businessId,
      getActorUserId(req),
      parsed.data,
    );
    res.status(201).json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to create the supplier warranty claim.");
  }
}

export async function getSupplierClaim(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const claimId = Number(req.params.id);
    const data = await supplierService.getSupplierClaimDetail(businessId, claimId);
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to load the supplier warranty claim.");
  }
}

function supplierAction(schema: { safeParse: (b: unknown) => { success: boolean; data?: unknown; error?: { flatten: () => unknown } } }, handler: ClaimActionHandler, fallback: string) {
  return async (req: Request, res: Response) => {
    try {
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return validationError(res, "Invalid supplier claim update", parsed.error!.flatten());
      }
      const data = await handler(getBusinessId(req), getActorUserId(req), Number(req.params.id), parsed.data);
      res.json({ success: true, data });
    } catch (error) {
      sendSafeError(res, error, fallback);
    }
  };
}

export const respondSupplierClaim = supplierAction(
  supplierClaimResponseSchema,
  (b, u, id, d) => supplierService.respondSupplierClaim(b, u, id, d as { status: "sent_to_supplier" | "under_repair" | "rejected"; note?: string }),
  "Unable to record the supplier response.",
);

export const replaceSupplierClaim = supplierAction(
  supplierClaimReplacementSchema,
  (b, u, id, d) => supplierService.recordSupplierReplacement(b, u, id, d as { replacementQuantity: number; replacementSerialNumbers?: string | null; intake: "none" | "adjust"; note?: string }),
  "Unable to record the supplier replacement.",
);

export const recoverSupplierClaim = supplierAction(
  supplierClaimRecoverySchema,
  (b, u, id, d) => supplierService.recordSupplierRecovery(b, u, id, d as { recoveryAmount: number; recoveryMethod: "credit_note" | "replacement" | "cash"; recoveryReferenceId?: number; note?: string }),
  "Unable to record the supplier recovery.",
);

export const closeSupplierClaim = supplierAction(
  supplierClaimNoteSchema.partial(),
  (b, u, id) => supplierService.closeSupplierClaim(b, u, id),
  "Unable to close the supplier claim.",
);

export const cancelSupplierClaim = supplierAction(
  supplierClaimNoteSchema.partial(),
  (b, u, id) => supplierService.cancelSupplierClaim(b, u, id),
  "Unable to cancel the supplier claim.",
);

export const noteSupplierClaim = supplierAction(
  supplierClaimNoteSchema,
  (b, u, id, d) => supplierService.addSupplierClaimNote(b, u, id, (d as { note: string }).note),
  "Unable to add the note.",
);

// ---------------------------------------------------------------------------
// Overview + reports (Phase 6)
// ---------------------------------------------------------------------------
export async function getWarrantyOverview(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const locationId = await resolveLocationFilter(req);
    const data = await reportsService.getWarrantyOverview(businessId, locationId);
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to load the warranty overview.");
  }
}

export async function getWarrantyExpiryReport(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const locationId = await resolveLocationFilter(req);
    const data = await reportsService.getExpiryReport(businessId, locationId, req.query);
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to load the warranty expiry report.");
  }
}

export async function getWarrantyClaimsReport(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const locationId = await resolveLocationFilter(req);
    const data = await reportsService.getClaimsReport(businessId, locationId, req.query);
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to load the warranty claims report.");
  }
}

export async function getWarrantyCostsReport(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const locationId = await resolveLocationFilter(req);
    const data = await reportsService.getCostsReport(businessId, locationId, req.query);
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to load the warranty cost report.");
  }
}

export async function getWarrantySupplierReport(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const locationId = await resolveLocationFilter(req);
    const data = await reportsService.getSupplierRecoveryReport(businessId, locationId, req.query);
    res.json({ success: true, data });
  } catch (error) {
    sendSafeError(res, error, "Unable to load the supplier recovery report.");
  }
}
