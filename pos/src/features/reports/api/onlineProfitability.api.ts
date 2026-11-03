import api from "@/api/axios";
import type { AxiosResponse } from "axios";
import type {
  ProfitabilityChannelRow,
  ProfitabilityExpenseRow,
  ProfitabilityProductsPage,
  ProfitabilitySummary,
  ProfitabilityTrendPoint,
} from "../types/report.types";

/** Online Store Profitability API (module three). The backend computes every
 * figure from persisted order-time snapshots; this layer only passes filters. */

export interface ProfitabilityParams {
  from?: string | undefined;
  to?: string | undefined;
  locationId?: number | undefined;
  channel?: "woocommerce" | "custom_storefront" | undefined;
  courierName?: string | undefined;
  paymentMethod?: string | undefined;
}

export interface ProfitabilityProductsParams extends ProfitabilityParams {
  page?: number | undefined;
  pageSize?: number | undefined;
  sort?: "profit" | "margin" | "losses" | undefined;
}

function toQuery(params: ProfitabilityParams): Record<string, string | number> {
  const q: Record<string, string | number> = {};
  if (params.from) q.from = params.from;
  if (params.to) q.to = params.to;
  if (params.locationId) q.locationId = params.locationId;
  if (params.channel) q.channel = params.channel;
  if (params.courierName) q.courierName = params.courierName;
  if (params.paymentMethod) q.paymentMethod = params.paymentMethod;
  return q;
}

export const onlineProfitabilityApi = {
  getSummary(
    params: ProfitabilityParams,
  ): Promise<AxiosResponse<{ success: boolean; data: ProfitabilitySummary }>> {
    return api.get("/reports/online-profitability/summary", {
      params: toQuery(params),
    });
  },
  getTrends(
    params: ProfitabilityParams,
  ): Promise<
    AxiosResponse<{ success: boolean; data: ProfitabilityTrendPoint[] }>
  > {
    return api.get("/reports/online-profitability/trends", {
      params: toQuery(params),
    });
  },
  getProducts(
    params: ProfitabilityProductsParams,
  ): Promise<
    AxiosResponse<{ success: boolean; data: ProfitabilityProductsPage }>
  > {
    return api.get("/reports/online-profitability/products", {
      params: { ...toQuery(params), page: params.page, pageSize: params.pageSize, sort: params.sort },
    });
  },
  getChannels(
    params: ProfitabilityParams,
  ): Promise<
    AxiosResponse<{ success: boolean; data: ProfitabilityChannelRow[] }>
  > {
    return api.get("/reports/online-profitability/channels", {
      params: toQuery(params),
    });
  },
  getExpenses(
    params: ProfitabilityParams,
  ): Promise<
    AxiosResponse<{
      success: boolean;
      data: { rows: ProfitabilityExpenseRow[]; total: number };
    }>
  > {
    return api.get("/reports/online-profitability/expenses", {
      params: toQuery(params),
    });
  },
};
