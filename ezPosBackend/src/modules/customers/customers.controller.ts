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
    const { name, phone, address } = req.body;
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
