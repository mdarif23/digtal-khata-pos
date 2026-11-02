"use client";

/**
 * Active-sessions client (portal Settings).
 */
import { API_BASE, getAccessToken, SERVER_UNREACHABLE_MESSAGE } from "@/lib/api/auth";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  message: string;
  data?: T;
}

export interface ActiveSession {
  id: number;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string;
}

export async function fetchSessions(): Promise<
  ApiResult<ActiveSession[]>
> {
  const token = getAccessToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/auth/sessions`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
    });
  } catch {
    return { ok: false, status: 0, message: SERVER_UNREACHABLE_MESSAGE, data: [] };
  }
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    message?: string;
    data?: ActiveSession[];
  } | null;
  return {
    ok: res.ok,
    status: res.status,
    message:
      body?.message ?? (res.ok ? "Done." : "Unable to load sessions."),
    data: body?.data ?? [],
  };
}

export async function revokeSession(sessionId: number): Promise<ApiResult<unknown>> {
  const token = getAccessToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/auth/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token ?? ""}` },
    });
  } catch {
    return { ok: false, status: 0, message: SERVER_UNREACHABLE_MESSAGE };
  }
  return { ok: res.ok, status: res.status, message: res.ok ? "Signed out." : "Unable to revoke." };
}
