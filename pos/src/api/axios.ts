import axios from "axios";
import { useSessionStore, type SessionLocation } from "../auth/sessionStore";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:3000/api",
});

/**
 * Session bootstrap (multi-tenancy).
 *
 * The signed-in user's access token is held in memory and restored from the
 * backend's HttpOnly refresh cookie on startup — never persisted in
 * localStorage. Every request carries the token AND the active business id
 * (X-Business-Id header): the backend requires the header on every
 * business-scoped route and verifies ownership itself. A 401 triggers one
 * silent refresh-and-retry; a failed refresh redirects to the website to
 * sign in again. All authorization is still enforced by the backend.
 *
 * IMPORTANT: every request in this module MUST go through the configured
 * `api` instance. The bare `axios` library has no baseURL, so calls resolve
 * against the page origin (localhost:5173) and 404 on the Vite dev server.
 */

const WEBSITE_URL =
  import.meta.env.VITE_WEBSITE_URL || "http://localhost:3001";

let accessToken: string | null = null;
let activeBusinessId: number | null = null;
let activeLocationId: number | null = null;
let sessionUser: SessionUser | null = null;
let bootstrapPromise: Promise<void> | null = null;

const ACTIVE_LOCATION_KEY = "ezpos-active-location";

export interface SessionUser {
  id?: number | undefined;
  fullName?: string | undefined;
  email?: string | undefined;
  roleSlug?: string | undefined;
  roleName?: string | undefined;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getActiveBusinessId(): number | null {
  return activeBusinessId;
}

export function getActiveLocationId(): number | null {
  return activeLocationId;
}

/**
 * Switches the active location: persists the choice for this user/business
 * pair and reloads the app so every store refetches against the new
 * location (guaranteed cache invalidation). The backend validates the
 * selection on every request — this only shapes what we ask for.
 */
export function switchLocation(locationId: number): void {
  const user = getSessionUser();
  const scope = user?.id != null ? `u${user.id}` : "?";
  try {
    localStorage.setItem(
      ACTIVE_LOCATION_KEY,
      `${scope}b${activeBusinessId}l${locationId}`,
    );
  } catch {
    // localStorage unavailable — the switch still applies for this session.
  }
  activeLocationId = locationId;
  useSessionStore.getState().setLocationContext(
    useSessionStore.getState().locations,
    locationId,
  );
  window.location.reload();
}

export function getSessionUser(): SessionUser | null {
  return sessionUser;
}

export function clearSession(): void {
  accessToken = null;
  activeBusinessId = null;
  activeLocationId = null;
  sessionUser = null;
  bootstrapPromise = null;
  useSessionStore.getState().clearSession();
}

/**
 * Re-fetches /auth/me and refreshes the in-memory session + permission
 * snapshot without a full page reload. Called after role or permission
 * changes so the UI reflects the new access immediately (the backend
 * already enforces it per request).
 */
export async function refreshSessionContext(): Promise<void> {
  bootstrapPromise = loadSession();
  await bootstrapPromise;
}

/**
 * Signs the user out: best-effort backend call (revokes the refresh token
 * family), clears the in-memory session, and returns to the website sign-in.
 * Never throws — logout must succeed locally even if the network is down.
 */
export async function logout(): Promise<void> {
  try {
    await api.post("/auth/logout", null, { withCredentials: true });
  } catch {
    // Best-effort: the cookie will expire on its own if the call fails.
  }
  clearSession();
  window.location.href = `${WEBSITE_URL}/sign-in`;
}

function redirectToSignIn(reason?: string): never {
  const query = reason ? `?pos_error=${encodeURIComponent(reason)}` : "";
  window.location.href = `${WEBSITE_URL}/sign-in${query}`;
  // Reject instead of resolving: the app must not mount without a session
  // (it would fire every store call unauthenticated and re-trigger redirects).
  throw new Error(`session_redirect: ${reason ?? "unknown"}`);
}

async function loadSession(): Promise<void> {
  // 1. New access token from the HttpOnly refresh cookie. A 401 here can
  //    also mean a concurrent caller just rotated the cookie (the winner's
  //    new cookie is already in the jar) — retry once before giving up.
  const attemptRefresh = () =>
    api.post<{ accessToken?: string }>("/auth/refresh", null, {
      withCredentials: true,
    });
  let res = await attemptRefresh().catch((err) => err.response ?? null);
  if (!res || res.status !== 200) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    res = await attemptRefresh().catch((err) => err.response ?? null);
  }
  accessToken = res?.data?.accessToken ?? null;
  if (accessToken === null || res?.status !== 200) {
    redirectToSignIn(`refresh_failed_${res?.status ?? "network"}`);
  }

  // 2. Resolve the active business and the signed-in user from the session's
  //    memberships. The backend picks nothing for us; the POS defaults to the
  //    first business. (A business switcher is future work.)
  try {
    const me = await api.get<{
      user?: { id?: number; fullName?: string; email?: string };
      businesses?: {
        businessId: number;
        roleSlug?: string;
        roleName?: string;
        roles?: { id: number; name: string; slug: string }[];
        permissions?: string[];
      }[];
    }>("/auth/me");
    const first = me.data.businesses?.[0];
    activeBusinessId = first?.businessId ?? null;
    sessionUser = {
      id: me.data.user?.id,
      fullName: me.data.user?.fullName,
      email: me.data.user?.email,
      roleSlug: first?.roleSlug,
      roleName: first?.roleName,
    };
    // Publish the permission snapshot for the UI (route guards, sidebar,
    // PermissionGuard). Authorization itself stays backend-enforced.
    useSessionStore.getState().setSession({
      user: {
        id: me.data.user?.id,
        fullName: me.data.user?.fullName,
        email: me.data.user?.email,
      },
      businessId: first?.businessId ?? null,
      roleSlug: first?.roleSlug ?? null,
      roleName: first?.roleName ?? null,
      roles: first?.roles ?? [],
      permissions: first?.permissions ?? [],
    });

    // 3. Location context: the server-verified list of accessible locations.
    //    The persisted selection is a convenience — the backend validates it
    //    on every request regardless.
    let locations: SessionLocation[] = [];
    try {
      const locsRes = await api.get<{ success: boolean; data: SessionLocation[] }>(
        "/accessible-locations",
      );
      locations = locsRes.data.data ?? [];
    } catch {
      // A failed location fetch must not kill the session; location-scoped
      // endpoints will surface a clear error instead.
      locations = [];
    }
    const persisted = readPersistedLocation(me.data.user?.id, activeBusinessId);
    const persistedLocation = locations.find((l) => l.id === persisted);
    const defaultLocation =
      persistedLocation ??
      locations.find((l) => l.isDefault) ??
      locations[0];
    activeLocationId = defaultLocation?.id ?? null;
    useSessionStore
      .getState()
      .setLocationContext(locations, activeLocationId);
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : "network";
    redirectToSignIn(`me_failed_${status}`);
  }

  // 4. Signed in but no business yet — the website dashboard is where
  //    businesses are created.
  if (activeBusinessId === null) {
    window.location.href = `${WEBSITE_URL}/dashboard`;
    throw new Error("session_redirect: no_active_business");
  }

  // Offline POS (Module 10): scope the cache to this user+business and
  // start the sync engine once per session.
  const { bindOfflineSession } = await import(
    "../features/pos/offline/catalog.js"
  );
  const { useOfflineStore } = await import(
    "../features/pos/offline/offlineStore.js"
  );
  bindOfflineSession(user.id ?? "anon", activeBusinessId);
  useOfflineStore.getState().startWatchers();
  // Cart recovery (Module 1.5): restore a checkout interrupted by a
  // refresh/crash. After the offline scope is bound, before the first UI.
  const { restorePersistedCart } = await import(
    "../features/pos/stores/useCartStore.js"
  );
  await restorePersistedCart();
}

/** Restores the persisted location selection for this user/business pair. */
function readPersistedLocation(
  userId: number | undefined,
  businessId: number | null,
): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_LOCATION_KEY);
    if (raw === null) return null;
    const match = /^u(\d+)b(\d+)l(\d+)$/.exec(raw);
    if (!match) return null;
    if (Number(match[1]) !== userId || Number(match[2]) !== businessId) {
      return null;
    }
    return Number(match[3]);
  } catch {
    return null;
  }
}

/**
 * Re-fetches the accessible-locations list and refreshes the location
 * snapshot without a page reload — used after location create/edit/delete.
 * The active selection is kept when still accessible.
 */
export async function refreshLocationContext(): Promise<void> {
  try {
    const locsRes = await api.get<{ success: boolean; data: SessionLocation[] }>(
      "/accessible-locations",
    );
    const locations = locsRes.data.data ?? [];
    const stillThere = locations.find((l) => l.id === activeLocationId);
    if (!stillThere) {
      const fallback = locations.find((l) => l.isDefault) ?? locations[0];
      activeLocationId = fallback?.id ?? null;
    }
    useSessionStore.getState().setLocationContext(locations, activeLocationId);
  } catch {
    // Non-fatal: the current snapshot stays until the next bootstrap.
  }
}

/**
 * Restores the session exactly ONCE per page load.
 *
 * The refresh endpoint ROTATES the cookie: two concurrent calls presenting
 * the same cookie make the second one 401 (React StrictMode double-invokes
 * effects in dev). All callers therefore share one in-flight bootstrap, and
 * a completed bootstrap short-circuits.
 */
export function bootstrapSession(): Promise<void> {
  if (accessToken && activeBusinessId) return Promise.resolve();
  if (!bootstrapPromise) {
    bootstrapPromise = loadSession().catch((err) => {
      clearSession();
      throw err;
    });
  }
  return bootstrapPromise;
}

api.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  if (activeBusinessId !== null) {
    config.headers["X-Business-Id"] = String(activeBusinessId);
  }
  if (activeLocationId !== null) {
    config.headers["X-Location-Id"] = String(activeLocationId);
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config ?? {};
    if (
      error.response?.status === 401 &&
      !original._retried &&
      !original.url?.includes("/auth/")
    ) {
      original._retried = true;
      // Deduplicated: this waits on the in-flight bootstrap instead of
      // starting a second refresh rotation with the same cookie.
      await bootstrapSession().catch(() => undefined);
      if (accessToken !== null && activeBusinessId !== null) {
        return api(original);
      }
      redirectToSignIn(
        `401_retry_${String(original.url ?? "?")}_token=${accessToken !== null}_biz=${activeBusinessId !== null}`,
      );
    }
    return Promise.reject(error);
  },
);

export default api;
