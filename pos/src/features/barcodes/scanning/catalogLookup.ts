import type {
  LookupMatch,
  LookupResponse,
} from "../barcode.api.js";
import { lookupBarcodeApi } from "../barcode.api.js";
import type {
  ProductType,
  ProductVariantType,
} from "@/features/products/product.schema.js";

/**
 * Catalog-backed identification for the scanner service: pages whose data
 * lives in a loaded product catalog resolve scans locally first (instant,
 * offline-capable) and fall back to the server lookup for alias barcodes
 * and codes newer than the catalog.
 */

export function findCatalogVariant(
  catalog: ProductType[],
  normalizedCode: string,
): { product: ProductType; variant: ProductVariantType } | undefined {
  return catalog
    .flatMap((product) =>
      product.variants.map((variant) => ({ product, variant })),
    )
    .find(
      ({ variant }) =>
        variant.barcode?.trim().toLowerCase() === normalizedCode ||
        variant.sku.trim().toLowerCase() === normalizedCode,
    );
}

/** Catalog row → lookup payload (variant identity + display data). */
export function toCatalogLookupMatch(
  product: ProductType,
  variant: ProductVariantType,
): LookupMatch {
  return {
    matchType: "primary",
    // Catalog variants always carry a DB id; 0 matches nothing downstream.
    variantId: variant.id ?? 0,
    productId: product.id,
    productName: product.name,
    variantLabel: product.hasVariants
      ? variant.options?.map((option) => option.value).join(" / ") ||
        variant.sku
      : null,
    sku: variant.sku,
    barcode: variant.barcode ?? variant.sku,
    barcodeFormat: null,
    sellingPrice: variant.sellingPrice,
    hasVariants: product.hasVariants,
    productStatus: product.status ?? null,
    variantStatus: variant.status ?? null,
    trackingType: product.trackingType ?? null,
    stockAtLocation: variant.quantity ?? 0,
    purchaseCost: null,
  };
}

/** Builds the service `lookup` over a live catalog getter. */
export function createCatalogLookup(
  getCatalog: () => ProductType[],
): (code: string) => Promise<LookupResponse> {
  return async (code: string): Promise<LookupResponse> => {
    const normalized = code.trim().toLowerCase();
    const local = findCatalogVariant(getCatalog(), normalized);
    if (local) {
      return toCatalogLookupMatch(local.product, local.variant);
    }
    return lookupBarcodeApi(code.trim());
  };
}
