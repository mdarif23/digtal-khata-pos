import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/auth/sessionStore";
import { usePermissions } from "@/hooks/usePermissions";

type ButtonRenderProps = React.ComponentProps<typeof Button>;

interface GuardProps {
  permission?: string | undefined;
  anyPermission?: string[] | undefined;
  allPermissions?: string[] | undefined;
  /** Rendered instead of the children when access is denied. */
  fallback?: ReactNode;
  children: ReactNode;
}

function denies(
  perms: {
    hasPermission: (permission: string) => boolean;
    hasAnyPermission: (required: string[]) => boolean;
    hasAllPermissions: (required: string[]) => boolean;
  },
  props: Pick<
    GuardProps,
    "permission" | "anyPermission" | "allPermissions"
  >,
): boolean {
  if (props.permission) return !perms.hasPermission(props.permission);
  if (props.anyPermission) return !perms.hasAnyPermission(props.anyPermission);
  if (props.allPermissions) return !perms.hasAllPermissions(props.allPermissions);
  return false;
}

/**
 * Conditionally renders children based on effective permissions. Use for
 * sections and panels; for actions prefer PermissionButton, and for routes
 * RequirePermission (which redirects to /403).
 */
export function PermissionGuard(props: GuardProps) {
  const version = useSessionStore((state) => state.version);
  void version; // re-render on session refresh
  const perms = usePermissions();

  if (denies(perms, props)) {
    return <>{props.fallback ?? null}</>;
  }
  return <>{props.children}</>;
}

interface PermissionButtonProps extends Omit<ButtonRenderProps, "children"> {
  permission?: string | undefined;
  anyPermission?: string[] | undefined;
  allPermissions?: string[] | undefined;
  children: ReactNode;
}

/**
 * Button rendered only when the caller holds the required permission(s).
 * Complements — never replaces — backend enforcement.
 */
export function PermissionButton({
  permission,
  anyPermission,
  allPermissions,
  children,
  ...buttonProps
}: PermissionButtonProps) {
  const version = useSessionStore((state) => state.version);
  void version;
  const perms = usePermissions();

  if (denies(perms, { permission, anyPermission, allPermissions })) {
    return null;
  }
  return <Button {...buttonProps}>{children}</Button>;
}

interface RequirePermissionProps extends GuardProps {
  /** Where to send the user when access is denied. */
  redirectTo?: string;
}

/**
 * Route guard: renders the page only when the caller holds the required
 * permission(s); otherwise redirects to /403. Protects direct URL entry —
 * the backend still enforces every underlying API call.
 */
export function RequirePermission({
  redirectTo = "/403",
  children,
  ...permissionProps
}: RequirePermissionProps) {
  const version = useSessionStore((state) => state.version);
  void version;
  const perms = usePermissions();

  if (denies(perms, permissionProps)) {
    return <Navigate to={redirectTo} replace />;
  }
  return <>{children}</>;
}
