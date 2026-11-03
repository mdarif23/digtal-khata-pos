import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { persistCartDebounced, loadPersistedCart } = vi.hoisted(() => ({
  persistCartDebounced: vi.fn(),
  loadPersistedCart: vi.fn(),
}));

// The real persistence module touches IndexedDB (absent in jsdom) and the
// store subscribes to it at module load — both are mocked out here.
vi.mock("../../offline/cartPersistence.js", () => ({
  persistCartDebounced,
  loadPersistedCart,
  persistCartNow: vi.fn(),
  clearPersistedCart: vi.fn(),
}));

vi.mock("../../../../api/axios.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const catalogState = vi.hoisted(() => ({ products: [] as any[] }));

vi.mock("@/features/products/usedashboardProductStore.js", () => ({
  useProductStore: { getState: () => catalogState },
}));

import {
  resumeHeldItems,
  restorePersistedCart,
  useCartStore,
} from "../useCartStore.js";
import type { CartType } from "../../types/cart.types.js";

const variant = (id: number, sellingPrice = 100) => ({ id, sellingPrice });
const product = (id: number, variants: ReturnType<typeof variant>[]) =>
  ({ id, name: `Product ${id}`, variants }) as unknown as CartType;

let uuidCounter = 0;

beforeEach(() => {
  uuidCounter = 0;
  vi.clearAllMocks();
  vi.stubGlobal("crypto", { randomUUID: () => `key-${++uuidCounter}` });
  loadPersistedCart.mockResolvedValue(null);
  useCartStore.setState({ cart: [], checkoutIdempotencyKey: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("addToCart", () => {
  it("adds a new product as one line with quantity 1 and a single variant", () => {
    const p = product(1, [variant(11), variant(12)]);
    useCartStore.getState().addToCart(p);

    const { cart } = useCartStore.getState();
    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(1);
    expect(cart[0].variants).toHaveLength(1);
    expect(cart[0].variants[0].id).toBe(11);
  });

  it("ignores products without variants", () => {
    useCartStore.getState().addToCart(product(1, []));
    expect(useCartStore.getState().cart).toHaveLength(0);
  });

  it("increments quantity when the same variant is added again", () => {
    const p = product(1, [variant(11)]);
    useCartStore.getState().addToCart(p);
    useCartStore.getState().addToCart(p);

    const { cart } = useCartStore.getState();
    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(2);
  });

  it("keeps separate lines for different variants of the same product", () => {
    useCartStore.getState().addToCart(product(1, [variant(11)]));
    useCartStore.getState().addToCart(product(1, [variant(12)]));

    const { cart } = useCartStore.getState();
    expect(cart).toHaveLength(2);
    expect(cart.map((l) => l.variants[0].id).sort()).toEqual([11, 12]);
  });

  it("writes through to the debounced persistence on every change", () => {
    useCartStore.getState().addToCart(product(1, [variant(11)]));
    expect(persistCartDebounced).toHaveBeenCalled();
  });
});

describe("quantity actions", () => {
  it("removes a line by variant id", () => {
    useCartStore.getState().addToCart(product(1, [variant(11)]));
    useCartStore.getState().addToCart(product(2, [variant(21)]));
    useCartStore.getState().removeCartItem(11);

    const { cart } = useCartStore.getState();
    expect(cart).toHaveLength(1);
    expect(cart[0].variants[0].id).toBe(21);
  });

  it("increments and decrements quantities, dropping lines that hit zero", () => {
    useCartStore.getState().addToCart(product(1, [variant(11)]));
    useCartStore.getState().addCartQuantity(11);
    expect(useCartStore.getState().cart[0].quantity).toBe(2);

    useCartStore.getState().removeCartQuantity(11);
    expect(useCartStore.getState().cart[0].quantity).toBe(1);

    useCartStore.getState().removeCartQuantity(11);
    expect(useCartStore.getState().cart).toHaveLength(0);
  });

  it("sets an exact quantity with addCustomCartQuantity", () => {
    useCartStore.getState().addToCart(product(1, [variant(11)]));
    useCartStore.getState().addCustomCartQuantity(11, 7);
    expect(useCartStore.getState().cart[0].quantity).toBe(7);
  });
});

describe("addDiscount and addSerialItem", () => {
  it("attaches the discount to the matching line only", () => {
    useCartStore.getState().addToCart(product(1, [variant(11)]));
    useCartStore.getState().addToCart(product(2, [variant(21)]));
    useCartStore.getState().addDiscount(11, 10, "percentage");

    const { cart } = useCartStore.getState();
    expect(cart[0].discount).toEqual({ value: 10, type: "percentage" });
    expect(cart[1].discount).toBeUndefined();
  });

  it("syncs quantity to the serial count and replaces serials on re-scan", () => {
    const p = product(1, [variant(11)]);
    useCartStore.getState().addSerialItem(p, 11, ["SN-1", "SN-2"]);
    expect(useCartStore.getState().cart[0]).toMatchObject({
      quantity: 2,
      serialNumbers: ["SN-1", "SN-2"],
    });

    useCartStore.getState().addSerialItem(p, 11, ["SN-3"]);
    expect(useCartStore.getState().cart[0]).toMatchObject({
      quantity: 1,
      serialNumbers: ["SN-3"],
    });
  });

  it("ignores unknown variant ids", () => {
    useCartStore.getState().addSerialItem(product(1, [variant(11)]), 999, ["SN-1"]);
    expect(useCartStore.getState().cart).toHaveLength(0);
  });
});

describe("checkout idempotency key", () => {
  it("reuses the same key for retries of one checkout", () => {
    const first = useCartStore.getState().beginCheckout();
    const second = useCartStore.getState().beginCheckout();
    expect(first).toBe("key-1");
    expect(second).toBe(first);
  });

  it("issues a fresh key only after the old one is cleared", () => {
    useCartStore.getState().beginCheckout();
    useCartStore.getState().clearCheckoutIdempotency();
    expect(useCartStore.getState().beginCheckout()).toBe("key-2");
  });

  it("resetCart clears the cart AND the idempotency key", () => {
    useCartStore.getState().addToCart(product(1, [variant(11)]));
    useCartStore.getState().beginCheckout();
    useCartStore.getState().resetCart();

    const { cart, checkoutIdempotencyKey } = useCartStore.getState();
    expect(cart).toEqual([]);
    expect(checkoutIdempotencyKey).toBeNull();
  });
});

describe("resumeHeldItems", () => {
  it("rebuilds lines from the live catalog and reports missing products", () => {
    const live = product(1, [variant(11)]);
    catalogState.products = [live];

    const { lines, missing } = resumeHeldItems([
      { variantId: 11, quantity: 3, productName: "Product 1" },
      { variantId: 424242, quantity: 1, productName: "Ghost Product" },
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(3);
    expect(lines[0].variants[0].id).toBe(11);
    expect(missing).toEqual(["Ghost Product"]);
  });

  it("carries discounts and serials into the rebuilt lines", () => {
    catalogState.products = [product(1, [variant(11)])];

    const { lines } = resumeHeldItems([
      {
        variantId: 11,
        quantity: 2,
        discount: { type: "fixed", value: 5 },
        serialNumbers: ["SN-1", "SN-2"],
        productName: "Product 1",
      },
    ]);

    expect(lines[0]).toMatchObject({
      quantity: 2,
      discount: { type: "fixed", value: 5 },
      serialNumbers: ["SN-1", "SN-2"],
    });
  });
});

describe("restorePersistedCart", () => {
  it("restores the persisted cart and its idempotency key into an empty cart", async () => {
    loadPersistedCart.mockResolvedValueOnce({
      cart: [{ ...product(1, [variant(11)]), quantity: 2 }],
      checkoutIdempotencyKey: "key-9",
    });

    await restorePersistedCart();

    const { cart, checkoutIdempotencyKey } = useCartStore.getState();
    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(2);
    expect(checkoutIdempotencyKey).toBe("key-9");
  });

  it("never overwrites an in-flight cart", async () => {
    useCartStore.setState({
      cart: [{ ...product(2, [variant(21)]), quantity: 1 }],
      checkoutIdempotencyKey: null,
    });

    await restorePersistedCart();

    expect(loadPersistedCart).not.toHaveBeenCalled();
    expect(useCartStore.getState().cart[0].variants[0].id).toBe(21);
  });

  it("leaves an empty cart alone when nothing is persisted", async () => {
    await restorePersistedCart();
    expect(useCartStore.getState().cart).toEqual([]);
  });
});
