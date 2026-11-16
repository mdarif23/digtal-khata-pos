import type { ReactNode } from "react";
import { Navigate } from "react-router";
import {
  businessModeMatches,
  useSessionStore,
  type BusinessMode,
} from "@/auth/sessionStore";

interface RequireModeProps {
  /** Operating modes the wrapped content is available in. */
  modes: BusinessMode[];
  /** Where to send the user when the mode is not activated. */
  redirectTo?: string;
  children: ReactNode;
}

/**
 * Route guard for operating-model surfaces: renders children only when the
 * active business has activated one of `modes`. A null businessMode (session
 * not resolved yet, or a backend payload without `mode`) passes through —
 * the backend enforces the mode on the underlying APIs.
 *
 * Mirrors navigation.ts `modes` entries: a page hidden from the sidebar must
 * also refuse direct URL entry, and a reachable page must never be hidden.
 */
export function RequireMode({
  modes,
  redirectTo = "/403",
  children,
}: RequireModeProps) {
  const businessMode = useSessionStore((state) => state.businessMode);
  const version = useSessionStore((state) => state.version);
  void version; // re-render on session refresh

  if (!businessModeMatches(businessMode, modes)) {
    return <Navigate to={redirectTo} replace />;
  }
  return <>{children}</>;
}
