import type { Response } from "express";
import { error } from "node:console";
//1. for missing items (HTTP 404)
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
//2. for missing data or bad logic (HTTP 400)
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}
//3. For permissions (HTTP 403)
export class ForbiddenError extends Error {
  /** Optional machine-readable code (e.g. PLAN_LIMIT_REACHED) for clients. */
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ForbiddenError";
    this.code = code;
  }
}
//4. for database conflicts, like duplicate emails or barcode (HTTP 409)
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictsError";
  }
}

/**
 * P3 Phase 2 (D10): an expired batch was selected while the business policy
 * blocks it (or no approval accompanied it under 'allow_with_approval'). A
 * ConflictError subclass (still HTTP 409) so offline sync can single it out
 * for the `expired_batch_selected` sync-conflict reason via instanceof.
 */
export class ExpiredBatchError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = "ExpiredBatchError";
  }
}
//5. for missing or invalid authentication (HTTP 401)
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}
/**
 * Legacy helper — no module calls it anymore (new code uses `sendSafeError`).
 * Kept only so the error classes above stay co-located; its fallback returns
 * a generic message instead of raw `err.message` so it can never leak
 * internals if it is ever called again.
 */
export function handleError(res: Response, err: unknown) {
  console.error(err);
  if (err instanceof BadRequestError) {
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err instanceof ConflictError) {
    return res.status(409).json({ success: false, message: err.message });
  }
  if (err instanceof NotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  res
    .status(500)
    .json({ success: false, message: "An unexpected server error occurred." });
}
