import { create } from "zustand";
import { WILDCARD_PERMISSION } from "../lib/rbac";

export interface SessionRole {
  id: number;
  name: string;
  slug: string;
}

export interface SessionLocation {
  id: number;
  name: string;
  locationCode: string | null;
  locationType: string;
  isDefault: boolean;
  status: string;
}

/** Operating model of the active business (mirrors the backend enum). */
export type BusinessMode = "physical_only" | "online_only" | "omnichannel";

export interface SessionState {
  user: {
    id?: number | undefined;
    fullName?: string | undefined;
    email?: string | undefined;
  } | null;
  businessId: number | null;
  /** Operating model of the active business; null until /auth/me resolves. */
  businessMode: BusinessMode | null;
  roleSlug: string | null;
  roleName: string | null;
  roles: SessionRole[];
  permissions: string[];
  /** Locations the signed-in user can access (server-verified list). */
  locations: SessionLocation[];
  /** The active location: every operational request carries its id. */
  activeLocationId: number | null;
  activeLocationName: string | null;
  /** Bumped whenever the session context is (re)loaded — useful as a dep. */
  version: number;
}

type BootstrapSession = Omit<
    SessionState,
    "version" | "locations" | "activeLocationId" | "activeLocationName"
  >;

interface SessionStore extends SessionState {
  setSession: (state: BootstrapSession) => void;
  setLocationContext: (locations: SessionLocation[], activeLocationId: number | null) => void;
  clearSession: () => void;
}

/**
 * Client-side snapshot of the signed-in user's effective permissions and
 * location access for the active business. Written by the session bootstrap
 * in api/axios.ts after /auth/me. This is UX ONLY — route guards and hidden
 * buttons shape the interface; the backend re-verifies every request
 * (business access, location access, and permissions are separate checks).
 */
export const useSessionStore = create<SessionStore>((set) => ({
  user: null,
  businessId: null,
  businessMode: null,
  roleSlug: null,
  roleName: null,
  roles: [],
  permissions: [],
  locations: [],
  activeLocationId: null,
  activeLocationName: null,
  version: 0,
  setSession: (state) => set(() => ({ ...state, version: Date.now() })),
  setLocationContext: (locations, activeLocationId) =>
    set((state) => ({
      locations,
      activeLocationId,
      activeLocationName:
        locations.find((l) => l.id === activeLocationId)?.name ?? null,
      version: Date.now(),
    })),
  clearSession: () =>
    set(() => ({
      user: null,
      businessId: null,
      businessMode: null,
      roleSlug: null,
      roleName: null,
      roles: [],
      permissions: [],
      locations: [],
      activeLocationId: null,
      activeLocationName: null,
      version: Date.now(),
    })),
}));

/**
 * Mode gate for navigation entries and route guards. A null businessMode
 * (session not resolved yet, or an older backend payload without `mode`)
 * lets everything through — the backend remains the real gate.
 */
export function businessModeMatches(
  businessMode: BusinessMode | null,
  modes: BusinessMode[] | undefined,
): boolean {
  if (!modes || modes.length === 0) return true;
  if (!businessMode) return true;
  return modes.includes(businessMode);
}

export function hasPermission(permission: string): boolean {
  const { permissions } = useSessionStore.getState();
  return (
    permissions.includes(WILDCARD_PERMISSION) ||
    permissions.includes(permission)
  );
}

export function hasAnyPermission(required: string[]): boolean {
  if (required.length === 0) return true;
  return required.some((permission) => hasPermission(permission));
}

export function hasAllPermissions(required: string[]): boolean {
  return required.every((permission) => hasPermission(permission));
}
