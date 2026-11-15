import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  customerKeys,
  fetchCustomersWithOfflineCache,
  useCustomersQuery,
} from "../useCustomers.js";

vi.mock("@/api/axios.js", () => ({
  default: { get: vi.fn() },
  getActiveBusinessId: () => 1,
}));

vi.mock("@/features/pos/offline/db.js", () => ({
  bindSessionScope: vi.fn(),
  cacheCatalog: vi.fn(async () => undefined),
  idbGet: vi.fn(),
  idbPut: vi.fn(),
  readCatalog: vi.fn(async () => null),
  scopeKey: (prefix: string) => prefix,
  STORE_CUSTOMERS: "catalog_customers",
  STORE_PRODUCTS: "catalog_products",
  requestPersistentStorage: vi.fn(async () => undefined),
}));

import axios from "@/api/axios.js";
import { readCatalog } from "@/features/pos/offline/db.js";

const mockedGet = vi.mocked(axios.get);
const mockedReadCatalog = vi.mocked(readCatalog);

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Probe() {
  const query = useCustomersQuery();
  if (query.isPending) return <div>loading</div>;
  if (query.error) return <div>error</div>;
  return <div>{(query.data ?? []).map((c) => c.name).join("|")}</div>;
}

function renderProbe(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
}

describe("useCustomersQuery (Phase 6 Feature 1 — customers domain)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadCatalog.mockResolvedValue(null);
  });

  it("loads the customers list and renders it", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [
        { id: 1, name: "Karim", phone: null, address: null },
        { id: 2, name: "Rahima", phone: null, address: null },
      ],
    } as never);
    renderProbe(makeClient());
    await waitFor(() => expect(screen.getByText("Karim|Rahima")).toBeInTheDocument());
    expect(mockedGet).toHaveBeenCalledWith("/customers");
  });

  it("invalidates on the customer.changed signal equivalent and refetches", async () => {
    mockedGet
      .mockResolvedValueOnce({
        data: [{ id: 1, name: "Karim", phone: null, address: null }],
      } as never)
      .mockResolvedValueOnce({
        data: [
          { id: 1, name: "Karim", phone: null, address: null },
          { id: 2, name: "Rahima", phone: null, address: null },
        ],
      } as never);
    const client = makeClient();
    renderProbe(client);
    await waitFor(() => expect(screen.getByText("Karim")).toBeInTheDocument());

    // PosPage's realtime consumer now does exactly this on customerRevision.
    await client.invalidateQueries({ queryKey: customerKeys.all });

    await waitFor(() => expect(screen.getByText("Karim|Rahima")).toBeInTheDocument());
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("falls back to the IndexedDB catalog on a network error (offline path)", async () => {
    // Network-shaped failure: axios errors carry response: undefined —
    // exactly what the wrapper's isNetworkError branch keys on.
    mockedGet.mockRejectedValue(
      Object.assign(new Error("Network Error"), { response: undefined }),
    );
    mockedReadCatalog.mockResolvedValueOnce([
      { id: 9, name: "Cached Customer", phone: "", address: "" },
    ]);
    renderProbe(makeClient());
    await waitFor(() =>
      expect(screen.getByText("Cached Customer")).toBeInTheDocument(),
    );
  });

  it("surfaces non-network failures as the query error state", async () => {
    mockedGet.mockRejectedValue({
      response: { status: 500, data: { message: "boom" } },
    });
    renderProbe(makeClient());
    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());
  });

  it("keys the list by the active business scope", () => {
    expect(customerKeys.all).toEqual(["customers"]);
    expect(customerKeys.list()).toEqual(["customers", 1, "list"]);
  });

  it("fetchCustomersWithOfflineCache returns the wrapper shape for prefetch", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [{ id: 3, name: "Nadia", phone: null, address: null }],
    } as never);
    const result = await fetchCustomersWithOfflineCache();
    // normalizeCustomer maps null phone/address to "" — existing API contract.
    expect(result).toEqual({
      data: [{ id: 3, name: "Nadia", phone: "", address: "" }],
      fromCache: false,
    });
  });
});
