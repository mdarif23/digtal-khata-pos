import axios from "../../api/axios.js";
import type {
  ProductWarrantyConfigView,
  RemoveVariantWarrantyResponse,
  WarrantyConfigMutationResponse,
  WarrantyConfigWrite,
} from "./warrantyConfig.types.js";

/**
 * Product/variant warranty configuration fetchers — same axios instance as
 * product.api.ts so auth/business/location headers and the 401 refresh flow
 * apply. The config lives on SEPARATE endpoints from the product save
 * payload (warranty module, migration 0064).
 */

/** GET /api/products/:productId/warranty-config — default + per-variant views. */
export async function getProductWarrantyConfigApi(
  productId: number,
): Promise<ProductWarrantyConfigView> {
  const { data } = await axios.get<{ data: ProductWarrantyConfigView }>(
    `/products/${productId}/warranty-config`,
  );
  return data.data;
}

/** PUT /api/products/:productId/warranty-config — upsert the product default. */
export async function putProductWarrantyConfigApi(
  productId: number,
  payload: WarrantyConfigWrite,
): Promise<WarrantyConfigMutationResponse> {
  const { data } = await axios.put<WarrantyConfigMutationResponse>(
    `/products/${productId}/warranty-config`,
    payload,
  );
  return data;
}

/** PUT /api/products/:productId/variants/:variantId/warranty-config — upsert an override. */
export async function putVariantWarrantyConfigApi(
  productId: number,
  variantId: number,
  payload: WarrantyConfigWrite,
): Promise<WarrantyConfigMutationResponse> {
  const { data } = await axios.put<WarrantyConfigMutationResponse>(
    `/products/${productId}/variants/${variantId}/warranty-config`,
    payload,
  );
  return data;
}

/**
 * DELETE /api/products/:productId/variants/:variantId/warranty-config —
 * removes the override row so the variant inherits the product default again.
 */
export async function deleteVariantWarrantyConfigApi(
  productId: number,
  variantId: number,
): Promise<RemoveVariantWarrantyResponse> {
  const { data } = await axios.delete<RemoveVariantWarrantyResponse>(
    `/products/${productId}/variants/${variantId}/warranty-config`,
  );
  return data;
}
