import { z } from "zod";
import type { Request, Response } from "express";
import * as customersService from "./customers.service.js";
import { recordAudit } from "../../services/audit.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import { publishRealtime } from "../realtime/realtime.service.js";

export async function getCustomers(req: Request, res: Response) {
  try {
    res.json(await customersService.getCustomers(getBusinessId(req)));
  } catch (err) {
    sendSafeError(res, err, "Unable to load customers.");
  }
}
export async function createCustomer(req: Request, res: Response) {
  try {
    const { name, phone, address, email } = req.body;
    if (!name || !phone) {
      return res.status(400).json({
        error: "Name and phone are required",
      });
    }
    const customer = await customersService.createCustomer(
      getBusinessId(req),
      name,
      phone,
      address,
      typeof email === "string" && email.trim() !== ""
        ? email.trim().toLowerCase()
        : null,
    );
    publishRealtime(getBusinessId(req), null, {
      kind: "customer.changed",
      locationId: null,
    });
    res.status(201).json(customer);
  } catch (err) {
    sendSafeError(res, err, "Unable to create the customer.");
  }
}

/**
 * E1-004: customer contact details were permanently uncorrectable — typos
 * and duplicates could never be fixed from the app. Scoped update
 * (customers.edit), audited, and publishes customer.changed so the POS
 * combobox refreshes.
 */
export async function updateCustomer(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid customer ID." });
    }
    const schema = z.object({
      name: z.string().trim().min(1).max(255),
      phone: z.string().trim().min(1).max(20),
      email: z
        .string()
        .trim()
        .max(255)
        .email()
        .or(z.literal(""))
        .nullable()
        .optional(),
      address: z.string().trim().max(2000).nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer data.",
        errors: parsed.error.flatten(),
      });
    }
    const customer = await customersService.updateCustomer(
      getBusinessId(req),
      id,
      {
        name: parsed.data.name,
        phone: parsed.data.phone,
        email:
          parsed.data.email && parsed.data.email.trim() !== ""
            ? parsed.data.email.trim().toLowerCase()
            : null,
        address: parsed.data.address ?? null,
      },
      req.user?.id ?? null,
    );
    publishRealtime(getBusinessId(req), null, {
      kind: "customer.changed",
      locationId: null,
    });
    return res.status(200).json(customer);
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the customer.");
  }
}
export async function getCustomerDueSummary(req: Request, res: Response) {
  try {
    const result = await customersService.getCustomerDueSummary(
      getBusinessId(req),
    );
    res.status(200).json(result);
  } catch (err) {
    sendSafeError(res, err, "Unable to load the dues summary.");
  }
}

export async function getStoreCredit(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid customer ID." });
    }
    const balance = await customersService.getCustomerStoreCredit(
      getBusinessId(req),
      id,
    );
    return res.status(200).json({ success: true, data: { balance } });
  } catch (err) {
    return sendSafeError(res, err, "Unable to read the store credit balance.");
  }
}

/**
 * Phase 2C: consent toggles only — scoped update endpoint (no general
 * customer editing exists yet). Requires customers.edit; audited.
 */
export async function patchCustomerConsent(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid customer ID." });
    }
    const schema = z.object({
      marketingOptIn: z.boolean().optional(),
      transactionalOptOut: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (
      !parsed.success ||
      (parsed.data.marketingOptIn === undefined &&
        parsed.data.transactionalOptOut === undefined)
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Nothing to update." });
    }
    const { db } = await import("../../db/schema/index.js");
    const { customers } = await import("../../db/schema/customers.js");
    const { eq, and } = await import("drizzle-orm");
    const [updated] = await db
      .update(customers)
      .set({
        ...(parsed.data.marketingOptIn !== undefined
          ? { marketingOptIn: parsed.data.marketingOptIn }
          : {}),
        ...(parsed.data.transactionalOptOut !== undefined
          ? { transactionalOptOut: parsed.data.transactionalOptOut }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(customers.id, id), eq(customers.businessId, getBusinessId(req))))
      .returning({ id: customers.id, marketingOptIn: customers.marketingOptIn, transactionalOptOut: customers.transactionalOptOut });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Customer not found." });
    }
    recordAudit({
      businessId: getBusinessId(req),
      actorUserId: req.user?.id ?? null,
      action: "customer.consent_updated",
      entityType: "customer",
      entityId: id,
      afterState: {
        marketingOptIn: updated.marketingOptIn,
        transactionalOptOut: updated.transactionalOptOut,
      },
    });
    return res.status(200).json({ success: true, data: updated });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the consent settings.");
  }
}
