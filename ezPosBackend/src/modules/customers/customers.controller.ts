import type { Request, Response } from "express";
import * as customersService from "./customers.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

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
    res.status(201).json(customer);
  } catch (err) {
    sendSafeError(res, err, "Unable to create the customer.");
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
