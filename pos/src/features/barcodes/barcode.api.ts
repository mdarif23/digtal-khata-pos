import axios from "../../api/axios.js";
import type { BarcodeFormat } from "./barcodeFormats.js";

/**
 * Barcode module API — mirrors the backend Phase D endpoints.
 */

export interface BarcodeAlias {
  id: number;
  barcode: string;
  barcodeFormat: string | null;
  source: string;
}

export interface BarcodeVariantView {
  variantId: number;
  productId: number;
  productName: string;
  variantLabel: string | null;
  sku: string;
  barcode: string | null;
  barcodeFormat: string | null;
  sellingPrice: number;
  hasVariants: boolean;
  aliases: BarcodeAlias[];
}

export interface BarcodeSearchResponse {
  rows: BarcodeVariantView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LookupMatch {
  matchType: "primary" | "alias";
  variantId: number;
  productId: number;
  productName: string;
  variantLabel: string | null;
  sku: string;
  barcode: string;
  barcodeFormat: string | null;
  sellingPrice: number;
  hasVariants: boolean;
  /** products.status — modules decide what an inactive product means. */
  productStatus: string | null;
  variantStatus: string | null;
  /** products.tracking_type: none | batch | serial. */
  trackingType: string | null;
  /** On-hand quantity at the active location (0 when unknown). */
  stockAtLocation: number;
  /** Only present for purchase-cost authorized roles; null otherwise. */
  purchaseCost: number | null;
}

export type LookupResponse =
  | LookupMatch
  | { matchType: "not_found" }
  | { matchType: "ambiguous"; detail: string };

export interface ValidationResponse {
  valid: boolean;
  format?: BarcodeFormat;
  error?: string;
  conflictWith?: string;
}

export interface PrintHistoryEntry {
  id: number;
  userId: number | null;
  variantCount: number;
  copies: number;
  template: string | null;
  createdAt: string | null;
}

function extractMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: { data?: { message?: string } } }).response
      ?.data?.message === "string"
  ) {
    return (error as { response: { data: { message: string } } }).response.data
      .message;
  }
  return fallback;
}

export async function searchBarcodeVariantsApi(params: {
  search?: string | undefined;
  categoryId?: number | undefined;
  brandId?: number | undefined;
  page?: number;
  pageSize?: number;
}): Promise<BarcodeSearchResponse> {
  const res = await axios.get<{ success: boolean; data: BarcodeSearchResponse }>(
    "/barcodes/search",
    { params },
  );
  return res.data.data;
}

export async function getVariantBarcodesApi(
  variantId: number,
): Promise<BarcodeVariantView> {
  const res = await axios.get<{ success: boolean; data: BarcodeVariantView }>(
    `/barcodes/variant/${variantId}`,
  );
  return res.data.data;
}

export async function generateBarcodesApi(input: {
  variantIds: number[];
  regenerate?: boolean;
}): Promise<{ generated: { variantId: number; barcode: string; target: string }[] }> {
  try {
    const res = await axios.post<{ success: boolean; data: { generated: { variantId: number; barcode: string; target: string }[] } }>(
      "/barcodes/generate",
      input,
    );
    return res.data.data;
  } catch (error) {
    throw new Error(extractMessage(error, "Unable to generate barcodes."));
  }
}

export async function assignBarcodeApi(input: {
  variantId: number;
  barcode: string;
  format?: BarcodeFormat;
  target: "primary" | "alias";
  replace?: boolean;
}): Promise<BarcodeVariantView> {
  try {
    const res = await axios.post<{ success: boolean; data: BarcodeVariantView }>(
      "/barcodes/assign",
      input,
    );
    return res.data.data;
  } catch (error) {
    throw new Error(extractMessage(error, "Unable to assign the barcode."));
  }
}

export async function deleteAliasApi(aliasId: number): Promise<void> {
  try {
    await axios.delete(`/barcodes/alias/${aliasId}`);
  } catch (error) {
    throw new Error(extractMessage(error, "Unable to remove the alias."));
  }
}

export async function validateBarcodeApi(input: {
  barcode: string;
  format?: BarcodeFormat;
  variantId?: number;
  aliasId?: number;
}): Promise<ValidationResponse> {
  const res = await axios.post<{ success: boolean; data: ValidationResponse }>(
    "/barcodes/validate",
    input,
  );
  return res.data.data;
}

export async function lookupBarcodeApi(code: string): Promise<LookupResponse> {
  const res = await axios.get<{ success: boolean; data: LookupResponse }>(
    `/barcodes/lookup/${encodeURIComponent(code.trim())}`,
  );
  return res.data.data;
}

export async function getPrintHistoryApi(
  limit = 50,
): Promise<PrintHistoryEntry[]> {
  const res = await axios.get<{ success: boolean; data: PrintHistoryEntry[] }>(
    "/barcodes/print-history",
    { params: { limit } },
  );
  return res.data.data;
}

export async function logPrintJobApi(input: {
  variantCount: number;
  copies: number;
  template?: string;
}): Promise<void> {
  try {
    await axios.post("/barcodes/print-history", input);
  } catch {
    // Print logging is best-effort — never block printing on it.
  }
}
