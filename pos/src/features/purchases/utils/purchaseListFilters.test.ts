import { describe, expect, it } from "vitest";
import {
  deriveReturnStatuses,
  matchesPurchaseFilter,
} from "./purchaseListFilters";

const purchase = (status: "ordered" | "partially_received" | "received") => ({
  status,
});

describe("matchesPurchaseFilter", () => {
  it("matches receiving lifecycle tabs exactly", () => {
    expect(matchesPurchaseFilter(purchase("ordered"), "ordered", undefined)).toBe(
      true,
    );
    expect(
      matchesPurchaseFilter(purchase("received"), "partially_received", undefined),
    ).toBe(false);
  });

  it("matches the derived return tabs", () => {
    expect(
      matchesPurchaseFilter(purchase("received"), "returned", "Returned"),
    ).toBe(true);
    expect(
      matchesPurchaseFilter(
        purchase("partially_received"),
        "partially_returned",
        "Partially returned",
      ),
    ).toBe(true);
    // Return tabs require the derived return state — status alone is not enough.
    expect(matchesPurchaseFilter(purchase("received"), "returned", undefined)).toBe(
      false,
    );
  });

  it("excludes fully-returned orders from the Received tab", () => {
    expect(
      matchesPurchaseFilter(purchase("received"), "received", "Returned"),
    ).toBe(false);
    // Partially returned orders still belong to their receiving tab.
    expect(
      matchesPurchaseFilter(
        purchase("partially_received"),
        "partially_received",
        "Partially returned",
      ),
    ).toBe(true);
    expect(
      matchesPurchaseFilter(purchase("received"), "received", "Partially returned"),
    ).toBe(true);
  });

  it("matches everything under All", () => {
    expect(matchesPurchaseFilter(purchase("ordered"), "all", "Returned")).toBe(true);
  });
});

describe("Phase 3 — Scenario F (fully cancelled, zero accepted goods)", () => {
  const cancelled = {
    status: "received" as const,
    fullyCancelled: true as const,
  };

  it("shows under the Cancelled tab, never as Received", () => {
    expect(matchesPurchaseFilter(cancelled, "cancelled", undefined)).toBe(true);
    expect(matchesPurchaseFilter(cancelled, "received", undefined)).toBe(false);
    expect(matchesPurchaseFilter(cancelled, "ordered", undefined)).toBe(false);
    expect(
      matchesPurchaseFilter(cancelled, "partially_received", undefined),
    ).toBe(false);
    expect(matchesPurchaseFilter(cancelled, "all", undefined)).toBe(true);
  });

  it("does not hijack the Cancelled tab from normal orders", () => {
    expect(
      matchesPurchaseFilter(
        { status: "received", fullyCancelled: false },
        "cancelled",
        undefined,
      ),
    ).toBe(false);
  });

  it("partially-cancelled purchases (goods DID arrive) stay in Received", () => {
    // received 5 + cancelled 5 of 10: not fullyCancelled — goods arrived.
    expect(
      matchesPurchaseFilter(
        { status: "received", fullyCancelled: false },
        "received",
        undefined,
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------
 * Phase 2 — the master prompt's regression scenarios A–E, expressed
 * through the SAME predicate the page uses, with the shared derivation.
 * ------------------------------------------------------------------ */

const items = (
  rows: { purchaseId: number; receivedQuantity: number }[],
) => rows.map((row, index) => ({ id: index + 1, ...row }));
const returns = (rows: { purchaseItemId: number; returnQuantity: number }[]) =>
  rows;

describe("deriveReturnStatuses (shared derivation)", () => {
  it("sums multiple returns against the same item (Scenario H seed)", () => {
    const statuses = deriveReturnStatuses(
      items([{ purchaseId: 1, receivedQuantity: 10 }]),
      returns([
        { purchaseItemId: 1, returnQuantity: 2 },
        { purchaseItemId: 1, returnQuantity: 3 },
      ]),
    );
    expect(statuses.get(1)).toBe("Partially returned");
  });

  it("returns no entry when there are no returns", () => {
    const statuses = deriveReturnStatuses(
      items([{ purchaseId: 1, receivedQuantity: 10 }]),
      returns([]),
    );
    expect(statuses.size).toBe(0);
  });
});

describe("Phase 2 scenarios A–E (receiving and return status are independent)", () => {
  const visibleIn = (
    status: "ordered" | "partially_received" | "received",
    returnStatus: string | undefined,
  ) => ({
    received: matchesPurchaseFilter({ status }, "received", returnStatus),
    partiallyReturned: matchesPurchaseFilter(
      { status },
      "partially_returned",
      returnStatus,
    ),
    returned: matchesPurchaseFilter({ status }, "returned", returnStatus),
    partiallyReceived: matchesPurchaseFilter(
      { status },
      "partially_received",
      returnStatus,
    ),
  });

  it("Scenario A — fully received, no returns", () => {
    // Ordered 10, accepted 10, returned 0.
    const statuses = deriveReturnStatuses(
      items([{ purchaseId: 1, receivedQuantity: 10 }]),
      returns([]),
    );
    const tabs = visibleIn("received", statuses.get(1));
    expect(tabs.received).toBe(true);
    expect(tabs.partiallyReturned).toBe(false);
    expect(tabs.returned).toBe(false);
  });

  it("Scenario B — fully received, partially returned: visible in BOTH tabs", () => {
    // Ordered 10, accepted 10, returned 3.
    const statuses = deriveReturnStatuses(
      items([{ purchaseId: 1, receivedQuantity: 10 }]),
      returns([{ purchaseItemId: 1, returnQuantity: 3 }]),
    );
    expect(statuses.get(1)).toBe("Partially returned");
    const tabs = visibleIn("received", statuses.get(1));
    expect(tabs.received).toBe(true);
    expect(tabs.partiallyReturned).toBe(true);
    expect(tabs.returned).toBe(false);
  });

  it("Scenario C — fully returned: Returned tab only, never Received", () => {
    // Ordered 10, accepted 10, returned 10.
    const statuses = deriveReturnStatuses(
      items([{ purchaseId: 1, receivedQuantity: 10 }]),
      returns([{ purchaseItemId: 1, returnQuantity: 10 }]),
    );
    expect(statuses.get(1)).toBe("Returned");
    const tabs = visibleIn("received", statuses.get(1));
    expect(tabs.received).toBe(false);
    expect(tabs.returned).toBe(true);
  });

  it("Scenario D — partially received, no returns", () => {
    // Ordered 10, accepted 6, returned 0.
    const statuses = deriveReturnStatuses(
      items([{ purchaseId: 1, receivedQuantity: 6 }]),
      returns([]),
    );
    const tabs = visibleIn("partially_received", statuses.get(1));
    expect(tabs.partiallyReceived).toBe(true);
    expect(tabs.partiallyReturned).toBe(false);
    expect(tabs.returned).toBe(false);
  });

  it("Scenario E — partially received AND partially returned: visible in both", () => {
    // Ordered 10, accepted 6, returned 2.
    const statuses = deriveReturnStatuses(
      items([{ purchaseId: 1, receivedQuantity: 6 }]),
      returns([{ purchaseItemId: 1, returnQuantity: 2 }]),
    );
    expect(statuses.get(1)).toBe("Partially returned");
    const tabs = visibleIn("partially_received", statuses.get(1));
    expect(tabs.partiallyReceived).toBe(true);
    expect(tabs.partiallyReturned).toBe(true);
  });
});
