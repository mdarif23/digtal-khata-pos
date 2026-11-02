"use client";

/**
 * Active-business selection for the customer portal (business switcher).
 *
 * The backend is multi-business; the portal previously showed only
 * businesses[0]. The choice persists per browser in localStorage and
 * switching reloads the page — the same guaranteed-refetch pattern the POS
 * app uses for location switching.
 */
import { useAuth } from "@/components/providers/auth-provider";

const STORAGE_KEY = "ezpos-active-business";

function readStored(): number | null {
  if (typeof window === "undefined") return null;
  const parsed = Number(window.localStorage.getItem(STORAGE_KEY));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function useActiveBusiness() {
  const { businesses } = useAuth();

  const stored = readStored();
  const valid = businesses.some((b) => b.businessId === stored);
  const business = valid
    ? businesses.find((b) => b.businessId === stored)!
    : businesses[0];
  const businessId = business?.businessId ?? null;

  function switchBusiness(id: number) {
    if (id === businessId) return;
    window.localStorage.setItem(STORAGE_KEY, String(id));
    // Guaranteed refetch: every portal component reads the active business
    // on mount, so a full reload is the simplest correct refresh.
    window.location.reload();
  }

  return { businessId, business, businesses, switchBusiness };
}
