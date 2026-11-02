import { SignJWT, jwtVerify } from "jose";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { users } from "../../db/schema/users.js";
import { userRoles } from "../../db/schema/userRoles.js";
import { rolePermissions } from "../../db/schema/rolePermissions.js";
import { permissions } from "../../db/schema/permissions.js";
import { WILDCARD_PERMISSION } from "../../rbac/permissions.js";
import { refreshTokens } from "../../db/schema/refreshTokens.js";
import { emailVerificationTokens } from "../../db/schema/emailVerificationTokens.js";
import { passwordResetTokens } from "../../db/schema/passwordResetTokens.js";
import { env } from "../../config/env.js";
import { sendEmail } from "../../services/email/email.service.js";
import { renderVerifyEmail, renderPasswordReset } from "../../services/email/email.templates.js";
import { generateOpaqueToken, hashToken } from "../../utils/tokens.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import {
  addDays,
  computeSubscriptionState,
  type SubscriptionState,
} from "../../utils/subscription.js";
import {
  ConflictError,
  UnauthorizedError,
} from "../../utils/handleError.js";
import { businesses } from "../../db/schema/businesses.js";
import { businessMemberships } from "../../db/schema/businessMemberships.js";
import { roles } from "../../db/schema/roles.js";
import { subscriptions } from "../../db/schema/subscriptions.js";
import type { RegisterInput, LoginInput } from "./auth.validation.js";

const jwtSecret = new TextEncoder().encode(env.jwtSecret);

/** Public shape of a user — never includes passwordHash or token data. */
export interface SafeUser {
  id: number;
  email: string;
  fullName: string;
  phone: string | null;
  platformRole: "none" | "platform_admin";
  emailVerified: boolean;
}

function toSafeUser(row: {
  id: number;
  email: string;
  fullName: string;
  phone: string | null;
  platformRole: "none" | "platform_admin";
  emailVerifiedAt: Date | null;
}): SafeUser {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    phone: row.phone,
    platformRole: row.platformRole,
    emailVerified: row.emailVerifiedAt !== null,
  };
}

/** Shape returned by the users insert/select used across this service. */
type UserRow = {
  id: number;
  email: string;
  fullName: string;
  phone: string | null;
  platformRole: "none" | "platform_admin";
  emailVerifiedAt: Date | null;
};

export interface SessionTokens {
  accessToken: string;
  /** Raw refresh token — only ever returned once, for the HttpOnly cookie. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

async function issueAccessToken(userId: number): Promise<string> {
  return new SignJWT({ typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${env.accessTokenTtlMinutes}m`)
    .sign(jwtSecret);
}

async function issueRefreshToken(
  userId: number,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<{ refreshToken: string; expiresAt: Date }> {
  const refreshToken = generateOpaqueToken();
  const expiresAt = addDays(new Date(), env.refreshTokenTtlDays);
  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashToken(refreshToken),
    expiresAt,
    // A freshly issued token has been "used" the moment it is handed out —
    // keeps the sessions card's last-active non-null.
    lastUsedAt: new Date(),
    // Columns are varchar(45)/varchar(255) — truncate defensively.
    ipAddress: meta.ip?.slice(0, 45),
    userAgent: meta.userAgent?.slice(0, 255),
  });
  return { refreshToken, expiresAt };
}

async function revokeAllRefreshTokensForUser(userId: number): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
    );
}

export interface BusinessContextSummary {
  businessId: number;
  businessName: string;
  businessSlug: string;
  roleSlug: string;
  roleName: string;
  /** All roles the user holds in this business. */
  roles: { id: number; name: string; slug: string }[];
  /** Effective permission keys (the owner holds the "*" wildcard). */
  permissions: string[];
  subscription: SubscriptionState;
}

export interface MeResult {
  user: SafeUser;
  businesses: BusinessContextSummary[];
}

/**
 * Creates the user account and an email-verification token in one
 * transaction, then sends the verification email through the configured
 * provider (console in development). A failed send never fails the
 * registration — the user can request a fresh link via resend-verification.
 */
export async function registerUser(input: RegisterInput): Promise<SafeUser> {
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email));
    if (existing) {
      throw new ConflictError("An account with this email already exists.");
    }

    const passwordHash = await hashPassword(input.password);
    let user: UserRow | undefined;
    try {
      [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          phone: input.phone ?? null,
          // platformRole stays at its default ("none") — never set from input.
        })
        .returning({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          phone: users.phone,
          platformRole: users.platformRole,
          emailVerifiedAt: users.emailVerifiedAt,
        });
    } catch (err) {
      // Concurrent registration with the same email loses the unique-index
      // race (23505) — surface it as the same 409 as the pre-check.
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "23505"
      ) {
        throw new ConflictError("An account with this email already exists.");
      }
      throw err;
    }
    if (!user) {
      throw new Error("User insert returned no row.");
    }

    const verificationToken = generateOpaqueToken();
    await tx.insert(emailVerificationTokens).values({
      userId: user.id,
      tokenHash: hashToken(verificationToken),
      expiresAt: new Date(
        Date.now() + env.emailVerificationTokenTtlHours * 60 * 60 * 1000,
      ),
    });

    return { user: toSafeUser(user), verificationToken };
  });

  // After commit: delivery is best-effort by design.
  const rendered = renderVerifyEmail(
    `${env.appUrl}/verify-email?token=${result.verificationToken}`,
  );
  const delivery = await sendEmail({ to: result.user.email, ...rendered });
  if (!delivery.ok) {
    console.error(
      `Verification email delivery failed for ${result.user.email}: ${delivery.error}`,
    );
  }

  return result.user;
}

/**
 * Issues a fresh verification token and email for the signed-in user.
 * Throttled to one request per minute (client-side retries after this are
 * pointless anyway — the previous email is still valid).
 */
export async function resendVerificationEmail(
  userId: number,
): Promise<{ throttled: boolean }> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) {
    throw new UnauthorizedError("Your session is invalid or has expired.");
  }
  if (user.emailVerifiedAt !== null) {
    return { throttled: false }; // already verified — nothing to do
  }

  const lastIssued = await latestVerificationTokenIssuedAt(userId);
  if (
    lastIssued !== null &&
    Date.now() - lastIssued.getTime() < 60_000
  ) {
    return { throttled: true };
  }

  const verificationToken = generateOpaqueToken();
  await db.insert(emailVerificationTokens).values({
    userId: user.id,
    tokenHash: hashToken(verificationToken),
    expiresAt: new Date(
      Date.now() + env.emailVerificationTokenTtlHours * 60 * 60 * 1000,
    ),
  });

  const rendered = renderVerifyEmail(
    `${env.appUrl}/verify-email?token=${verificationToken}`,
  );
  const delivery = await sendEmail({ to: user.email, ...rendered });
  if (!delivery.ok) {
    console.error(
      `Verification email delivery failed for ${user.email}: ${delivery.error}`,
    );
  }
  return { throttled: false };
}

/**
 * Creates a single-use password-reset token and emails the link. The
 * response is identical whether or not the email exists — account existence
 * is never revealed through this endpoint. Unknown emails are silently
 * dropped here; the caller still reports success to the client.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email));
  if (!user) return;

  const resetToken = generateOpaqueToken();
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashToken(resetToken),
    expiresAt: new Date(
      Date.now() + env.passwordResetTokenTtlHours * 60 * 60 * 1000,
    ),
  });

  const rendered = renderPasswordReset(
    `${env.appUrl}/reset-password?token=${resetToken}`,
  );
  const delivery = await sendEmail({ to: user.email, ...rendered });
  if (!delivery.ok) {
    console.error(
      `Password-reset email delivery failed for ${user.email}: ${delivery.error}`,
    );
  }
}

/**
 * Consumes a password-reset token: sets the new password, marks the token
 * used, and revokes every refresh token (an attacker holding a stolen
 * session must not survive a legitimate password reset).
 */
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const tokenHash = hashToken(token);
    const [record] = await tx
      .select({
        id: passwordResetTokens.id,
        userId: passwordResetTokens.userId,
        expiresAt: passwordResetTokens.expiresAt,
        usedAt: passwordResetTokens.usedAt,
      })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash));

    if (!record || record.usedAt !== null) return false;
    if (record.expiresAt.getTime() <= Date.now()) return false;

    const passwordHash = await hashPassword(newPassword);
    const claimed = await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.id, record.id), isNull(passwordResetTokens.usedAt)))
      .returning({ id: passwordResetTokens.id });
    if (claimed.length === 0) return false; // concurrent use lost the race

    await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, record.userId));
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.userId, record.userId),
          isNull(refreshTokens.revokedAt),
        ),
      );
    return true;
  });
}

/**
 * A pre-computed Argon2id hash of an unknown random password, compared
 * against when the email does not exist so successful and failed logins take
 * similar time (timing-attack mitigation).
 */
const DUMMY_PASSWORD_HASH = await hashPassword(generateOpaqueToken());

const INVALID_CREDENTIALS = new UnauthorizedError(
  "Invalid email or password.",
);

export async function loginUser(
  input: LoginInput,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<{ user: SafeUser; tokens: SessionTokens }> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
      platformRole: users.platformRole,
      emailVerifiedAt: users.emailVerifiedAt,
      passwordHash: users.passwordHash,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.email, input.email));

  const passwordOk = await verifyPassword(
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    input.password,
  );
  if (!user || !user.isActive || !passwordOk) {
    throw INVALID_CREDENTIALS;
  }

  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

  const accessToken = await issueAccessToken(user.id);
  const refresh = await issueRefreshToken(user.id, meta);

  return {
    user: toSafeUser(user),
    tokens: {
      accessToken,
      refreshToken: refresh.refreshToken,
      refreshTokenExpiresAt: refresh.expiresAt,
    },
  };
}

/**
 * Grace window for refresh-token rotation. A client retrying a refresh (or a
 * second tab) can present a token that was legitimately rotated moments ago;
 * treating that as an attack would mass-revoke the user's fresh sessions.
 * Reuse within this window is rejected without collateral revocation; reuse
 * after it is treated as a compromised session.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

/**
 * Pure decision for a presented token whose stored record is already revoked:
 * should reuse trigger revoking ALL of the user's sessions?
 * - "immediate" — revoked long ago (or never legitimately rotated): attack.
 * - "grace" — revoked within the grace window: likely a concurrent retry.
 */
export function classifyRevokedTokenReuse(
  revokedAt: Date,
  now: Date = new Date(),
): "immediate" | "grace" {
  return now.getTime() - revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS
    ? "grace"
    : "immediate";
}

/**
 * Rotates the presented refresh token.
 *
 * The revocation is an atomic conditional update (`WHERE revoked_at IS NULL
 * ... RETURNING`), so two concurrent rotations of the same token cannot both
 * succeed: exactly one wins, the loser sees the token as revoked.
 *
 * Reuse of a revoked token after the grace window is treated as a
 * compromised session: every refresh token for that user is revoked. Reuse
 * within the window is rejected without collateral revocation.
 */
export async function rotateRefreshToken(
  presentedToken: string,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<{ user: SafeUser; tokens: SessionTokens }> {
  const presentedHash = hashToken(presentedToken);
  const [stored] = await db
    .select({
      id: refreshTokens.id,
      userId: refreshTokens.userId,
      expiresAt: refreshTokens.expiresAt,
      revokedAt: refreshTokens.revokedAt,
    })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, presentedHash));

  if (!stored) {
    throw new UnauthorizedError("Your session is invalid or has expired.");
  }

  if (stored.revokedAt !== null) {
    if (classifyRevokedTokenReuse(stored.revokedAt) === "immediate") {
      await revokeAllRefreshTokensForUser(stored.userId);
      console.warn(
        `Refresh-token reuse (post-grace) detected for user ${stored.userId}; all sessions revoked.`,
      );
    }
    throw new UnauthorizedError("Your session is invalid or has expired.");
  }

  if (stored.expiresAt.getTime() <= Date.now()) {
    throw new UnauthorizedError("Your session is invalid or has expired.");
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
      platformRole: users.platformRole,
      emailVerifiedAt: users.emailVerifiedAt,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, stored.userId));

  if (!user || !user.isActive) {
    throw new UnauthorizedError("Your session is invalid or has expired.");
  }

  // Atomic claim: exactly one concurrent rotation wins. A loser observes
  // zero updated rows and falls into the (grace) reuse path. lastUsedAt is
  // stamped for the sessions "last active" display.
  const claimed = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), lastUsedAt: new Date() })
    .where(
      and(eq(refreshTokens.id, stored.id), isNull(refreshTokens.revokedAt)),
    )
    .returning({ id: refreshTokens.id });
  if (claimed.length === 0) {
    throw new UnauthorizedError("Your session is invalid or has expired.");
  }

  const accessToken = await issueAccessToken(user.id);
  const refresh = await issueRefreshToken(user.id, meta);

  return {
    user: toSafeUser(user),
    tokens: {
      accessToken,
      refreshToken: refresh.refreshToken,
      refreshTokenExpiresAt: refresh.expiresAt,
    },
  };
}

/** Revokes the presented refresh token if it is still active. Idempotent. */
export async function revokeRefreshToken(presentedToken: string): Promise<void> {
  const presentedHash = hashToken(presentedToken);
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(refreshTokens.tokenHash, presentedHash), isNull(refreshTokens.revokedAt)),
    );
}

export async function getCurrentUserContext(
  userId: number,
): Promise<MeResult> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
      platformRole: users.platformRole,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) {
    throw new UnauthorizedError("Your session is invalid or has expired.");
  }

  const memberships = await db
    .select({
      businessId: businesses.id,
      businessName: businesses.name,
      businessSlug: businesses.slug,
      roleId: businessMemberships.roleId,
      roleSlug: roles.slug,
      roleName: roles.name,
    })
    .from(businessMemberships)
    .innerJoin(businesses, eq(businesses.id, businessMemberships.businessId))
    .innerJoin(roles, eq(roles.id, businessMemberships.roleId))
    .where(
      and(
        eq(businessMemberships.userId, userId),
        eq(businessMemberships.status, "active"),
      ),
    );

  const openSubscriptions =
    memberships.length === 0
      ? []
      : await db
          .select({
            businessId: subscriptions.businessId,
            status: subscriptions.status,
            currentPeriodEnd: subscriptions.currentPeriodEnd,
          })
          .from(subscriptions)
          .where(
            and(
              inArray(subscriptions.status, ["trialing", "active", "past_due"]),
              inArray(
                subscriptions.businessId,
                memberships.map((m) => m.businessId),
              ),
              gt(
                subscriptions.currentPeriodEnd,
                new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
              ),
            ),
          );

  const subscriptionByBusiness = new Map(
    openSubscriptions.map((sub) => [sub.businessId, sub]),
  );

  // Roles and effective permissions per business. The owner holds the
  // wildcard ("*") so the account can never be locked out; everyone else
  // gets the union of their assigned roles' permissions.
  const assignments: {
    userId: number;
    businessId: number;
    roleId: number;
    roleName: string;
    roleSlug: string;
  }[] =
    memberships.length === 0
      ? []
      : await db
          .select({
            userId: userRoles.userId,
            businessId: userRoles.businessId,
            roleId: userRoles.roleId,
            roleName: roles.name,
            roleSlug: roles.slug,
          })
          .from(userRoles)
          .innerJoin(roles, eq(roles.id, userRoles.roleId))
          .where(
            inArray(
              userRoles.businessId,
              memberships.map((m) => m.businessId),
            ),
          );

  // Permissions must cover EVERY assigned role (union across roles), not
  // just each membership's primary role.
  const allRoleIds = [
    ...new Set([
      ...assignments.map((a) => a.roleId),
      ...memberships.map((m) => m.roleId),
    ]),
  ];
  const permissionRows: { roleId: number; key: string }[] =
    allRoleIds.length === 0
      ? []
      : await db
          .select({ roleId: rolePermissions.roleId, key: permissions.key })
          .from(rolePermissions)
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(inArray(rolePermissions.roleId, allRoleIds));

  const rolesByBusiness = new Map<number, { id: number; name: string; slug: string }[]>();
  for (const m of memberships) {
    rolesByBusiness.set(m.businessId, []);
  }
  for (const assignment of assignments) {
    if (assignment.userId !== userId) continue;
    const list = rolesByBusiness.get(assignment.businessId);
    if (list && !list.some((r) => r.id === assignment.roleId)) {
      list.push({
        id: assignment.roleId,
        name: assignment.roleName,
        slug: assignment.roleSlug,
      });
    }
  }
  const permissionKeysByRole = new Map<number, Set<string>>();
  for (const row of permissionRows) {
    const set = permissionKeysByRole.get(row.roleId) ?? new Set<string>();
    set.add(row.key);
    permissionKeysByRole.set(row.roleId, set);
  }

  return {
    user: toSafeUser(user),
    businesses: memberships.map((membership) => {
      const sub = subscriptionByBusiness.get(membership.businessId);
      const permissionsList: string[] =
        membership.roleSlug === "owner"
          ? [WILDCARD_PERMISSION]
          : [
              ...new Set(
                assignments
                  .filter(
                    (a) =>
                      a.userId === userId &&
                      a.businessId === membership.businessId,
                  )
                  .flatMap((a) => [
                    ...(permissionKeysByRole.get(a.roleId) ?? []),
                  ]),
              ),
            ];
      // Defensive: the membership's primary role is always part of the
      // effective set even if its user_roles row is somehow missing.
      if (
        membership.roleSlug !== "owner" &&
        permissionsList.length === 0 &&
        !assignments.some(
          (a) => a.userId === userId && a.businessId === membership.businessId,
        )
      ) {
        permissionsList.push(
          ...(permissionKeysByRole.get(membership.roleId) ?? []),
        );
      }
      const { roleId: _primaryRoleId, ...membershipFields } = membership;
      void _primaryRoleId;
      return {
        ...membershipFields,
        roles: rolesByBusiness.get(membership.businessId) ?? [],
        permissions: permissionsList,
        subscription: computeSubscriptionState(sub ?? null),
      };
    }),
  };
}

/**
 * Updates the signed-in user's own profile fields. Email is deliberately
 * not editable here (it is the account identifier and verification anchor).
 */
export async function updateProfile(
  userId: number,
  input: { fullName?: string | undefined; phone?: string | undefined },
): Promise<SafeUser> {
  const [updated] = await db
    .update(users)
    .set({
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
      platformRole: users.platformRole,
      emailVerifiedAt: users.emailVerifiedAt,
    });
  if (!updated) {
    throw new UnauthorizedError("Your session is invalid or has expired.");
  }
  return toSafeUser(updated);
}

/**
 * Changes the password after verifying the current one, then revokes every
 * refresh token — the caller is signed out everywhere and must sign in
 * again with the new password (their current access token keeps working
 * until it expires, at most 15 minutes).
 * Returns false when the current password is wrong.
 */
export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  const [user] = await db
    .select({ passwordHash: users.passwordHash, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId));
  if (!user || !user.isActive) return false;

  const currentOk = await verifyPassword(user.passwordHash, currentPassword);
  if (!currentOk) return false;

  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, userId));
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
        ),
      );
  });
  return true;
}

/**
 * Marks an email-verification token used and stamps the user's
 * emailVerifiedAt, in one transaction. Returns false for unknown, used, or
 * expired tokens.
 */
export async function verifyEmailToken(token: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const tokenHash = hashToken(token);
    const [record] = await tx
      .select({
        id: emailVerificationTokens.id,
        userId: emailVerificationTokens.userId,
        expiresAt: emailVerificationTokens.expiresAt,
        usedAt: emailVerificationTokens.usedAt,
      })
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.tokenHash, tokenHash));

    if (!record || record.usedAt !== null) return false;
    if (record.expiresAt.getTime() <= Date.now()) return false;

    await tx
      .update(emailVerificationTokens)
      .set({ usedAt: new Date() })
      .where(eq(emailVerificationTokens.id, record.id));
    await tx
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, record.userId));
    return true;
  });
}

/** Most recent verification token issue time, or null if none exists. */
export async function latestVerificationTokenIssuedAt(
  userId: number,
): Promise<Date | null> {
  const [record] = await db
    .select({ createdAt: emailVerificationTokens.createdAt })
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.userId, userId))
    .orderBy(desc(emailVerificationTokens.createdAt))
    .limit(1);
  return record?.createdAt ?? null;
}

// ---------------------------------------------------------------------------
// Active sessions (portal Settings)
// ---------------------------------------------------------------------------

export interface ActiveSession {
  id: number;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date | null;
  lastUsedAt: Date | null;
  expiresAt: Date;
}

export async function listActiveSessions(
  userId: number,
): Promise<ActiveSession[]> {
  const rows = await db
    .select({
      id: refreshTokens.id,
      ipAddress: refreshTokens.ipAddress,
      userAgent: refreshTokens.userAgent,
      createdAt: refreshTokens.createdAt,
      lastUsedAt: refreshTokens.lastUsedAt,
      expiresAt: refreshTokens.expiresAt,
    })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
        sql`${refreshTokens.expiresAt} > now()`,
      ),
    )
    .orderBy(desc(refreshTokens.createdAt))
    .limit(20);
  return rows;
}

/** Revokes one of the caller's own sessions; returns whether it existed. */
export async function revokeSession(
  userId: number,
  sessionId: number,
): Promise<boolean> {
  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.id, sessionId),
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
      ),
    )
    .returning({ id: refreshTokens.id });
  return revoked.length > 0;
}
