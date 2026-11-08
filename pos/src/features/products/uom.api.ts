import axios from "../../api/axios.js";
import type {
  AddPackagingUnitPayload,
  PackagingUnitFormValues,
  ProductUomConfig,
  UomMutationResponse,
  UpdatePackagingUnitPayload,
} from "./uom.types.js";

/**
 * Units & Packaging fetchers — same axios instance as product.api.ts so
 * auth/business/location headers and the 401 refresh flow apply.
 */

/** GET /api/product/:productId/uom — base unit + packaging config rows. */
export async function getProductUomApi(
  productId: number,
): Promise<ProductUomConfig> {
  const { data } = await axios.get<{ data: ProductUomConfig }>(
    `/product/${productId}/uom`,
  );
  return data.data;
}

/** POST /api/product/:productId/uom — add a packaging unit (201). */
export async function addPackagingUnitApi(
  productId: number,
  payload: AddPackagingUnitPayload,
): Promise<UomMutationResponse> {
  const { data } = await axios.post<UomMutationResponse>(
    `/product/${productId}/uom`,
    payload,
  );
  return data;
}

/** PATCH /api/product/uom/:conversionId — flags/prices/status (+ factor while unreferenced). */
export async function updatePackagingUnitApi(
  conversionId: number,
  payload: UpdatePackagingUnitPayload,
): Promise<UomMutationResponse> {
  const { data } = await axios.patch<UomMutationResponse>(
    `/product/uom/${conversionId}`,
    payload,
  );
  return data;
}

/**
 * POST /api/product/uom/:conversionId/deactivate — the safe retirement
 * path (rows are never deleted; history keeps its own factor snapshots).
 */
export async function deactivatePackagingUnitApi(
  conversionId: number,
): Promise<UomMutationResponse> {
  const { data } = await axios.post<UomMutationResponse>(
    `/product/uom/${conversionId}/deactivate`,
  );
  return data;
}

/** "" / whitespace-only price inputs mean "unset" → null; negatives are invalid. */
function parseOptionalPrice(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Prices must be zero or a positive number.");
  }
  return value;
}

/**
 * Dialog values → POST /api/product/:productId/uom body.
 *
 * Pure (no network) so the coercion rules are unit-testable: the factor
 * must parse to a number > 0, empty prices become null, and the unitId is
 * carried through as-is (the base unit is excluded by the caller — the
 * backend 400s when it slips through).
 */
export function buildAddPackagingUnitPayload(
  values: PackagingUnitFormValues,
): AddPackagingUnitPayload {
  const conversionFactor = Number(values.contains.trim());
  if (!Number.isFinite(conversionFactor) || conversionFactor <= 0) {
    throw new Error(
      "Contains (qty of base unit) must be a number greater than zero.",
    );
  }
  return {
    unitId: values.unitId,
    conversionFactor,
    isPurchaseEnabled: values.isPurchaseEnabled,
    isSaleEnabled: values.isSaleEnabled,
    isDefaultPurchase: values.isDefaultPurchase,
    isDefaultSale: values.isDefaultSale,
    salePrice: parseOptionalPrice(values.salePrice),
    purchasePrice: parseOptionalPrice(values.purchasePrice),
  };
}

/**
 * Dialog values → PATCH /api/product/uom/:conversionId body. The unit
 * itself is immutable (the PATCH contract has no unitId). When the row is
 * locked the factor is omitted entirely — sending it would 409 even if
 * unchanged, because the endpoint treats any factor as a factor change.
 */
export function buildUpdatePackagingUnitPayload(
  values: Omit<PackagingUnitFormValues, "unitId">,
  options: { includeFactor: boolean },
): UpdatePackagingUnitPayload {
  let conversionFactor: number | undefined;
  if (options.includeFactor) {
    conversionFactor = Number(values.contains.trim());
    if (!Number.isFinite(conversionFactor) || conversionFactor <= 0) {
      throw new Error(
        "Contains (qty of base unit) must be a number greater than zero.",
      );
    }
  }
  return {
    ...(conversionFactor !== undefined ? { conversionFactor } : {}),
    isPurchaseEnabled: values.isPurchaseEnabled,
    isSaleEnabled: values.isSaleEnabled,
    isDefaultPurchase: values.isDefaultPurchase,
    isDefaultSale: values.isDefaultSale,
    salePrice: parseOptionalPrice(values.salePrice),
    purchasePrice: parseOptionalPrice(values.purchasePrice),
  };
}
