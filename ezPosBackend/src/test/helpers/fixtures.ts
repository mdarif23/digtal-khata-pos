import assert from "node:assert/strict";

let counter = 0;

/**
 * Per-run unique email so suites never collide in the shared `ezpos_test`
 * database. Same shape the self-contained suites used before this helper
 * existed: `<prefix>-<timestamp>-<n>@example.test`.
 */
export function uniqueEmail(prefix = "test"): string {
  return `${prefix}-${Date.now()}-${(counter += 1)}@example.test`;
}

export interface OwnerCtx {
  token: string;
  businessId: number;
  userId: number;
  email: string;
}

/**
 * Registers a user, logs in, creates a business and (unless `noLocation`)
 * its default location — the owner context every suite starts from.
 * Behavior identical to the per-suite fixtures this replaces.
 */
export async function createOwnerCtx(
  baseUrl: string,
  businessName: string,
  options: { noLocation?: boolean } = {},
): Promise<OwnerCtx> {
  const email = uniqueEmail();
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fullName: "Test Owner",
      email,
      password: "strong-password-123",
    }),
  });
  assert.equal(reg.status, 201);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "strong-password-123" }),
  });
  const loginBody = (await login.json()) as {
    accessToken: string;
    user: { id: number };
  };
  const biz = await fetch(`${baseUrl}/api/businesses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${loginBody.accessToken}`,
    },
    body: JSON.stringify({ name: businessName }),
  });
  assert.equal(biz.status, 201);
  const bizBody = (await biz.json()) as { business: { id: number } };
  if (!options.noLocation) {
    // The default location (first one) is where storefront stock lives.
    const loc = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
        "X-Business-Id": String(bizBody.business.id),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    assert.equal(loc.status, 201);
  }
  return {
    token: loginBody.accessToken,
    businessId: bizBody.business.id,
    userId: loginBody.user.id,
    email,
  };
}

/** Standard auth + tenant headers for the POS API surface. */
export function authHeaders(
  ctx: { token: string; businessId: number },
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ctx.token}`,
    "X-Business-Id": String(ctx.businessId),
    ...extra,
  };
}

type ApiResponse<T> = { status: number; body: T };

export async function postJson<T = any>(
  baseUrl: string,
  ctx: { token: string; businessId: number },
  path: string,
  payload: unknown,
  extra: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders(ctx, extra),
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body: body as T };
}

export async function getJson<T = any>(
  baseUrl: string,
  ctx: { token: string; businessId: number },
  path: string,
  extra: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders(ctx, extra) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body: body as T };
}
