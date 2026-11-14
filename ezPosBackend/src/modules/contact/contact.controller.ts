import type { Request, Response } from "express";
import * as contactService from "../contact/contact.service.js";
import { supplierSchema } from "./schemas/supplier.schema.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

export async function getSuppliers(req: Request, res: Response) {
  try {
    const suppliers = await contactService.getSuppliers(getBusinessId(req));
    return res.status(200).json(suppliers);
  } catch (err: unknown) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Unable to load suppliers." });
  }
}

export async function createSupplier(req: Request, res: Response) {
  try {
    const result = supplierSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid Supplier data",
        errors: result.error.flatten(),
      });
    }
    const supplier = await contactService.createSupplier(
      getBusinessId(req),
      result.data,
    );
    return res.status(201).json({
      message: "Supplier created successfully",
      data: supplier,
    });
  } catch (err: unknown) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Unable to create the supplier." });
  }
}

/** D1-05: correct a supplier's contact details / status. */
export async function updateSupplier(req: Request, res: Response) {
  try {
    const supplierId = Number(req.params.supplierId);
    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid supplier ID." });
    }
    const result = supplierSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid Supplier data",
        errors: result.error.flatten(),
      });
    }
    const supplier = await contactService.updateSupplier(
      getBusinessId(req),
      supplierId,
      result.data,
      req.user?.id ?? null,
    );
    return res.status(200).json({
      message: "Supplier updated successfully",
      data: supplier,
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the supplier.");
  }
}
