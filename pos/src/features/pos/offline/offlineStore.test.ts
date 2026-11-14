import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contract tests for the offline outbox → /api/offline/sync replay.
 *
 * The offline op surface wraps each op's domain payload — a sale op must
 * arrive as { sale: CreateSalePayload } (the same shape the LAN sync agent
 * pushes). A1-001: the browser outbox used to send the bare payload and
 * EVERY offline sale failed at sync with "sale.create requires a sale
 * payload." — these tests pin the wrapped contract.
 */

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock("../../../api/axios.js", () => ({ default: { post: postMock } }));

vi.mock("./db.js", () => {
  const map = new Map<string, unknown>();
  const log: unknown[] = [];
  return {
    requestPersistentStorage: async () => undefined,
    putOutboxEntry: async (entry: { clientSaleId: string }) => {
      map.set(entry.clientSaleId, entry);
    },
    getOutboxEntry: async (id: string) => map.get(id),
    listOutbox: async () => [...map.values()],
    appendSyncLog: async (entry: unknown) => {
      log.push(entry);
    },
    readSyncLog: async () => log,
    __map: map,
  };
});

vi.mock("../stores/useSalesStore.js", () => ({
  refreshStockAfterTransaction: vi.fn(async () => undefined),
}));

import { useOfflineStore } from "./offlineStore.js";
import * as db from "./db.js";
import type { OutboxEntry } from "./db.js";

const outboxMap = (db as unknown as { __map: Map<string, OutboxEntry> }).__map;

// Minimal bare CreateSalePayload — only the fields the outbox touches.
const bareSalePayload = {
  idempotencyKey: "0f6b3f2e-5b2c-4f8a-9c1d-2e3f4a5b6c7d",
  items: [{ variantId: 12, quantity: 2, unitPrice: "45.00" }],
  payments: [{ method: "cash", amount: "90.00", tendered: "90.00" }],
};

function seedEntry(
  overrides: Partial<OutboxEntry> = {},
): OutboxEntry {
  const entry: OutboxEntry = {
    clientSaleId: "offline-entry-1",
    status: "pending",
    payload: bareSalePayload,
    invoiceNumber: null,
    recordedAt: new Date().toISOString(),
    syncedAt: null,
    attempts: 0,
    lastError: null,
    offlineOrigin: true,
    kind: "sale",
    summary: { total: 90, itemCount: 1, customerName: null },
    ...overrides,
  };
  outboxMap.set(entry.clientSaleId, entry);
  return entry;
}

function appliedResult(opId: string) {
  return {
    data: { data: { results: [{ opId, status: "applied", saleId: 4210 }] } },
  };
}

beforeEach(() => {
  outboxMap.clear();
  postMock.mockReset();
});

describe("offlineStore.syncNow — sale op contract", () => {
  it("wraps the stored bare sale payload as { sale } when replaying", async () => {
    const entry = seedEntry();
    postMock.mockResolvedValueOnce(appliedResult(entry.clientSaleId));

    const { synced } = await useOfflineStore.getState().syncNow();

    expect(synced).toBe(1);
    expect(postMock).toHaveBeenCalledTimes(1);
    const [, body] = postMock.mock.calls[0];
    expect(body.ops).toHaveLength(1);
    expect(body.ops[0]).toMatchObject({
      opId: entry.clientSaleId,
      type: "sale.create",
      // The wrapped contract — not the bare payload.
      payload: { sale: bareSalePayload },
    });
    expect(outboxMap.get(entry.clientSaleId)?.status).toBe("synced");
  });

  it("marks the entry failed when the backend rejects the op", async () => {
    const entry = seedEntry();
    postMock.mockResolvedValueOnce({
      data: {
        data: {
          results: [
            { opId: entry.clientSaleId, status: "failed", error: "Stale price." },
          ],
        },
      },
    });

    const { failed } = await useOfflineStore.getState().syncNow();

    expect(failed).toBe(1);
    const stored = outboxMap.get(entry.clientSaleId);
    expect(stored?.status).toBe("failed");
    expect(stored?.lastError).toBe("Stale price.");
  });

  it("treats a duplicate replay as synced (idempotent replay)", async () => {
    const entry = seedEntry();
    postMock.mockResolvedValueOnce({
      data: {
        data: { results: [{ opId: entry.clientSaleId, status: "duplicate" }] },
      },
    });

    const { synced } = await useOfflineStore.getState().syncNow();

    expect(synced).toBe(1);
    expect(outboxMap.get(entry.clientSaleId)?.status).toBe("synced");
  });
});
