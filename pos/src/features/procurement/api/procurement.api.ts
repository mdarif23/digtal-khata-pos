import api from "@/api/axios";

/** Smart Procurement — product price intelligence API (Phase 1). */

export interface PriceOverviewFilters {
  search?: string | undefined;
  categoryId?: number | undefined;
  supplierId?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface PriceHistoryFilters {
  supplierId?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface PriceOverviewRow {
  variantId: number;
  sku: string | null;
  productId: number;
  productName: string;
  categoryName: string;
  unitName: string | null;
  latestPrice: number | null;
  previousPrice: number | null;
  lowestPrice: number;
  highestPrice: number;
  averagePrice: number | null;
  purchaseCount: number;
  totalReceivedQuantity: number;
  lastPurchaseDate: string | null;
  lastSupplierId: number | null;
  lastSupplierName: string | null;
  priceChangePercent: number | null;
  latestQuotation: number | null;
  lastObservationDate: string | null;
}

export interface PaginatedPriceOverview {
  data: PriceOverviewRow[];
  total: number;
  page: number;
  limit: number;
}

export interface SupplierPriceRow {
  supplierId: number | null;
  supplierName: string | null;
  latestPrice: number | null;
  previousPrice: number | null;
  lowestPrice: number;
  highestPrice: number;
  averagePrice: number | null;
  purchaseCount: number;
  lastPurchaseDate: string | null;
  priceChangePercent: number | null;
  /** Latest recorded quotation from this supplier, normalized per unit. */
  latestQuotation: number | null;
  lastObservationDate: string | null;
}

export interface ObservationRecord {
  id: number;
  observationDate: string;
  supplierId: number | null;
  supplierName: string | null;
  quotedPrice: number;
  packageQuantity: number | null;
  unitPrice: number | null;
  notes: string | null;
}

export interface PriceEventRecord {
  purchaseId: number;
  purchaseOrderNumber: string;
  purchaseDate: string;
  supplierId: number | null;
  supplierName: string | null;
  unitCost: number;
  quantity: number;
  receivedQuantity: number;
}

export interface VariantPriceHistory {
  variant: {
    variantId: number;
    productId: number;
    productName: string;
    sku: string | null;
    unitName: string | null;
    sellingPrice: number;
  };
  summary: {
    latestPrice: number | null;
    previousPrice: number | null;
    lowestPrice: number | null;
    highestPrice: number | null;
    averagePrice: number | null;
    purchaseCount: number;
    totalReceivedQuantity: number;
    lastPurchaseDate: string | null;
    priceChangeAmount: number | null;
    priceChangePercent: number | null;
  };
  suppliers: SupplierPriceRow[];
  records: {
    data: PriceEventRecord[];
    total: number;
    page: number;
    limit: number;
  };
  /** Market quotations ("Quick Price Check") — always labeled as quotations. */
  observations: {
    data: ObservationRecord[];
    total: number;
  };
}

/** Quick Price Check (Phase 2) — manual market quotations. */

export interface ObservationRow {
  id: number;
  variantId: number;
  productName: string;
  sku: string | null;
  unitName: string | null;
  supplierId: number | null;
  supplierName: string | null;
  quotedPrice: number;
  packageQuantity: number | null;
  unitPrice: number | null;
  observationDate: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedObservations {
  data: ObservationRow[];
  total: number;
  page: number;
  limit: number;
}

export interface PriceCheckFilters {
  search?: string | undefined;
  variantId?: number | undefined;
  supplierId?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface CreateObservationInput {
  variantId: number;
  supplierId: number;
  quotedPrice: number;
  packageQuantity?: number | null | undefined;
  observationDate?: string | undefined;
  notes?: string | null | undefined;
}

export interface UpdateObservationInput {
  supplierId?: number | undefined;
  quotedPrice?: number | undefined;
  packageQuantity?: number | null | undefined;
  observationDate?: string | undefined;
  notes?: string | null | undefined;
}

function toQuery(filters: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function getPriceOverviewApi(
  filters: PriceOverviewFilters = {},
): Promise<PaginatedPriceOverview> {
  const { data } = await api.get<{
    success: boolean;
    data: PaginatedPriceOverview;
  }>(`/procurement/price-overview${toQuery(filters)}`);
  return data.data;
}

export async function getVariantPriceHistoryApi(
  variantId: number,
  filters: PriceHistoryFilters = {},
): Promise<VariantPriceHistory> {
  const { data } = await api.get<{ success: boolean; data: VariantPriceHistory }>(
    `/procurement/variants/${variantId}/price-history${toQuery(filters)}`,
  );
  return data.data;
}

export async function listObservationsApi(
  filters: PriceCheckFilters = {},
): Promise<PaginatedObservations> {
  const { data } = await api.get<{ success: boolean; data: PaginatedObservations }>(
    `/procurement/price-check${toQuery(filters)}`,
  );
  return data.data;
}

export async function createObservationApi(payload: CreateObservationInput) {
  const { data } = await api.post<{ success: boolean; data: { id: number } }>(
    "/procurement/price-check",
    payload,
  );
  return data.data;
}

export async function updateObservationApi(
  id: number,
  payload: UpdateObservationInput,
): Promise<ObservationRow> {
  const { data } = await api.patch<{ success: boolean; data: ObservationRow }>(
    `/procurement/price-check/${id}`,
    payload,
  );
  return data.data;
}

export async function deleteObservationApi(id: number) {
  await api.delete(`/procurement/price-check/${id}`);
}

/** Supplier price monitoring (Phase 3). */

export interface SupplierDetail {
  supplier: {
    id: number;
    name: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    status: string | null;
    minimumOrderValue: number | null;
    targetOrderValue: number | null;
    orderSettingsEnabled: boolean;
    orderSettingsNotes: string | null;
  };
  stats: {
    purchaseCount: number;
    totalReceivedValue: number;
    productCount: number;
    lastPurchaseDate: string | null;
  };
}

export interface SupplierHistoryFilters {
  search?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface SupplierVariantEvent {
  purchaseId: number;
  purchaseOrderNumber: string;
  purchaseDate: string;
  unitCost: number;
  receivedQuantity: number;
}

export interface AlertSettings {
  enabled: boolean;
  increaseThresholdPercent: number;
}

export async function getSupplierDetailApi(
  supplierId: number,
): Promise<SupplierDetail> {
  const { data } = await api.get<{ success: boolean; data: SupplierDetail }>(
    `/procurement/suppliers/${supplierId}`,
  );
  return data.data;
}

export interface UpdateOrderSettingsInput {
  minimumOrderValue?: number | null | undefined;
  targetOrderValue?: number | null | undefined;
  orderSettingsEnabled?: boolean | undefined;
  orderSettingsNotes?: string | null | undefined;
}

export async function updateOrderSettingsApi(
  supplierId: number,
  payload: UpdateOrderSettingsInput,
): Promise<SupplierDetail> {
  const { data } = await api.patch<{ success: boolean; data: SupplierDetail }>(
    `/procurement/suppliers/${supplierId}/order-settings`,
    payload,
  );
  return data.data;
}

export async function getSupplierPriceHistoryApi(
  supplierId: number,
  filters: SupplierHistoryFilters = {},
): Promise<PaginatedPriceOverview> {
  const { data } = await api.get<{
    success: boolean;
    data: PaginatedPriceOverview;
  }>(`/procurement/suppliers/${supplierId}/price-history${toQuery(filters)}`);
  return data.data;
}

export async function getSupplierVariantTrendApi(
  supplierId: number,
  variantId: number,
): Promise<SupplierVariantEvent[]> {
  const { data } = await api.get<{
    success: boolean;
    data: SupplierVariantEvent[];
  }>(`/procurement/suppliers/${supplierId}/trend`, {
    params: { variantId },
  });
  return data.data;
}

export async function getAlertSettingsApi(): Promise<AlertSettings> {
  const { data } = await api.get<{ success: boolean; data: AlertSettings }>(
    "/procurement/alert-settings",
  );
  return data.data;
}

export async function updateAlertSettingsApi(
  payload: AlertSettings,
): Promise<AlertSettings> {
  const { data } = await api.put<{ success: boolean; data: AlertSettings }>(
    "/procurement/alert-settings",
    payload,
  );
  return data.data;
}

/** Smart Reorder Planning (Phase 4). */

export type ReorderStatus =
  | "out_of_stock"
  | "low_stock"
  | "needs_reorder"
  | "healthy";

export interface ReorderRow {
  variantId: number;
  productId: number;
  productName: string;
  sku: string | null;
  categoryName: string;
  unitName: string | null;
  currentStock: number;
  reservedQuantity: number;
  outstandingOnOrder: number;
  inTransitQuantity: number;
  availableQuantity: number;
  reorderPoint: number | null;
  reorderQuantity: number | null;
  alertQuantity: number;
  status: ReorderStatus;
  suggestedQuantity: number | null;
  lastUnitCost: number | null;
  estimatedValue: number | null;
  lastSupplierId: number | null;
  lastSupplierName: string | null;
}

export interface ReorderDashboardSummary {
  outOfStock: number;
  lowStock: number;
  needsReorder: number;
  attentionCount: number;
  noSupplierCount: number;
  missingPriceCount: number;
  totalEstimatedValue: number;
  supplierCount: number;
}

export type OrderValueStatus =
  | "below_minimum"
  | "minimum_reached"
  | "target_reached"
  | "above_target"
  | "ready_for_review";

export interface SupplierReorderGroup {
  supplierId: number | null;
  supplierName: string | null;
  itemCount: number;
  totalQuantity: number;
  estimatedValue: number;
  minimumOrderValue: number | null;
  targetOrderValue: number | null;
  orderStatus: OrderValueStatus;
  amountRemaining: number;
}

export interface ReorderDashboard {
  summary: ReorderDashboardSummary;
  suppliers: SupplierReorderGroup[];
  data: ReorderRow[];
  total: number;
  page: number;
  limit: number;
}

export interface ReorderDashboardFilters {
  search?: string | undefined;
  status?: "all" | "attention" | ReorderStatus | undefined;
  supplierId?: number | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface ConvertSuggestionsInput {
  supplierId: number | null;
  items: { variantId: number; quantity?: number | undefined }[];
  note?: string | null | undefined;
}

export async function getReorderDashboardApi(
  filters: ReorderDashboardFilters = {},
): Promise<ReorderDashboard> {
  const { data } = await api.get<{ success: boolean; data: ReorderDashboard }>(
    `/procurement/reorder-dashboard${toQuery(filters)}`,
  );
  return data.data;
}

/** Creates an unpaid ordered PO via the existing reorder conversion flow. */
export async function convertSuggestionsApi(payload: ConvertSuggestionsInput) {
  const { data } = await api.post<{
    message?: string;
    data?: { purchaseOrderNumber?: string };
  }>("/reorder-suggestions/convert", payload);
  return data.data ?? {};
}
