import axios from "../../api/axios.js";
import { AddCategorySchemaType } from "./addCategory.schema.js";
import { BrandSchemaType } from "./brand.schema.js";
import { ProductTypeInput, ProductTypeOutput } from "./product.schema.js";
import {
  StockAdjustmentInput,
  StockAdjustmentResult,
} from "./product.types.js";
import { UnitSchemaType } from "./schemas/unit.schema.js";
import {
  VariantOptionSchemaType,
  VariantTypeSchemaType,
} from "./schemas/variant.schema.js";
export async function getProductsApi() {
  const { data } = await axios.get("/products");
  return data;
}
export async function getProductSelectOptionsApi() {
  const { data } = await axios.get("/product/select-options");
  return data;
}
export async function getProductVariantOptionsApi() {
  const { data } = await axios.get("/product/variant-options");
  return data;
}
export async function createProductApi(data: ProductTypeOutput) {
  return axios.post("/product", data);
}
export async function getProductForEditApi(id: number) {
  const { data } = await axios.get<ProductTypeInput>(`/product/${id}`);
  return data;
}
export async function updateProductApi(id: number, data: ProductTypeOutput) {
  const { data: response } = await axios.put<{
    data: {
      productId: number;
      addedVariants: { id: number; sku: string }[];
    };
  }>(`/product/${id}`, data);
  return response.data;
}
export interface ProductImageRow {
  id: number;
  productId: number | null;
  imageUrl: string;
  is_primary: boolean;
  sortOrder: number;
}

async function uploadProductImageFile(productId: number, file: File) {
  // 1. presign  2. browser PUT  3. register (expense-attachment flow)
  const presign = await axios.post<{ success: boolean; data: { objectKey: string; uploadUrl: string } }>(
    `/products/${productId}/images/presign`,
    { contentType: file.type, sizeBytes: file.size },
  );
  const { objectKey, uploadUrl } = presign.data.data;
  await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  const registered = await axios.post<{ success: boolean; data: ProductImageRow }>(
    `/products/${productId}/images`,
    { objectKey, contentType: file.type },
  );
  return registered.data.data;
}

export async function attachProductImageIfAny(
  productId: number,
  file: File | null | undefined,
): Promise<ProductImageRow | null> {
  if (!file) return null;
  return uploadProductImageFile(productId, file);
}

export async function listProductImagesApi(productId: number) {
  const { data } = await axios.get<{ success: boolean; data: ProductImageRow[] }>(
    `/products/${productId}/images`,
  );
  return data.data;
}

export async function adjustVariantStockApi(
  variantId: number,
  data: StockAdjustmentInput,
) {
  const { data: response } = await axios.post<{
    data: StockAdjustmentResult;
  }>(`/products/variants/${variantId}/adjust-stock`, data);
  return response.data;
}
export async function createCategoryApi(data: AddCategorySchemaType) {
  return axios.post("/product/category", data);
}
export async function updateCategoryApi(
  id: number,
  data: AddCategorySchemaType,
) {
  return axios.put(`/product/category/${id}`, data);
}
export async function deleteCategoryApi(id: number) {
  return axios.delete(`/product/category/${id}`);
}
export async function createBrandApi(data: BrandSchemaType) {
  return axios.post("/product/brand", data);
}
export async function updateBrandApi(id: number, data: BrandSchemaType) {
  return axios.put(`/product/brand/${id}`, data);
}
export async function deleteBrandApi(id: number) {
  return axios.delete(`/product/brand/${id}`);
}
export async function createUnitApi(data: UnitSchemaType) {
  return axios.post("/product/unit", data);
}
export async function updateUnitApi(id: number, data: UnitSchemaType) {
  return axios.put(`/product/unit/${id}`, data);
}
export async function deleteUnitApi(id: number) {
  return axios.delete(`/product/unit/${id}`);
}
export async function createVariantTypeApi(data: VariantTypeSchemaType) {
  return axios.post("/product/variant-type", data);
}
export async function updateVariantTypeApi(
  id: number,
  data: VariantTypeSchemaType,
) {
  return axios.put(`/product/variant-type/${id}`, data);
}
export async function deleteVariantTypeApi(id: number) {
  return axios.delete(`/product/variant-type/${id}`);
}
export async function createVariantOptionApi(data: VariantOptionSchemaType) {
  return axios.post("/product/variant-option", data);
}
export async function updateVariantOptionApi(id: number, value: string) {
  return axios.put(`/product/variant-option/${id}`, { value });
}
export async function deleteVariantOptionApi(id: number) {
  return axios.delete(`/product/variant-option/${id}`);
}
