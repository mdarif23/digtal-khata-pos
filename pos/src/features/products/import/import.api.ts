import api, { getAccessToken, getActiveBusinessId } from "@/api/axios";

export interface ImportSessionSummary {
  id: number;
  filename: string;
  status: "draft" | "mapped" | "validated" | "running" | "completed" | "failed" | "cancelled";
  mode: "create" | "update" | "upsert" | "skip";
  totals: {
    totalRows?: number;
    validRows?: number;
    errorRows?: number;
    products?: number;
    warnings?: number;
    created?: number;
    updated?: number;
    skipped?: number;
    failed?: number;
    processingMs?: number;
    duplicateOf?: number | null;
    duplicateHeaders?: string[];
  } | null;
  createdAt: string;
  finishedAt: string | null;
  processingMs: number | null;
}

export interface ImportSessionDetail {
  session: ImportSessionSummary & {
    worksheet: string | null;
    headerRow: number;
    mapping: Record<string, string> | null;
    options: { updateFields?: string[]; createMissingMasterData?: boolean } | null;
  };
  rows: {
    id: number;
    rowNumber: number;
    productRef: string | null;
    status: "pending" | "valid" | "error" | "created" | "updated" | "skipped" | "failed";
    payload: {
      record?: Record<string, string | null>;
      normalized?: Record<string, unknown>;
      issues?: { code: string; message: string; field?: string }[];
    } | null;
    errors: { code: string; message: string }[] | null;
    result: { action: string; productId?: number; variantId?: number } | null;
  }[];
}

export interface ImportTotals {
  totalRows: number;
  validRows: number;
  errorRows: number;
  products?: number;
  warnings?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
  processingMs?: number;
}

function unwrap<T>(res: { data: { data: T } }): T {
  return res.data.data;
}

export const productImportApi = {
  upload: async (file: File, worksheet?: string, headerRow = 1) => {
    const res = await fetch(
      `/api/products/import/upload?filename=${encodeURIComponent(file.name)}${
        worksheet ? `&worksheet=${encodeURIComponent(worksheet)}` : ""
      }&headerRow=${headerRow}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Authorization: `Bearer ${getAccessToken() ?? ""}`,
          "X-Business-Id": String(getActiveBusinessId() ?? ""),
        },
        body: file,
      },
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.message ?? "Upload failed");
    return body.data as {
      sessionId: number;
      duplicateOf: number | null;
      mapping: Record<string, string>;
      sheet: { headers: string[]; availableWorksheets: string[]; totalRowCount: number; duplicateHeaders: string[] };
    };
  },

  patch: async (
    sessionId: number,
    input: {
      mapping: Record<string, string>;
      mode?: "create" | "update" | "upsert" | "skip";
      options?: { updateFields?: string[]; createMissingMasterData?: boolean } | null;
    },
  ) =>
    api
      .patch<{ success: boolean; data: ImportTotals }>(
        `/products/import/${sessionId}`,
        input,
      )
      .then((r) => unwrap(r)),

  validate: (sessionId: number) =>
    api
      .post<{ success: boolean; data: ImportTotals }>(
        `/products/import/${sessionId}/validate`,
        {},
      )
      .then((r) => unwrap(r)),

  execute: (sessionId: number) =>
    api
      .post<{ success: boolean; data: ImportTotals }>(
        `/products/import/${sessionId}/execute`,
        {},
      )
      .then((r) => unwrap(r)),

  get: (sessionId: number) =>
    api
      .get<{ success: boolean; data: ImportSessionDetail }>(
        `/products/import/${sessionId}`,
      )
      .then((r) => unwrap(r)),

  history: () =>
    api
      .get<{ success: boolean; data: ImportSessionSummary[] }>(
        "/products/import-history",
      )
      .then((r) => unwrap(r)),
};

export const productExportApi = {
  // Navigating to the URL triggers a browser download (auth via session cookie/token header).
  url: (format: "csv" | "xlsx", filters: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams({ format });
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    return `/api/products/export?${params.toString()}`;
  },
};
