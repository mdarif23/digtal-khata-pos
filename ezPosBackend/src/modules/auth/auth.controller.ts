import type { Request, Response } from "express";
import {
  changePassword,
  getCurrentUserContext,
  loginUser,
  registerUser,
  requestPasswordReset,
  resetPassword,
  resendVerificationEmail,
  revokeRefreshToken,
  rotateRefreshToken,
  updateProfile,
  verifyEmailToken,
} from "./auth.service.js";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
  verifyEmailSchema,
} from "./auth.validation.js";
import { env } from "../../config/env.js";
import { sendSafeError } from "../../utils/safeError.js";
import { UnauthorizedError } from "../../utils/handleError.js";

const REFRESH_COOKIE = "ezpos_refresh_token";

function clientMeta(req: Request): {
  ip: string | undefined;
  userAgent: string | undefined;
} {
  return {
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  };
}

function setRefreshCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax",
    path: "/api/auth",
    expires: expiresAt,
  });
}

function clearRefreshCookie(res: Response) {
  res.cookie(REFRESH_COOKIE, "", {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 0,
  });
}

export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const name = part.slice(0, eqIndex).trim();
    if (name === REFRESH_COOKIE) {
      return decodeURIComponent(part.slice(eqIndex + 1).trim());
    }
  }
  return null;
}

export async function register(req: Request, res: Response) {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message ?? "Invalid registration data.",
      });
    }
    const user = await registerUser(parsed.data);
    // 201: account created. Email delivery is not configured yet, so no
    // verification link is sent and none is claimed.
    return res.status(201).json({
      success: true,
      message:
        "Account created. You can sign in now; email verification will open once email delivery is configured.",
      user,
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the account right now.");
  }
}

export async function login(req: Request, res: Response) {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message ?? "Invalid login data.",
      });
    }
    const { user, tokens } = await loginUser(parsed.data, clientMeta(req));
    setRefreshCookie(res, tokens.refreshToken, tokens.refreshTokenExpiresAt);
    return res.status(200).json({
      success: true,
      accessToken: tokens.accessToken,
      user,
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to sign in right now.");
  }
}

export async function refresh(req: Request, res: Response) {
  try {
    const presented = readRefreshCookie(req);
    if (!presented) {
      throw new UnauthorizedError("No active session found.");
    }
    const { user, tokens } = await rotateRefreshToken(
      presented,
      clientMeta(req),
    );
    setRefreshCookie(res, tokens.refreshToken, tokens.refreshTokenExpiresAt);
    return res.status(200).json({
      success: true,
      accessToken: tokens.accessToken,
      user,
    });
  } catch (err) {
    clearRefreshCookie(res);
    return sendSafeError(res, err, "Unable to refresh the session.");
  }
}

export async function logout(req: Request, res: Response) {
  try {
    const presented = readRefreshCookie(req);
    if (presented) {
      await revokeRefreshToken(presented);
    }
    clearRefreshCookie(res);
    return res.status(200).json({ success: true, message: "Signed out." });
  } catch (err) {
    return sendSafeError(res, err, "Unable to sign out right now.");
  }
}

export async function me(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required." });
    }
    const context = await getCurrentUserContext(req.user.id);
    return res.status(200).json({ success: true, ...context });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load your account right now.");
  }
}

export async function verifyEmail(req: Request, res: Response) {
  try {
    const parsed = verifyEmailSchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, message: "A valid verification token is required." });
    }
    const verified = await verifyEmailToken(parsed.data.token);
    if (!verified) {
      return res.status(400).json({
        success: false,
        message: "This verification link is invalid or has expired.",
      });
    }
    return res
      .status(200)
      .json({ success: true, message: "Email verified. Thank you!" });
  } catch (err) {
    return sendSafeError(res, err, "Unable to verify the email right now.");
  }
}

export async function resendVerification(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required." });
    }
    const { throttled } = await resendVerificationEmail(req.user.id);
    if (throttled) {
      return res.status(429).json({
        success: false,
        message:
          "A verification email was just sent. Please wait a minute before requesting another.",
      });
    }
    return res.status(200).json({
      success: true,
      message: "Verification email sent. Check your inbox.",
    });
  } catch (err) {
    return sendSafeError(
      res,
      err,
      "Unable to send the verification email right now.",
    );
  }
}

/**
 * Always responds 200 with identical wording — whether or not the email
 * belongs to an account — so the endpoint cannot be used to enumerate
 * accounts.
 */
export async function forgotPassword(req: Request, res: Response) {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Enter a valid email address.",
    });
  }
  try {
    await requestPasswordReset(parsed.data.email);
    return res.status(200).json({
      success: true,
      message:
        "If an account exists for that email, a password-reset link is on its way.",
    });
  } catch (err) {
    // Same generic success shape on failure — never leak account existence.
    console.error("Password-reset request failed:", err);
    return res.status(200).json({
      success: true,
      message:
        "If an account exists for that email, a password-reset link is on its way.",
    });
  }
}

export async function resetPasswordHandler(req: Request, res: Response) {  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid reset data.",
    });
  }
  try {
    const ok = await resetPassword(parsed.data.token, parsed.data.password);
    if (!ok) {
      return res.status(400).json({
        success: false,
        message: "This reset link is invalid or has expired.",
      });
    }
    return res.status(200).json({
      success: true,
      message: "Password updated. Sign in with your new password.",
    });
  } catch (err) {
    return sendSafeError(
      res,
      err,
      "Unable to reset the password right now.",
    );
  }
}

export async function updateMe(req: Request, res: Response) {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid profile data.",
    });
  }
  try {
    const user = await updateProfile(req.user!.id, parsed.data);
    res.status(200).json({ success: true, message: "Profile updated.", user });
  } catch (err) {
    return sendSafeError(res, err, "Unable to update your profile right now.");
  }
}

export async function changeMyPassword(req: Request, res: Response) {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid password data.",
    });
  }
  try {
    const ok = await changePassword(
      req.user!.id,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    if (!ok) {
      return res.status(400).json({
        success: false,
        message: "Your current password is incorrect.",
      });
    }
    res.status(200).json({
      success: true,
      message:
        "Password changed. For your security you have been signed out — sign in again with the new password.",
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to change the password right now.");
  }
}
