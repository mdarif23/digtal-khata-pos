import type { Request, Response } from "express";
import * as expensesService from "./expenses.service.js";
import * as attachmentsService from "./expenses.attachments.service.js";
import { sendSafeError } from "../../utils/safeError.js";
import { getBusinessId } from "../../middleware/business.js";
import {
  getLocationId,
  resolveOptionalLocationParam,
} from "../../middleware/location.js";
import { WILDCARD_PERMISSION } from "../../rbac/permissions.js";
import {
  attachmentIdSchema,
  attachmentPresignSchema,
  attachmentRegisterSchema,
  expenseCategorySchema,
  expenseCategoryIdSchema,
  expenseIdSchema,
  expenseListQuerySchema,
  expensePaymentCreateSchema,
  expensePaymentIdSchema,
  expenseVoidSchema,
  expenseWriteSchema,
} from "./expenses.schema.js";

/** Caller identity + owner flag (mirrors the cashRegisters controller). */
function actor(req: Request): { userId: number; callerIsOwner: boolean } {
  if (!req.user || !req.membership) {
    throw new Error("actor() used on an unauthenticated route");
  }
  return {
    userId: req.user.id,
    callerIsOwner: req.membership.permissions.includes(WILDCARD_PERMISSION),
  };
}

/**
 * Validation failures use the platform-wide error envelope
 * ({ success: false, message, errors }) — this controller previously emitted
 * a bespoke shape without the success flag.
 */
function validationError(res: Response, message: string, errors: unknown) {
  return res.status(400).json({ success: false, message, errors });
}

export async function createExpense(req: Request, res: Response) {
  try {
    const parsed = expenseWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(
        res,
        "Invalid expense data",
        parsed.error.flatten(),
      );
    }
    const { userId, callerIsOwner } = actor(req);
    const created = await expensesService.createExpense(
      getBusinessId(req),
      getLocationId(req),
      userId,
      callerIsOwner,
      parsed.data,
    );
    res.status(201).json(created);
  } catch (err) {
    sendSafeError(res, err, "Unable to create the expense.");
  }
}

export async function updateExpense(req: Request, res: Response) {
  try {
    const id = expenseIdSchema.safeParse(req.params.id);
    const parsed = expenseWriteSchema.safeParse(req.body);
    if (!id.success || !parsed.success) {
      return validationError(res, "Invalid expense ID or expense data", {
        id: id.success ? undefined : id.error.flatten(),
        expense: parsed.success ? undefined : parsed.error.flatten(),
      });
    }
    const updated = await expensesService.updateExpense(
      getBusinessId(req),
      id.data,
      req.user!.id,
      parsed.data,
    );
    return res.json(updated);
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the expense.");
  }
}

export async function deleteExpense(req: Request, res: Response) {
  try {
    const id = expenseIdSchema.safeParse(req.params.id);
    if (!id.success) {
      return validationError(res, "Invalid expense ID", undefined);
    }
    const reason = expenseVoidSchema.safeParse(req.body ?? {});
    const voided = await expensesService.voidExpense(
      getBusinessId(req),
      id.data,
      req.user!.id,
      reason.success ? reason.data.reason : undefined,
    );
    // Same response shape as the pre-void hard delete — backward compatible.
    return res.json({ message: "Expense deleted successfully", data: voided });
  } catch (err) {
    return sendSafeError(res, err, "Unable to delete the expense.");
  }
}

export async function createExpenseCategory(req: Request, res: Response) {
  try {
    const parsed = expenseCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(
        res,
        "Invalid expense category",
        parsed.error.flatten(),
      );
    }
    const { userId } = actor(req);
    const category = await expensesService.createExpenseCategory(
      getBusinessId(req),
      parsed.data,
      userId,
    );
    return res.status(201).json(category);
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the expense category.");
  }
}

export async function updateExpenseCategory(req: Request, res: Response) {
  try {
    const id = expenseCategoryIdSchema.safeParse(req.params.id);
    const parsed = expenseCategorySchema.safeParse(req.body);
    if (!id.success || !parsed.success) {
      return validationError(res, "Invalid expense category data", {
        id: id.success ? undefined : id.error.flatten(),
        category: parsed.success ? undefined : parsed.error.flatten(),
      });
    }
    const { userId } = actor(req);
    const category = await expensesService.updateExpenseCategory(
      getBusinessId(req),
      id.data,
      parsed.data,
      userId,
    );
    return res.json(category);
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the expense category.");
  }
}

export async function archiveExpenseCategory(req: Request, res: Response) {
  try {
    const id = expenseCategoryIdSchema.safeParse(req.params.id);
    if (!id.success) {
      return validationError(res, "Invalid expense category ID", undefined);
    }
    const { userId } = actor(req);
    const category = await expensesService.archiveExpenseCategory(
      getBusinessId(req),
      id.data,
      userId,
    );
    return res.json({ success: true, data: category });
  } catch (err) {
    return sendSafeError(res, err, "Unable to archive the expense category.");
  }
}

export async function restoreExpenseCategory(req: Request, res: Response) {
  try {
    const id = expenseCategoryIdSchema.safeParse(req.params.id);
    if (!id.success) {
      return validationError(res, "Invalid expense category ID", undefined);
    }
    const { userId } = actor(req);
    const category = await expensesService.restoreExpenseCategory(
      getBusinessId(req),
      id.data,
      userId,
    );
    return res.json({ success: true, data: category });
  } catch (err) {
    return sendSafeError(res, err, "Unable to restore the expense category.");
  }
}

export async function getExpenses(req: Request, res: Response) {
  try {
    const parsed = expenseListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return validationError(
        res,
        "Invalid expense filters",
        parsed.error.flatten(),
      );
    }
    const locationId = await resolveOptionalLocationParam(req);
    const { rows, meta } = await expensesService.listExpenses(getBusinessId(req), {
      ...parsed.data,
      locationId,
    });
    return res.json({ success: true, data: rows, meta });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load expenses.");
  }
}

export async function exportExpenses(req: Request, res: Response) {
  try {
    const parsed = expenseListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return validationError(
        res,
        "Invalid expense filters",
        parsed.error.flatten(),
      );
    }
    const locationId = await resolveOptionalLocationParam(req);
    const rows = await expensesService.exportExpenses(getBusinessId(req), {
      ...parsed.data,
      locationId,
    });
    return res.json({ success: true, data: rows });
  } catch (err) {
    return sendSafeError(res, err, "Unable to export expenses.");
  }
}

export async function getExpense(req: Request, res: Response) {
  try {
    const id = expenseIdSchema.safeParse(req.params.id);
    if (!id.success) {
      return validationError(res, "Invalid expense ID", undefined);
    }
    const expense = await expensesService.getExpense(getBusinessId(req), id.data);
    return res.json({ success: true, data: expense });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load the expense.");
  }
}

export async function getExpenseCategories(req: Request, res: Response) {
  try {
    const includeArchived = req.query.include_archived === "true";
    const categories = await expensesService.getExpenseCategories(
      getBusinessId(req),
      includeArchived,
    );
    return res.json(categories);
  } catch (err) {
    return sendSafeError(res, err, "Unable to load expense categories.");
  }
}

// ---------------------------------------------------------------------------
// Settlement payments (Phase 2)
// ---------------------------------------------------------------------------

export async function getExpensePayments(req: Request, res: Response) {
  try {
    const id = expenseIdSchema.safeParse(req.params.id);
    if (!id.success) {
      return validationError(res, "Invalid expense ID", undefined);
    }
    const payments = await expensesService.listExpensePayments(
      getBusinessId(req),
      id.data,
    );
    return res.json({ success: true, data: payments });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load the payment history.");
  }
}

export async function createExpensePayment(req: Request, res: Response) {
  try {
    const id = expenseIdSchema.safeParse(req.params.id);
    const parsed = expensePaymentCreateSchema.safeParse(req.body);
    if (!id.success || !parsed.success) {
      return validationError(res, "Invalid payment data", {
        id: id.success ? undefined : id.error.flatten(),
        payment: parsed.success ? undefined : parsed.error.flatten(),
      });
    }
    const { userId, callerIsOwner } = actor(req);
    const result = await expensesService.recordExpensePayment(
      getBusinessId(req),
      id.data,
      userId,
      callerIsOwner,
      parsed.data,
    );
    // A retried identical submission returns the original settlement — 200,
    // not 201, with duplicate:true so clients can detect the replay.
    return res
      .status(result.duplicate ? 200 : 201)
      .json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to record the payment.");
  }
}

export async function deleteExpensePayment(req: Request, res: Response) {
  try {
    const id = expenseIdSchema.safeParse(req.params.id);
    const paymentId = expensePaymentIdSchema.safeParse(req.params.paymentId);
    if (!id.success || !paymentId.success) {
      return validationError(res, "Invalid expense or payment ID", undefined);
    }
    const { userId } = actor(req);
    await expensesService.voidExpensePayment(
      getBusinessId(req),
      id.data,
      paymentId.data,
      userId,
    );
    return res.json({ success: true, message: "Payment voided successfully" });
  } catch (err) {
    return sendSafeError(res, err, "Unable to void the payment.");
  }
}

// ---------------------------------------------------------------------------
// Attachments (Phase 4) — presigned-PUT flow, bytes never touch the API.
// ---------------------------------------------------------------------------

export async function presignExpenseAttachment(req: Request, res: Response) {
  try {
    const id = expenseIdSchema.safeParse(req.params.id);
    const parsed = attachmentPresignSchema.safeParse(req.body);
    if (!id.success || !parsed.success) {
      return validationError(res, "Invalid attachment data", {
        id: id.success ? undefined : id.error.flatten(),
        attachment: parsed.success ? undefined : parsed.error.flatten(),
      });
    }
    const data = await attachmentsService.presignExpenseAttachment(
      getBusinessId(req),
      id.data,
      parsed.data,
    );
    return res.json({ success: true, data });
  } catch (err) {
    return sendSafeError(res, err, "Unable to prepare the attachment upload.");
  }
}

export async function registerExpenseAttachment(req: Request, res: Response) {
  try {
    const id = expenseIdSchema.safeParse(req.params.id);
    const parsed = attachmentRegisterSchema.safeParse(req.body);
    if (!id.success || !parsed.success) {
      return validationError(res, "Invalid attachment data", {
        id: id.success ? undefined : id.error.flatten(),
        attachment: parsed.success ? undefined : parsed.error.flatten(),
      });
    }
    const { userId } = actor(req);
    const attachment = await attachmentsService.registerExpenseAttachment(
      getBusinessId(req),
      id.data,
      userId,
      parsed.data,
    );
    return res.status(201).json({ success: true, data: attachment });
  } catch (err) {
    return sendSafeError(res, err, "Unable to attach the file.");
  }
}

export async function getAttachmentDownloadUrl(req: Request, res: Response) {
  try {
    const id = attachmentIdSchema.safeParse(req.params.attachmentId);
    if (!id.success) {
      return validationError(res, "Invalid attachment ID", undefined);
    }
    const data = await attachmentsService.getAttachmentDownloadUrl(
      getBusinessId(req),
      id.data,
    );
    return res.json({ success: true, data });
  } catch (err) {
    return sendSafeError(res, err, "Unable to open the attachment.");
  }
}

export async function deleteAttachment(req: Request, res: Response) {
  try {
    const id = attachmentIdSchema.safeParse(req.params.attachmentId);
    if (!id.success) {
      return validationError(res, "Invalid attachment ID", undefined);
    }
    const { userId } = actor(req);
    const deleted = await attachmentsService.deleteExpenseAttachment(
      getBusinessId(req),
      id.data,
      userId,
    );
    return res.json({ success: true, data: deleted });
  } catch (err) {
    return sendSafeError(res, err, "Unable to delete the attachment.");
  }
}
