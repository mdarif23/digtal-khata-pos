import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchProductsWithOfflineCache,
  productKeys,
  readProductsCache,
  useProductsQuery,
} from "../useProducts.js";
import { productCatalogActions } from "../useProducts.js";
import { queryClient } from "@/lib/queryClient.js";
import type { ProductType } from "../../product.types.js";

vi.mock("@/api/axios.js", () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getActiveBusinessId: () => 1,
  getActiveLocationId: () => 2,
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

const product = (id: number, variantId: number, quantity: number): ProductType =>
  ({
    id,
    name: `Product ${id}`,
    variants: [{ id: variantId, quantity }],
  }) as unknown as ProductType;

function Probe() {
  const query = useProductsQuery();
  if (query.isPending) return <div>loading</div>;
  if (query.error) return <div>error</div>;
  return <div>{(query.data ?? []).map((p) => p.name).join("|")}</div>;
}

function renderProbe() {
  // The library singleton queryClient — the same instance the store actions
  // and readProductsCache read/write. Cleared between tests.
  return render(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
}

describe("useProductsQuery (Phase 6 Feature 1 — products catalog domain)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadCatalog.mockResolvedValue(null);
    queryClient.clear();
    // The app singleton defaults to retry: 1 with a 1s backoff — disable for
    // deterministic error-state assertions in this file only.
    queryClient.setDefaultOptions({ queries: { retry: false } });
  });

  it("loads the catalog and renders it", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [product(1, 11, 10), product(2, 22, 5)],
    } as never);
    renderProbe();
    await waitFor(() =>
      expect(screen.getByText("Product 1|Product 2")).toBeInTheDocument(),
    );
    expect(mockedGet).toHaveBeenCalledWith("/products");
  });

  it("invalidate-on-signal (stock/product revision) refetches the catalog", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: [product(1, 11, 10)] } as never)
      .mockResolvedValueOnce({
        data: [product(1, 11, 10), product(2, 22, 5)],
      } as never);
    renderProbe();
    await waitFor(() => expect(screen.getByText("Product 1")).toBeInTheDocument());

    await queryClient.invalidateQueries({ queryKey: productKeys.all });

    await waitFor(() =>
      expect(screen.getByText("Product 1|Product 2")).toBeInTheDocument(),
    );
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("falls back to the IndexedDB catalog on a network error (offline path)", async () => {
    mockedGet.mockRejectedValue(
      Object.assign(new Error("Network Error"), { response: undefined }),
    );
    mockedReadCatalog.mockResolvedValueOnce([product(7, 77, 3)]);
    renderProbe();
    await waitFor(() => expect(screen.getByText("Product 7")).toBeInTheDocument());
  });

  it("surfaces non-network failures as the query error state", async () => {
    mockedGet.mockRejectedValue({
      response: { status: 500, data: { message: "boom" } },
    });
    renderProbe();
    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());
  });

  it("keys the catalog by business + location scope", () => {
    expect(productKeys.all).toEqual(["products"]);
    expect(productKeys.catalog()).toEqual(["products", 1, 2, "catalog"]);
  });

  it("optimistic stock actions patch the catalog cache with the same math", async () => {
    mockedGet.mockResolvedValue({ data: [product(1, 11, 10)] } as never);
    await queryClient.prefetchQuery({
      queryKey: productKeys.catalog(),
      queryFn: fetchProductsWithOfflineCache,
    });

    productCatalogActions.takeVariantStock(11, 4);
    expect(readProductsCache()[0]?.variants[0]?.quantity).toBe(6);
    // Clamped at 0 (FIFO sales can never drive stock negative).
    productCatalogActions.takeVariantStock(11, 100);
    expect(readProductsCache()[0]?.variants[0]?.quantity).toBe(0);
    productCatalogActions.returnVariantStock(11, 2);
    expect(readProductsCache()[0]?.variants[0]?.quantity).toBe(2);
  });

  it("adjustVariantStock patches the cache with the server-returned quantity", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { quantity: 42 } },
    } as never);
    mockedGet.mockResolvedValue({ data: [product(1, 11, 10)] } as never);
    await queryClient.prefetchQuery({
      queryKey: productKeys.catalog(),
      queryFn: fetchProductsWithOfflineCache,
    });

    const result = await productCatalogActions.adjustVariantStock(11, {
      quantity: 42,
      reason: "count_correction",
    } as never);
    expect(result.quantity).toBe(42);
    expect(readProductsCache()[0]?.variants[0]?.quantity).toBe(42);
  });
});
