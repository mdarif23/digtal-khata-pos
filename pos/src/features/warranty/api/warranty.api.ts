import api from "@/api/axios";
import type { Member } from "@/features/users/users.api";
import type {
  CreateSupplierClaimInput,
  CreateSupplierWarrantyInput,
  CreateWarrantyClaimInput,
  SupplierClaimFilters,
  SupplierWarrantyClaimDetail,
  SupplierWarrantyClaimRow,
  SupplierWarrantyFilters,
  SupplierWarrantyRow,
  WarrantyCertificateData,
  WarrantyClaimDetail,
  WarrantyClaimRow,
  WarrantyClaimsFilters,
  WarrantyClaimsReportData,
  WarrantyCostsReportData,
  WarrantyDetail,
  WarrantyExpiryReportFilters,
  WarrantyExpiryReportRow,
  WarrantyListFilters,
  WarrantyListRow,
  WarrantyLookupType,
  WarrantyOverviewData,
  WarrantySupplierRecoveryRow,
} from "../types/warranty.types";

/**
 * Warranty Management API. Every endpoint is business-scoped through the
 * axios instance interceptors (auth token, X-Business-Id, X-Location-Id);
 * location filtering on lists is an optional `?locationId=` query param.
 */

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface Envelope<T> {
  success: boolean;
  message?: string;
  data: T;
  meta?: PageMeta | undefined;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: PageMeta;
}

/**
 * Drops null/undefined/"" entries so optional filters never reach the API
 * as empty strings (the backend treats those as "unset").
 */
function toParams(
  filters: Record<string, string | number | null | undefined>,
): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params[key] = value;
  }
  return params;
}

const FALLBACK_META: PageMeta = {
  page: 1,
  pageSize: 0,
  total: 0,
  totalPages: 1,
};

// ---------------- Customer warranties ----------------

export async function getWarrantiesApi(
  filters: WarrantyListFilters,
): Promise<PaginatedResult<WarrantyListRow>> {
  const { data } = await api.get<Envelope<WarrantyListRow[]>>("/warranties", {
    params: toParams({ ...filters }),
  });
  return { data: data.data ?? [], meta: data.meta ?? FALLBACK_META };
}

export async function lookupWarrantiesApi(
  type: WarrantyLookupType,
  query: string,
): Promise<WarrantyListRow[]> {
  const { data } = await api.get<Envelope<WarrantyListRow[]>>(
    "/warranties/lookup",
    { params: toParams({ type, q: query }) },
  );
  return data.data ?? [];
}

export async function getWarrantyDetailApi(
  warrantyId: number,
): Promise<WarrantyDetail> {
  const { data } = await api.get<Envelope<WarrantyDetail>>(
    `/warranties/${warrantyId}`,
  );
  return data.data;
}

export async function getWarrantyCertificateApi(
  warrantyId: number,
): Promise<WarrantyCertificateData> {
  const { data } = await api.get<Envelope<WarrantyCertificateData>>(
    `/warranties/${warrantyId}/certificate`,
  );
  return data.data;
}

export async function getWarrantyOverviewApi(): Promise<WarrantyOverviewData> {
  const { data } = await api.get<Envelope<WarrantyOverviewData>>(
    "/warranty-overview",
  );
  return data.data;
}

// ---------------- Customer warranty claims ----------------

export async function getWarrantyClaimsApi(
  filters: WarrantyClaimsFilters,
): Promise<PaginatedResult<WarrantyClaimRow>> {
  const { data } = await api.get<Envelope<WarrantyClaimRow[]>>(
    "/warranty-claims",
    { params: toParams({ ...filters }) },
  );
  return { data: data.data ?? [], meta: data.meta ?? FALLBACK_META };
}

export async function getWarrantyClaimDetailApi(
  claimId: number,
): Promise<WarrantyClaimDetail> {
  const { data } = await api.get<Envelope<WarrantyClaimDetail>>(
    `/warranty-claims/${claimId}`,
  );
  return data.data;
}

export async function createWarrantyClaimApi(
  input: CreateWarrantyClaimInput,
): Promise<WarrantyClaimRow> {
  const { data } = await api.post<Envelope<WarrantyClaimRow>>(
    "/warranty-claims",
    input,
  );
  return data.data;
}

async function claimAction<T = WarrantyClaimRow>(
  claimId: number,
  action: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const { data } = await api.post<Envelope<T>>(
    `/warranty-claims/${claimId}/${action}`,
    body ?? {},
  );
  return data.data;
}

export function inspectWarrantyClaimApi(claimId: number, body: { inspectionNotes?: string; receivedDate?: string }) {
  return claimAction(claimId, "inspection", body);
}

export function approveWarrantyClaimApi(
  claimId: number,
  body: { inspectionNotes?: string; assignedUserId?: number; note?: string },
) {
  return claimAction(claimId, "approve", body);
}

export function rejectWarrantyClaimApi(claimId: number, body: { resolutionNotes: string }) {
  return claimAction(claimId, "reject", body);
}

export function updateWarrantyRepairApi(
  claimId: number,
  body: {
    status: "repairing" | "waiting_parts";
    repairDescription?: string;
    partsUsed?: string;
    repairCost?: number;
    assignedUserId?: number;
    note?: string;
  },
) {
  return claimAction(claimId, "repair", body);
}

export function assignWarrantyClaimApi(
  claimId: number,
  body: { assignedUserId: number; note?: string },
) {
  return claimAction(claimId, "assign", body);
}

export function readyWarrantyClaimApi(claimId: number) {
  return claimAction(claimId, "ready");
}

export function pickupWarrantyClaimApi(claimId: number) {
  return claimAction(claimId, "pickup");
}

export function replaceWarrantyClaimApi(
  claimId: number,
  body: { replacementVariantId: number; replacementSerialNumber?: string; note?: string },
) {
  return claimAction(claimId, "replacement", body);
}

export function closeWarrantyClaimApi(claimId: number) {
  return claimAction(claimId, "close");
}

export function cancelWarrantyClaimApi(claimId: number) {
  return claimAction(claimId, "cancel");
}

export function addWarrantyClaimNoteApi(claimId: number, body: { note: string }) {
  return claimAction(claimId, "notes", body);
}

/** Staff list for the technician assignment selects (users.view gated
 * server-side; the option list simply renders empty without it). */
export async function getStaffOptionsApi(): Promise<Member[]> {
  const { data } = await api.get<Envelope<Member[]>>("/users");
  return data.data ?? [];
}

// ---------------- Supplier warranties ----------------

export async function getSupplierWarrantiesApi(
  filters: SupplierWarrantyFilters,
): Promise<PaginatedResult<SupplierWarrantyRow>> {
  const { data } = await api.get<Envelope<SupplierWarrantyRow[]>>(
    "/supplier-warranties",
    { params: toParams({ ...filters }) },
  );
  return { data: data.data ?? [], meta: data.meta ?? FALLBACK_META };
}

export async function createSupplierWarrantyApi(
  input: CreateSupplierWarrantyInput,
): Promise<SupplierWarrantyRow> {
  const { data } = await api.post<Envelope<SupplierWarrantyRow>>(
    "/supplier-warranties",
    input,
  );
  return data.data;
}

// ---------------- Supplier warranty claims ----------------

export async function getSupplierWarrantyClaimsApi(
  filters: SupplierClaimFilters,
): Promise<PaginatedResult<SupplierWarrantyClaimRow>> {
  const { data } = await api.get<Envelope<SupplierWarrantyClaimRow[]>>(
    "/supplier-warranty-claims",
    { params: toParams({ ...filters }) },
  );
  return { data: data.data ?? [], meta: data.meta ?? FALLBACK_META };
}

export async function getSupplierWarrantyClaimDetailApi(
  claimId: number,
): Promise<SupplierWarrantyClaimDetail> {
  const { data } = await api.get<Envelope<SupplierWarrantyClaimDetail>>(
    `/supplier-warranty-claims/${claimId}`,
  );
  return data.data;
}

export async function createSupplierWarrantyClaimApi(
  input: CreateSupplierClaimInput,
): Promise<SupplierWarrantyClaimRow> {
  const { data } = await api.post<Envelope<SupplierWarrantyClaimRow>>(
    "/supplier-warranty-claims",
    input,
  );
  return data.data;
}

async function supplierClaimAction(
  claimId: number,
  action: string,
  body?: Record<string, unknown>,
): Promise<SupplierWarrantyClaimRow> {
  const { data } = await api.post<Envelope<SupplierWarrantyClaimRow>>(
    `/supplier-warranty-claims/${claimId}/${action}`,
    body ?? {},
  );
  return data.data;
}

export function respondSupplierClaimApi(
  claimId: number,
  body: { status: "sent_to_supplier" | "under_repair" | "rejected"; note?: string },
) {
  return supplierClaimAction(claimId, "response", body);
}

export function replaceSupplierClaimApi(
  claimId: number,
  body: {
    replacementQuantity: number;
    replacementSerialNumbers?: string;
    intake: "none" | "adjust";
    note?: string;
  },
) {
  return supplierClaimAction(claimId, "replacement", body);
}

export function recoverSupplierClaimApi(
  claimId: number,
  body: {
    recoveryAmount: number;
    recoveryMethod: "credit_note" | "replacement" | "cash";
    recoveryReferenceId?: string;
    note?: string;
  },
) {
  return supplierClaimAction(claimId, "recovery", body);
}

export function closeSupplierClaimApi(claimId: number) {
  return supplierClaimAction(claimId, "close");
}

export function cancelSupplierClaimApi(claimId: number) {
  return supplierClaimAction(claimId, "cancel");
}

export function noteSupplierClaimApi(claimId: number, body: { note: string }) {
  return supplierClaimAction(claimId, "notes", body);
}

// ---------------- Warranty reports ----------------
// These return the axios response (not the unwrapped payload) so the shared
// useReportData hook in features/reports can consume them directly.

export interface WarrantyExpiryReportResult {
  data: WarrantyExpiryReportRow[];
  total: number;
  page: number;
  limit: number;
}

export function getWarrantyExpiryReportApi(filters: WarrantyExpiryReportFilters) {
  return api.get<Envelope<WarrantyExpiryReportResult>>(
    "/reports/warranty/expiry",
    { params: toParams({ ...filters }) },
  );
}

export function getWarrantyClaimsReportApi(filters: {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  locationId?: number | undefined;
}) {
  return api.get<Envelope<WarrantyClaimsReportData>>(
    "/reports/warranty/claims",
    { params: toParams({ ...filters }) },
  );
}

export function getWarrantyCostsReportApi() {
  return api.get<Envelope<WarrantyCostsReportData>>("/reports/warranty/costs");
}

export function getWarrantySupplierReportApi() {
  return api.get<Envelope<WarrantySupplierRecoveryRow[]>>(
    "/reports/warranty/supplier",
  );
}
