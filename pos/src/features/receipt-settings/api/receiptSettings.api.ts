import api from "@/api/axios";
import type { DocumentType } from "../schemas/documentSettings.schema.js";

/**
 * API client for receipt & invoice customization. All requests are
 * business-scoped by the shared axios instance (Authorization +
 * X-Business-Id headers injected per request).
 */

export interface DocumentSettingsBundleDto {
  sales_receipt: unknown;
  sales_invoice: unknown;
  defaultsVersion: number;
}

export async function getDocumentSettingsApi(): Promise<DocumentSettingsBundleDto> {
  const res = await api.get<{ success: boolean; data: DocumentSettingsBundleDto }>(
    "/document-settings",
  );
  return res.data.data;
}

export async function updateDocumentSettingsApi(
  docType: DocumentType,
  config: unknown,
): Promise<DocumentSettingsBundleDto> {
  const res = await api.put<{ success: boolean; data: DocumentSettingsBundleDto }>(
    `/document-settings/${docType}`,
    { config },
  );
  return res.data.data;
}

export interface BusinessProfileDto {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  website: string | null;
  vatBin: string | null;
  tagline: string | null;
  logoUrl: string | null;
  currency: string;
}

export async function getBusinessProfileApi(businessId: number): Promise<BusinessProfileDto> {
  const res = await api.get<{ success: boolean; business: BusinessProfileDto }>(
    `/businesses/${businessId}`,
  );
  return res.data.business;
}

export interface UpdateBusinessProfileInput {
  name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  website?: string | null;
  vatBin?: string | null;
  tagline?: string | null;
}

export async function updateBusinessProfileApi(
  businessId: number,
  input: UpdateBusinessProfileInput,
): Promise<BusinessProfileDto> {
  const res = await api.put<{ success: boolean; business: BusinessProfileDto }>(
    `/businesses/${businessId}`,
    input,
  );
  return res.data.business;
}

export async function uploadBusinessLogoApi(
  businessId: number,
  dataUrl: string,
): Promise<string | null> {
  const res = await api.put<{ success: boolean; logoUrl: string | null }>(
    `/businesses/${businessId}/logo`,
    { dataUrl },
  );
  return res.data.logoUrl;
}

export async function removeBusinessLogoApi(businessId: number): Promise<string | null> {
  const res = await api.delete<{ success: boolean; logoUrl: string | null }>(
    `/businesses/${businessId}/logo`,
  );
  return res.data.logoUrl;
}
