import axios from "../../../api/axios.js";
import {
  idbGet,
  idbPut,
  scopeKey,
  STORE_GRANTS,
} from "./db.js";

/**
 * Offline stock allocations (Phase 3) — the browser side of the
 * server-enforced allowance ledger. When the terminal goes offline (or the
 * cashier taps "prepare offline"), the granted allowances are cached here;
 * add-to-cart gates against the REMAINING allowance so two disconnected
 * terminals can never sell the same units.
 *
 * The server owns the truth: a stale local grant can only ever UNDER-sell
 * (the backend re-checks and flags overages as conflicts at sync time).
 */

export interface GrantAllocation {
  variantId: number;
  allocatedQty: number;
  consumedQty: number;
  remainingQty: number;
  policy: "allocated" | "blocked" | "open";
  expiresAt: string;
}

interface GrantsBlob {
  scope: string;
  allocations: GrantAllocation[];
  savedAt: string;
}

export async function prepareOffline(variantIds: number[]): Promise<GrantAllocation[]> {
  const unique = [...new Set(variantIds)].filter((id) => Number.isInteger(id) && id > 0);
  const res = await axios.post<{ data: GrantAllocation[] }>(
    "/offline/allocations",
    { variantIds: unique.slice(0, 2000) },
  );
  const allocations = res.data.data ?? [];
  await idbPut(STORE_GRANTS, {
    scope: scopeKey("grants"),
    allocations,
    savedAt: new Date().toISOString(),
  } satisfies GrantsBlob);
  return allocations;
}

export async function getGrants(): Promise<GrantAllocation[]> {
  const blob = await idbGet<GrantsBlob>(STORE_GRANTS, scopeKey("grants"));
  if (!blob) return [];
  const now = Date.now();
  return blob.allocations.filter((a) => new Date(a.expiresAt).getTime() > now);
}

export type AllowanceCheck =
  | { allowed: true }
  | { allowed: false; reason: string };

/** Gate an offline add-to-cart against the cached allowance. */
export async function checkAllowance(
  variantId: number,
  quantity: number,
): Promise<AllowanceCheck> {
  const grants = await getGrants();
  const grant = grants.find((g) => g.variantId === variantId);
  if (!grant) return { allowed: true }; // no grant info — open/unknown
  if (grant.policy === "blocked") {
    return { allowed: false, reason: "This product cannot be sold offline." };
  }
  if (grant.policy === "allocated" && quantity > grant.remainingQty) {
    return {
      allowed: false,
      reason: `Offline allowance reached — ${grant.remainingQty} unit(s) left for this product until sync.`,
    };
  }
  return { allowed: true };
}

export async function clearGrants(): Promise<void> {
  await idbPut(STORE_GRANTS, {
    scope: scopeKey("grants"),
    allocations: [],
    savedAt: new Date().toISOString(),
  } satisfies GrantsBlob);
}
