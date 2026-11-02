import express from "express";
import * as authController from "./auth.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import { authRateLimit, refreshRateLimit } from "../../middleware/rateLimit.js";

const router = express.Router();

// POST /api/auth/register
// Body: { fullName, email, password, phone? }
// 201 -> { success, message, user: { id, email, fullName, phone, platformRole, emailVerified } }
// 400 validation | 409 duplicate email
router.post("/api/auth/register", authRateLimit, authController.register);

// POST /api/auth/login
// Body: { email, password }
// 200 -> { success, accessToken, user }
// Sets HttpOnly refresh cookie (path=/api/auth).
// 400 validation | 401 invalid credentials (generic message)
router.post("/api/auth/login", authRateLimit, authController.login);

// POST /api/auth/refresh
// Cookie: ezpos_refresh_token (rotated on every call; reuse of a revoked
// token revokes all of that user's sessions).
// 200 -> { success, accessToken, user } | 401
router.post("/api/auth/refresh", refreshRateLimit, authController.refresh);

// POST /api/auth/logout
// Cookie: ezpos_refresh_token — revoked server-side, cookie cleared.
// 200 -> { success } (idempotent)
router.post("/api/auth/logout", authController.logout);

// GET /api/auth/me   (Authorization: Bearer <accessToken>)
// 200 -> { success, user, businesses: [{ businessId, businessName, businessSlug,
//          roleSlug, roleName, subscription: { status, accessMode, trial, currentPeriodEnd } }] }
router.get("/api/auth/me", requireAuth, authController.me);

// GET /api/auth/verify-email?token=...
// 200 -> { success } | 400 invalid/expired token
router.get("/api/auth/verify-email", authController.verifyEmail);

// POST /api/auth/resend-verification   (Authorization: Bearer <accessToken>)
// Issues a fresh verification email; throttled to one per minute.
router.post(
  "/api/auth/resend-verification",
  requireAuth,
  authRateLimit,
  authController.resendVerification,
);

// POST /api/auth/forgot-password
// Body: { email } — always 200 with identical wording (no account
// enumeration). Creates a single-use reset token and emails the link.
router.post(
  "/api/auth/forgot-password",
  authRateLimit,
  authController.forgotPassword,
);

// GET /api/auth/sessions   (Authorization: Bearer <accessToken>)
// Active (non-revoked, unexpired) sessions for the signed-in user.
router.get("/api/auth/sessions", requireAuth, authController.getSessions);

// DELETE /api/auth/sessions/:sessionId — revokes one of the caller's own
// sessions (ownership enforced in the service).
router.delete(
  "/api/auth/sessions/:sessionId",
  requireAuth,
  authController.revokeSessionById,
);

// PATCH /api/auth/me   (Authorization: Bearer <accessToken>)
// Body: { fullName?, phone? } — updates the signed-in user's own profile.
router.patch("/api/auth/me", requireAuth, authController.updateMe);

// POST /api/auth/change-password   (Authorization: Bearer <accessToken>)
// Body: { currentPassword, newPassword } — verifies the current password,
// then revokes all sessions (sign-in required with the new password).
router.post(
  "/api/auth/change-password",
  requireAuth,
  authRateLimit,
  authController.changeMyPassword,
);

// POST /api/auth/reset-password
// Body: { token, password } — consumes the token, sets the new password,
// revokes all sessions. 400 for unknown/used/expired tokens.
router.post(
  "/api/auth/reset-password",
  authRateLimit,
  authController.resetPasswordHandler,
);

export default router;
