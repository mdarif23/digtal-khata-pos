import type { Request, Response } from "express";
import { z } from "zod";
import {
  assignOnlineOrder,
  cancelOnlineOrder,
  confirmOnlineOrder,
  getOrderDetail,
  getOrdersSummary,
  listAssignableStaff,
  listUnifiedOrders,
  markOnlineOrderPaid,
  updateFulfillmentStatus,
} from "../commerce/orders.service.js";
import {
  addOrderPackage,
  deleteOrderPackage,
  deliverOrder,
  getOrderFulfillment,
  getOrderPackagingDefaults,
  markOrderDeliveryFailed,
  markOrderReadyToShip,
  shipOrder,
  startOrderProcessing,
  updateOrderPackage,
  updateOrderShipment,
} from "../commerce/fulfillment.service.js";
import { getOrderTimeline } from "../commerce/orderTimeline.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

const listSchema = z.object({
  channel: z.enum(["woocommerce", "custom_storefront"]).optional(),
  status: z.string().optional(),
  fulfillmentStatus: z.string().optional(),
  search: z.string().optional(),
  locationId: z.coerce.number().int().positive().optional(),
  // Assignment filter: "me" resolves to the caller server-side — the client
  // never picks an arbitrary user id for scoping.
  assignee: z
    .union([z.literal("me"), z.literal("unassigned"), z.coerce.number().int().positive()])
    .optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD")
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD")
    .optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const summarySchema = listSchema.omit({
  status: true,
  fulfillmentStatus: true,
  search: true,
  page: true,
  pageSize: true,
  assignee: true,
});

export async function getOrderSummary(req: Request, res: Response) {
  const parsed = summarySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid summary filters." });
  }
  try {
    res.status(200).json({
      success: true,
      data: await getOrdersSummary(getBusinessId(req), parsed.data),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load the orders summary right now.");
  }
}

export async function getOrders(req: Request, res: Response) {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid order filters." });
  }
  try {
    // "me" never travels as a client-chosen id — resolve the caller here.
    const { assignee, ...rest } = parsed.data;
    const assigneeFilter =
      assignee === "me" ? (req.user?.id as number) : assignee;
    res.status(200).json({
      success: true,
      ...((await listUnifiedOrders(getBusinessId(req), {
        ...rest,
        assignee: assigneeFilter,
      })) as object),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load orders right now.");
  }
}

export async function getOrder(req: Request, res: Response) {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  try {
    res.status(200).json({
      success: true,
      data: await getOrderDetail(getBusinessId(req), orderId),
    });
  } catch (err) {
    sendSafeError(res, err, "Order not found.");
  }
}

function parseOrderId(req: Request): number | null {
  const orderId = Number(req.params.orderId);
  return Number.isInteger(orderId) && orderId > 0 ? orderId : null;
}

const fulfillmentSchema = z.object({
  status: z.enum([
    "confirmed",
    "processing",
    "packed",
    "ready_to_ship",
    "shipped",
    "delivered",
  ]),
});

/** Legacy transition endpoint (Phase 9.5) — kept for compatibility; the
 * granular workflow endpoints below are preferred. */
export async function setFulfillmentStatus(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  const parsed = fulfillmentSchema.safeParse(req.body);
  if (orderId === null || !parsed.success) {
    return res.status(400).json({
      success: false,
      message: "A valid order ID and fulfillment status are required.",
    });
  }
  try {
    await updateFulfillmentStatus(
      getBusinessId(req),
      orderId,
      parsed.data.status,
      { actorUserId: req.user?.id ?? null },
    );
    res.status(200).json({
      success: true,
      message: `Fulfillment updated to ${parsed.data.status}.`,
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to update fulfillment right now.");
  }
}

const markPaidSchema = z.object({
  method: z.enum(["cash", "bangla_qr", "card", "sslcommerz"]).optional(),
  reference: z.string().max(100).nullish(),
  amount: z.coerce.number().positive().optional(),
  gatewayFee: z.coerce.number().nonnegative().optional(),
});

export async function markPaid(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  const parsed = markPaidSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid payment details." });
  }
  try {
    await markOnlineOrderPaid(getBusinessId(req), orderId, {
      method: parsed.data.method,
      reference: parsed.data.reference ?? null,
      amount: parsed.data.amount,
      gatewayFee: parsed.data.gatewayFee,
      actorUserId: req.user?.id ?? null,
    });
    res.status(200).json({
      success: true,
      message: "Payment recorded. The order is confirmed and stock deducted.",
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to record the payment right now.");
  }
}

// ---------------------------------------------------------------------------
// Workflow endpoints (module two §6)
// ---------------------------------------------------------------------------

export async function confirmOrder(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  try {
    // Portal confirmation of a pending order. COD orders confirmed here
    // stay unpaid — record the collection explicitly (mark-paid/deliver).
    // For prepaid gateways the verify core is the normal path; a direct
    // confirm is an explicit staff action and marks the sale paid.
    await confirmOnlineOrder(getBusinessId(req), orderId);
    res.status(200).json({
      success: true,
      message: "Order confirmed. Stock deducted and reservations locked in.",
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to confirm the order right now.");
  }
}

export async function startProcessing(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  try {
    await startOrderProcessing(getBusinessId(req), orderId, {
      actorUserId: req.user?.id ?? null,
    });
    res.status(200).json({ success: true, message: "Processing started." });
  } catch (err) {
    sendSafeError(res, err, "Unable to start processing right now.");
  }
}

const cancelSchema = z.object({
  // WP-001: the FE sends `{ reason: null }` when no reason was typed —
  // `.optional()` alone rejects null (zod 4 strips nothing, null fails the
  // check) and the whole action 400s.
  reason: z.string().max(500).nullish(),
});

export async function cancelOrder(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  const parsed = cancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid cancellation details." });
  }
  try {
    await cancelOnlineOrder(
      getBusinessId(req),
      orderId,
      parsed.data.reason ?? null,
    );
    res.status(200).json({
      success: true,
      message: "Order cancelled and stock reservations released.",
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to cancel the order right now.");
  }
}

export async function getTimeline(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  try {
    res.status(200).json({
      success: true,
      data: await getOrderTimeline(getBusinessId(req), orderId),
    });
  } catch (err) {
    sendSafeError(res, err, "Order not found.");
  }
}

export async function getFulfillment(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  try {
    res.status(200).json({
      success: true,
      data: await getOrderFulfillment(getBusinessId(req), orderId),
    });
  } catch (err) {
    sendSafeError(res, err, "Order not found.");
  }
}

export async function getPackagingDefaults(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  try {
    res.status(200).json({
      success: true,
      data: await getOrderPackagingDefaults(getBusinessId(req), orderId),
    });
  } catch (err) {
    sendSafeError(res, err, "Order not found.");
  }
}

const optionalPositive = z.coerce.number().nonnegative().nullable().optional();
const optionalText = z.string().max(1000).nullable().optional();

const packageSchema = z.object({
  packageType: z.string().max(50).nullable().optional(),
  weightKg: optionalPositive,
  lengthCm: optionalPositive,
  widthCm: optionalPositive,
  heightCm: optionalPositive,
  materialsNote: optionalText,
  packingCost: optionalPositive,
  notes: optionalText,
});

export async function createPackage(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  const parsed = packageSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid package details." });
  }
  try {
    const pkg = await addOrderPackage(
      getBusinessId(req),
      orderId,
      req.user?.id ?? null,
      parsed.data,
    );
    res.status(201).json({ success: true, data: pkg });
  } catch (err) {
    sendSafeError(res, err, "Unable to record the package right now.");
  }
}

export async function patchPackage(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  const packageId = Number(req.params.packageId);
  if (
    orderId === null ||
    !Number.isInteger(packageId) ||
    packageId <= 0
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid order ID and package ID are required.",
    });
  }
  const parsed = packageSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid package details." });
  }
  try {
    await updateOrderPackage(
      getBusinessId(req),
      orderId,
      packageId,
      req.user?.id ?? null,
      parsed.data,
    );
    res.status(200).json({ success: true, message: "Package updated." });
  } catch (err) {
    sendSafeError(res, err, "Unable to update the package right now.");
  }
}

export async function removePackage(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  const packageId = Number(req.params.packageId);
  if (orderId === null || !Number.isInteger(packageId) || packageId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid order ID and package ID are required.",
    });
  }
  try {
    await deleteOrderPackage(
      getBusinessId(req),
      orderId,
      packageId,
      req.user?.id ?? null,
    );
    res.status(200).json({ success: true, message: "Package removed." });
  } catch (err) {
    sendSafeError(res, err, "Unable to remove the package right now.");
  }
}

export async function readyToShip(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  try {
    await markOrderReadyToShip(getBusinessId(req), orderId, {
      actorUserId: req.user?.id ?? null,
    });
    res
      .status(200)
      .json({ success: true, message: "Order is ready to ship." });
  } catch (err) {
    sendSafeError(res, err, "Unable to mark the order ready to ship.");
  }
}

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date")
  .nullable()
  .optional();

const shipSchema = z.object({
  courierName: z.string().min(1).max(120),
  courierService: z.string().max(120).nullable().optional(),
  trackingNumber: z.string().min(1).max(120),
  expectedDeliveryDate: isoDate,
  shippingCost: optionalPositive,
  notes: optionalText,
  referenceUrl: z.string().max(300).nullable().optional(),
});

export async function ship(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  const parsed = shipSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: "Courier company and tracking number are required.",
    });
  }
  try {
    const shipment = await shipOrder(
      getBusinessId(req),
      orderId,
      req.user?.id ?? null,
      parsed.data,
    );
    res.status(200).json({ success: true, data: shipment });
  } catch (err) {
    sendSafeError(res, err, "Unable to record the shipment right now.");
  }
}

const shipmentPatchSchema = z.object({
  courierName: z.string().max(120).nullable().optional(),
  courierService: z.string().max(120).nullable().optional(),
  trackingNumber: z.string().max(120).nullable().optional(),
  expectedDeliveryDate: isoDate,
  shippingCost: optionalPositive,
  notes: optionalText,
  referenceUrl: z.string().max(300).nullable().optional(),
});

export async function patchShipment(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  const parsed = shipmentPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid shipment details." });
  }
  try {
    const shipment = await updateOrderShipment(
      getBusinessId(req),
      orderId,
      parsed.data,
    );
    res.status(200).json({ success: true, data: shipment });
  } catch (err) {
    sendSafeError(res, err, "Unable to update the shipment right now.");
  }
}

const deliverSchema = z.object({
  codCollected: z.boolean().optional(),
  codAmount: z.coerce.number().positive().optional(),
  codMethod: z.enum(["cash", "bangla_qr", "card", "sslcommerz"]).optional(),
  codReference: z.string().max(100).nullable().optional(),
  codGatewayFee: z.coerce.number().nonnegative().optional(),
});

export async function deliver(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  const parsed = deliverSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid delivery details." });
  }
  try {
    await deliverOrder(getBusinessId(req), orderId, req.user?.id ?? null, {
      codCollected: parsed.data.codCollected,
      codAmount: parsed.data.codAmount,
      codMethod: parsed.data.codMethod,
      codReference: parsed.data.codReference ?? null,
      codGatewayFee: parsed.data.codGatewayFee,
    });
    res.status(200).json({
      success: true,
      message: "Order delivered.",
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to record the delivery right now.");
  }
}

// ---------------------------------------------------------------------------
// Assignment (Flexible Operating Model Phase 3, migration 0088)
// ---------------------------------------------------------------------------

const assignSchema = z.object({
  userId: z.coerce.number().int().positive(),
});

/** POST /:orderId/assign — body { userId }. Reassignment = assign again. */
export async function assignOrder(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  const parsed = assignSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, message: "A valid assignee user ID is required." });
  }
  try {
    await assignOnlineOrder(
      getBusinessId(req),
      orderId,
      parsed.data.userId,
      req.user?.id ?? null,
    );
    res.status(200).json({
      success: true,
      message: "Order assigned.",
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to assign the order right now.");
  }
}

/** DELETE /:orderId/assign — clears the assignment (history kept). */
export async function unassignOrder(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  try {
    await assignOnlineOrder(getBusinessId(req), orderId, null, req.user?.id ?? null);
    res.status(200).json({
      success: true,
      message: "Order unassigned.",
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to unassign the order right now.");
  }
}

/**
 * GET /orders/assignable-staff — active members for the assignee picker.
 * Deliberately NOT behind users.view: the picker needs names, not the staff
 * admin; orders.assign is the authority here.
 */
export async function getAssignableStaff(req: Request, res: Response) {
  try {
    res.status(200).json({
      success: true,
      data: await listAssignableStaff(getBusinessId(req)),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load the team right now.");
  }
}

// ---------------------------------------------------------------------------
// Failed delivery (Flexible Operating Model Phase 3)
// ---------------------------------------------------------------------------

const deliveryFailedSchema = z.object({
  // WP-001: the POS "Mark delivery failed" button posts `{ note: null }`
  // when no note was typed — accept null (the service already normalizes it
  // to a NULL column) or this action 400s on every click.
  note: z.string().max(500).nullish(),
});

/** POST /:orderId/delivery-failed — marks the active shipment failed. */
export async function deliveryFailed(req: Request, res: Response) {
  const orderId = parseOrderId(req);
  if (orderId === null) {
    return res
      .status(400)
      .json({ success: false, message: "A valid order ID is required." });
  }
  const parsed = deliveryFailedSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid delivery-failure details." });
  }
  try {
    await markOrderDeliveryFailed(
      getBusinessId(req),
      orderId,
      req.user?.id ?? null,
      parsed.data.note ?? null,
    );
    res.status(200).json({
      success: true,
      message:
        "Delivery marked failed. Update the shipment and record the delivery again (or process a return).",
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to mark the delivery failed right now.");
  }
}
