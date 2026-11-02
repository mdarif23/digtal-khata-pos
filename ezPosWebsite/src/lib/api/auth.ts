"use client";

/**
 * Browser-side auth client for the ezPos backend.
 *
 * Security model:
 * - The access token lives in MEMORY ONLY (never localStorage/sessionStorage,
 *   never cookies accessible to JS).
 * - The refresh token stays in an HttpOnly cookie managed by the backend
 *   (path=/api/auth) and is attached automatically by the browser because
 *   every request sends credentials.
 * - On a 401 the client silently refreshes once and retries; a failed
 *   refresh clears the session.
 */

export interface SessionUser {
  id: number;
  email: string;
  fullName: string;
  phone: string | null;
  platformRole: string;
  emailVerified: boolean;
}

export interface BusinessMembership {
  businessId: number;
  businessName: string;
  businessSlug: string;
  roleSlug: string;
  roleName: string;
  subscription: {
    status: string;
    accessMode: "full" | "read_only";
    trial: boolean;
    currentPeriodEnd: string | null;
  };
}

export interface MeResponse {
  user: SessionUser;
  businesses: BusinessMembership[];
}

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000";

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function clearAccessToken(): void {
  accessToken = null;
}

/** Shown whenever the backend cannot be reached at all (server down, wrong URL). */
export const SERVER_UNREACHABLE_MESSAGE =
  "Cannot reach the ezPos server. Make sure the backend is running (ezPosBackend: npm run dev).";

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T | null }> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
  } catch {
    // Network-level failure (backend down, CORS, DNS) — never an HTTP error.
    // status 0 lets callers show the friendly offline message.
    return { status: 0, body: null };
  }
  const body = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, body };
}

/** Silent refresh using the HttpOnly cookie. Concurrent callers share one request. */
export async function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const attempt = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/refresh`, {
          method: "POST",
          credentials: "include",
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { accessToken?: string };
        return body.accessToken ?? null;
      } catch {
        return null;
      }
    };
    let token = await attempt();
    if (!token) {
      // A concurrent refresh may have just rotated the cookie — the winner's
      // new cookie is already in the jar, so retry once.
      await new Promise((resolve) => setTimeout(resolve, 300));
      token = await attempt();
    }
    accessToken = token;
    return Boolean(accessToken);
  })();
  const result = await refreshPromise;
  refreshPromise = null;
  return result;
}

export async function signUp(input: {
  fullName: string;
  email: string;
  password: string;
  phone?: string;
  termsAccepted: boolean;
}): Promise<{ ok: boolean; status: number; message: string }> {
  const { status, body } = await request<{ success?: boolean; message?: string }>(
    "/api/auth/register",
    { method: "POST", body: JSON.stringify(input) },
  );
  const message =
    status === 0
      ? SERVER_UNREACHABLE_MESSAGE
      : (body?.message ??
        (status === 201
          ? "Account created."
          : "Unable to create the account right now."));
  return { ok: status === 201, status, message };
}

export async function signIn(input: {
  email: string;
  password: string;
}): Promise<{ ok: boolean; status: number; message: string }> {
  const { status, body } = await request<{ accessToken?: string; message?: string }>(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify(input) },
  );
  if (status === 200 && body?.accessToken) {
    accessToken = body.accessToken;
    return { ok: true, status, message: "Signed in." };
  }
  const message =
    status === 0
      ? SERVER_UNREACHABLE_MESSAGE
      : (body?.message ?? "Unable to sign in right now. Please try again.");
  return { ok: false, status, message };
}

export async function signOut(): Promise<void> {
  try {
    // Best effort: if the server is unreachable the session is still cleared
    // locally below — signing out must never fail from the UI's perspective.
    await request("/api/auth/logout", { method: "POST" });
  } finally {
    accessToken = null;
  }
}

export async function fetchMe(): Promise<MeResponse | null> {
  let { status, body } = await request<MeResponse>("/api/auth/me");
  if (status === 401) {
    const refreshed = await refreshSession();
    if (!refreshed) return null;
    ({ status, body } = await request<MeResponse>("/api/auth/me"));
  }
  if (status !== 200 || !body) return null;
  return body;
}

export async function createBusiness(input: {
  name: string;
  phone?: string;
  termsAccepted?: boolean;
}): Promise<{ ok: boolean; status: number; message: string; businessId?: number }> {
  const { status, body } = await request<{
    success?: boolean;
    message?: string;
    business?: { id: number };
  }>("/api/businesses", { method: "POST", body: JSON.stringify(input) });
  const message =
    status === 0
      ? SERVER_UNREACHABLE_MESSAGE
      : (body?.message ?? "Unable to create the business right now.");
  return {
    ok: status === 201,
    status,
    message,
    businessId: body?.business?.id,
  };
}
