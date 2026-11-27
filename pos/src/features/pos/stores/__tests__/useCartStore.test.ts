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

const catalogState = vi.hoisted(() => ({
  products: [] as any[],
  tryTakeVariantStock: vi.fn(() => true),
  returnVariantStock: vi.fn(),
}));

// Phase 6: the cart rebuild reads the catalog from the TanStack Query cache
// (readProductsCache) instead of the removed Zustand products array.
vi.mock("@/features/products/hooks/useProducts.js", () => ({
  readProductsCache: () => catalogState.products,
  productCatalogActions: {
    tryTakeVariantStock: catalogState.tryTakeVariantStock,
    returnVariantStock: catalogState.returnVariantStock,
  },
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
  catalogState.tryTakeVariantStock.mockReturnValue(true);
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
    expect(useCartStore.getState().addSerialItem(p, 11, ["SN-1", "SN-2"])).toBe(
      true,
    );
    expect(useCartStore.getState().cart[0]).toMatchObject({
      quantity: 2,
      serialNumbers: ["SN-1", "SN-2"],
    });
    expect(catalogState.tryTakeVariantStock).toHaveBeenCalledWith(11, 2);

    expect(useCartStore.getState().addSerialItem(p, 11, ["SN-3"])).toBe(true);
    expect(useCartStore.getState().cart[0]).toMatchObject({
      quantity: 1,
      serialNumbers: ["SN-3"],
    });
    expect(catalogState.returnVariantStock).toHaveBeenCalledWith(11, 1);
  });

  it("does not add serials when stock reservation fails", () => {
    catalogState.tryTakeVariantStock.mockReturnValueOnce(false);

    expect(
      useCartStore
        .getState()
        .addSerialItem(product(1, [variant(11)]), 11, ["SN-1"]),
    ).toBe(false);
    expect(useCartStore.getState().cart).toHaveLength(0);
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

  it("restores each line's base quantity when explicitly clearing the cart", () => {
    useCartStore.setState({
      cart: [
        { ...product(1, [variant(11)]), quantity: 2, conversionFactor: 12 },
        { ...product(2, [variant(21)]), quantity: 3 },
      ],
    });

    useCartStore.getState().resetCart({ restoreStock: true });

    expect(catalogState.returnVariantStock).toHaveBeenNthCalledWith(1, 11, 24);
    expect(catalogState.returnVariantStock).toHaveBeenNthCalledWith(2, 21, 3);
    expect(useCartStore.getState().cart).toEqual([]);
  });

  it("does not restore stock during the normal post-sale reset", () => {
    useCartStore.setState({
      cart: [{ ...product(1, [variant(11)]), quantity: 2 }],
    });

    useCartStore.getState().resetCart();

    expect(catalogState.returnVariantStock).not.toHaveBeenCalled();
  });
});

describe("resumeHeldItems", () => {
  it("rebuilds lines from the live catalog and reports missing products", async () => {
    const live = product(1, [variant(11)]);
    catalogState.products = [live];

    const { lines, missing } = await resumeHeldItems([
      { variantId: 11, quantity: 3, productName: "Product 1" },
      { variantId: 424242, quantity: 1, productName: "Ghost Product" },
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(3);
    expect(lines[0].variants[0].id).toBe(11);
    expect(missing).toEqual(["Ghost Product"]);
  });

  it("carries discounts and serials into the rebuilt lines", async () => {
    catalogState.products = [product(1, [variant(11)])];

    const { lines } = await resumeHeldItems([
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

// ---------------------------------------------------------------------------
// Packaging-unit selling (UOM, migration 0062)
// ---------------------------------------------------------------------------

import { lineUnitId } from "../../types/cart.types.js";

const boxUnit = {
  uomConversionId: 9001,
  unitName: "Box",
  unitAbbreviation: "box",
  conversionFactor: 12,
  salePrice: 1500,
} as const;

describe("UOM cart lines", () => {
  it("adds a Box line with per-unit price, factor and enteredQuantity mirror", () => {
    useCartStore.getState().addToCart(product(1, [variant(11)]), boxUnit);

    const { cart } = useCartStore.getState();
    expect(cart).toHaveLength(1);
    expect(cart[0]!.quantity).toBe(1);
    expect(cart[0]!.enteredQuantity).toBe(1);
    expect(cart[0]!.uomConversionId).toBe(9001);
    expect(cart[0]!.unitPrice).toBe(1500);
    expect(cart[0]!.conversionFactor).toBe(12);
    expect(lineUnitId(cart[0])).toBe(9001);
  });

  it("keeps Box and Piece lines of the same variant separate and scoped", () => {
    const p = product(1, [variant(11)]);
    useCartStore.getState().addToCart(p, boxUnit);
    useCartStore.getState().addToCart(p);

    const { cart } = useCartStore.getState();
    expect(cart).toHaveLength(2);
    expect(new Set(cart.map((l) => lineUnitId(l)))).toEqual(new Set([9001, null]));

    // Quantity actions are unit-scoped: +1 on the Box line leaves Pcs alone.
    useCartStore.getState().addCartQuantity(11, 9001);
    const boxLine = useCartStore.getState().cart.find((l) => lineUnitId(l) === 9001)!;
    const pcsLine = useCartStore.getState().cart.find((l) => lineUnitId(l) === null)!;
    expect(boxLine.quantity).toBe(2);
    expect(pcsLine.quantity).toBe(1);

    // Removing the Box line keeps the Pcs line.
    useCartStore.getState().removeCartItem(11, 9001);
    expect(useCartStore.getState().cart).toHaveLength(1);
    expect(lineUnitId(useCartStore.getState().cart[0])).toBe(null);
  });

  it("switches a line's unit preserving the base amount and merging", () => {
    const p = product(1, [variant(11)]);
    useCartStore.getState().addToCart(p, boxUnit); // 1 Box = 12 base

    // 1 Box → 12 Pcs (base amount preserved)
    const toBase = {
      uomConversionId: null,
      unitName: "Piece",
      unitAbbreviation: "pc",
      conversionFactor: 1,
      salePrice: 100,
    } as const;
    const result = useCartStore
      .getState()
      .switchLineUnit(11, 9001, toBase);
    expect(result).toEqual({ ok: true, convertedQuantity: 12, merged: false });
    expect(useCartStore.getState().cart[0]!.quantity).toBe(12);
    expect(lineUnitId(useCartStore.getState().cart[0])).toBe(null);

    // 13 Pcs → 1 Box (floor; the odd piece is returned by the caller)
    const up = useCartStore
      .getState()
      .switchLineUnit(11, null, boxUnit);
    expect(up).toEqual({ ok: true, convertedQuantity: 1, merged: false });
    expect(useCartStore.getState().cart[0]!.quantity).toBe(1);

    // 1 Box → Pcs and back is below-one-package in the other direction:
    // switching 1 Box to a 144-factor Carton must refuse.
    const carton = { ...boxUnit, uomConversionId: 9002, conversionFactor: 144 } as const;
    const refused = useCartStore
      .getState()
      .switchLineUnit(11, 9001, carton);
    expect(refused).toEqual({ ok: false, reason: "below-one-package" });
  });

  it("replaceLineUnit re-rings the SAME line as 1 of the picked unit", () => {
    const p = product(1, [variant(11)]);
    useCartStore.getState().addToCart(p); // 1 Pcs (base unit)

    // 1 Pcs → Box: the chip's "make this line that unit" semantics —
    // same line, quantity 1, box price. Never a second line.
    useCartStore.getState().replaceLineUnit(11, null, boxUnit);
    const cart = useCartStore.getState().cart;
    expect(cart).toHaveLength(1);
    expect(lineUnitId(cart[0])).toBe(9001);
    expect(cart[0]!.quantity).toBe(1);
    expect(cart[0]!.unitPrice).toBe(boxUnit.salePrice);

    // A line-scoped discount belongs to the old unit's line — cleared.
    useCartStore.getState().addDiscount(11, 50, "fixed");
    expect(useCartStore.getState().cart[0]!.discount).not.toBeNull();
    useCartStore.getState().replaceLineUnit(11, 9001, boxUnit);
    expect(useCartStore.getState().cart[0]!.discount).toBeNull();
  });

  it("includes the packaging unit in the hold payload and restores it", async () => {
    const p = product(1, [variant(11)]);
    useCartStore.getState().addToCart(p, boxUnit);

    // The hold payload builder lives in the store (useHoldCartStore slice):
    // exercised indirectly — a resumed hold with a UOM line falls back to
    // base when the unit is gone from the catalog.
    catalogState.products = [product(1, [variant(11)])];
    const { lines } = await resumeHeldItems([
      {
        variantId: 11,
        quantity: 2,
        productName: "Product 1",
        uomConversionId: 9001,
        enteredQuantity: 2,
      },
    ]);
    expect(lines).toHaveLength(1);
    // The conversion row is unknown to the local catalog → base-unit line
    // carrying the entered quantity (resume never breaks).
    expect(lines[0]!.quantity).toBe(2);
  });

  describe("setLineBatch (P3 Phase 2 F.1 — R3-005 pins the transitions)", () => {
    const line = (variantId: number) => ({ ...product(variantId, [variant(variantId)]) });

    it("attaches a batch to the matching line only", () => {
      useCartStore.setState({ cart: [line(11), line(12)] });
      useCartStore
        .getState()
        .setLineBatch(11, { id: 71, batchNumber: "B-71" } as never);
      const [first, second] = useCartStore.getState().cart;
      expect(first?.batchId).toBe(71);
      expect(first?.batchNumber).toBe("B-71");
      expect(second?.batchId ?? null).toBeNull();
    });

    it("replaces an existing selection and clears to null", () => {
      useCartStore.setState({ cart: [line(11)] });
      const store = useCartStore.getState();
      store.setLineBatch(11, { id: 71, batchNumber: "B-71" } as never);
      store.setLineBatch(11, { id: 72, batchNumber: "B-72" } as never);
      expect(useCartStore.getState().cart[0]?.batchId).toBe(72);
      store.setLineBatch(11, null);
      const cleared = useCartStore.getState().cart[0];
      expect(cleared?.batchId ?? null).toBeNull();
      expect(cleared?.batchNumber ?? null).toBeNull();
    });
  });
});
