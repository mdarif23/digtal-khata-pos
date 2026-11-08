import type { Request, Response } from "express";
import type { ZodType } from "zod";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import * as financeService from "./finance.service.js";
import {
  activateFinanceSchema,
  createAccountSchema,
  createJournalEntrySchema,
  createPaymentAccountSchema,
  listEntriesQuerySchema,
  reverseEntrySchema,
  updateAccountSchema,
  updateDraftEntrySchema,
  updatePaymentAccountSchema,
} from "./finance.schema.js";
import type {
  ActivateFinanceInput,
  CreateAccountInput,
  CreateJournalEntryInput,
  CreatePaymentAccountInput,
  ListEntriesQuery,
  ReverseEntryInput,
  UpdateAccountInput,
  UpdateDraftEntryInput,
  UpdatePaymentAccountInput,
} from "./finance.schema.js";

/**
 * Finance & Growth controllers (Stage 3 ledger foundation). Every handler
 * reads the server-verified businessId from requireBusinessContext — no
 * handler ever trusts a client-sent business id.
 */

/** Platform-wide validation error envelope ({ success, message, errors }). */
function validationError(res: Response, message: string, errors: unknown) {
  return res.status(400).json({ success: false, message, errors });
}

function parseId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Invalid id parameter");
  }
  return id;
}

function parseBody<T>(
  res: Response,
  schema: ZodType<T>,
  req: Request,
  message: string,
): T {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    validationError(res, message, parsed.error);
    throw new Error("validation-short-circuit");
  }
  return parsed.data;
}

export async function getStatus(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const status = await financeService.getFinanceStatus(businessId);
    res.json(status);
  } catch (err) {
    sendSafeError(res, err, "Failed to load finance status.");
  }
}

export async function activate(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, activateFinanceSchema, req, "Invalid activation payload.");
    const result = await financeService.activateFinance(
      businessId,
      input as ActivateFinanceInput,
      req.user!.id,
    );
    res.status(201).json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to activate the finance ledger.");
  }
}

export async function listAccounts(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const rows = await financeService.listAccounts(businessId, {
      includeArchived: req.query.include_archived === "true",
      ...(typeof req.query.type === "string" ? { type: req.query.type } : {}),
    });
    res.json({ rows });
  } catch (err) {
    sendSafeError(res, err, "Failed to load accounts.");
  }
}

export async function createAccount(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, createAccountSchema, req, "Invalid account payload.");
    const account = await financeService.createAccount(
      businessId,
      input as CreateAccountInput,
      req.user!.id,
    );
    res.status(201).json(account);
  } catch (err) {
    sendSafeError(res, err, "Failed to create account.");
  }
}

export async function updateAccount(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, updateAccountSchema, req, "Invalid account payload.");
    const account = await financeService.updateAccount(
      businessId,
      parseId(req),
      input as UpdateAccountInput,
      req.user!.id,
    );
    res.json(account);
  } catch (err) {
    sendSafeError(res, err, "Failed to update account.");
  }
}

export async function archiveAccount(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const account = await financeService.archiveAccount(
      businessId,
      parseId(req),
      req.user!.id,
    );
    res.json(account);
  } catch (err) {
    sendSafeError(res, err, "Failed to archive account.");
  }
}

export async function getBalances(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const rows = await financeService.getBalances(businessId, {
      ...(typeof req.query.from_date === "string"
        ? { fromDate: req.query.from_date }
        : {}),
      ...(typeof req.query.to_date === "string"
        ? { toDate: req.query.to_date }
        : {}),
    });
    res.json({ rows });
  } catch (err) {
    sendSafeError(res, err, "Failed to load balances.");
  }
}

export async function getTrialBalance(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const result = await financeService.getTrialBalance(
      businessId,
      typeof req.query.to_date === "string" ? req.query.to_date : undefined,
    );
    res.json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to build the trial balance.");
  }
}

export async function listPaymentAccounts(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const rows = await financeService.listPaymentAccounts(businessId);
    res.json({ rows });
  } catch (err) {
    sendSafeError(res, err, "Failed to load payment accounts.");
  }
}

export async function createPaymentAccount(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, createPaymentAccountSchema, req, "Invalid payment account payload.");
    const account = await financeService.createPaymentAccount(
      businessId,
      input as CreatePaymentAccountInput,
      req.user!.id,
    );
    res.status(201).json(account);
  } catch (err) {
    sendSafeError(res, err, "Failed to create payment account.");
  }
}

export async function updatePaymentAccount(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, updatePaymentAccountSchema, req, "Invalid payment account payload.");
    const account = await financeService.updatePaymentAccount(
      businessId,
      parseId(req),
      input as UpdatePaymentAccountInput,
      req.user!.id,
    );
    res.json(account);
  } catch (err) {
    sendSafeError(res, err, "Failed to update payment account.");
  }
}

export async function listPeriods(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const rows = await financeService.listPeriods(businessId);
    res.json({ rows });
  } catch (err) {
    sendSafeError(res, err, "Failed to load accounting periods.");
  }
}

export async function closePeriod(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const period = await financeService.closePeriod(
      businessId,
      parseId(req),
      req.user!.id,
    );
    res.json(period);
  } catch (err) {
    sendSafeError(res, err, "Failed to close the accounting period.");
  }
}

export async function reopenPeriod(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const period = await financeService.reopenPeriod(
      businessId,
      parseId(req),
      req.user!.id,
    );
    res.json(period);
  } catch (err) {
    sendSafeError(res, err, "Failed to reopen the accounting period.");
  }
}

export async function listEntries(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const parsed = listEntriesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return validationError(res, "Invalid query parameters.", parsed.error);
    }
    const result = await financeService.listEntries(
      businessId,
      parsed.data as ListEntriesQuery,
    );
    res.json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to load journal entries.");
  }
}

export async function getEntry(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const entry = await financeService.getEntry(businessId, parseId(req));
    res.json(entry);
  } catch (err) {
    sendSafeError(res, err, "Failed to load the journal entry.");
  }
}

export async function createEntry(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, createJournalEntrySchema, req, "Invalid journal entry payload.");
    const result = await financeService.createJournalEntry(
      businessId,
      input as CreateJournalEntryInput,
      req.user!.id,
    );
    res.status(201).json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to create the journal entry.");
  }
}

export async function updateDraft(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, updateDraftEntrySchema, req, "Invalid journal entry payload.");
    const entry = await financeService.updateDraftEntry(
      businessId,
      parseId(req),
      input as UpdateDraftEntryInput,
      req.user!.id,
    );
    res.json(entry);
  } catch (err) {
    sendSafeError(res, err, "Failed to update the draft entry.");
  }
}

export async function postDraft(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const entry = await financeService.postDraftEntry(
      businessId,
      parseId(req),
      req.user!.id,
    );
    res.json(entry);
  } catch (err) {
    sendSafeError(res, err, "Failed to post the draft entry.");
  }
}

export async function deleteDraft(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const result = await financeService.deleteDraftEntry(
      businessId,
      parseId(req),
      req.user!.id,
    );
    res.json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to delete the draft entry.");
  }
}

export async function reverseEntry(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const input = parseBody(res, reverseEntrySchema, req, "Invalid reversal payload.");
    const result = await financeService.reversePostedEntry(
      businessId,
      parseId(req),
      input as ReverseEntryInput,
      req.user!.id,
    );
    res.status(201).json(result);
  } catch (err) {
    sendSafeError(res, err, "Failed to reverse the journal entry.");
  }
}
