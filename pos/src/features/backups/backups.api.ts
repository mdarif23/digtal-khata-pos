import api from "../../api/axios.js";

/**
 * Backup & Restore API — mirrors the backend /api/backups surface. All
 * endpoints are business-scoped via the X-Business-Id header the axios
 * interceptor attaches.
 */

export interface BackupRow {
  id: number;
  businessId: number;
  type: "manual" | "scheduled" | "safety" | "pre_restore" | "upload";
  status: "pending" | "running" | "completed" | "failed" | "expired" | "deleted";
  storageKey: string | null;
  fileName: string | null;
  fileSize: number | null;
  sha256: string | null;
  manifest: BackupManifest | null;
  moduleSelection: string[] | null;
  error: string | null;
  expiresAt: string | null;
  verifiedAt: string | null;
  triggeredBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupManifest {
  formatVersion: number;
  appVersion: string;
  businessId: number;
  businessName: string;
  businessSlug: string;
  createdAt: string;
  type: string;
  modules: string[];
  recordCounts: Record<string, number>;
  attachmentCounts: Record<string, number>;
  warnings: string[];
  completion: string;
}

export interface RestoreJob {
  id: number;
  businessId: number;
  targetBusinessId: number | null;
  backupId: number | null;
  mode: "full" | "new_business" | "selective";
  modules: string[] | null;
  status:
    | "pending"
    | "validating"
    | "running"
    | "verifying"
    | "completed"
    | "failed"
    | "cancelled";
  stage: string | null;
  progress: { percent?: number; doneGroups?: number; groups?: string[] } | null;
  preRestoreBackupId: number | null;
  result: RestoreResult | null;
  error: string | null;
  createdAt: string;
}

export interface RestoreResult {
  mode: string;
  targetBusinessId: number;
  modules: string[];
  warnings: string[];
  keptRows: Array<{ table: string; count: number }>;
  counts: Array<{ table: string; expected: number; actual: number; match: boolean }>;
  countMismatches: Array<{ table: string; expected: number; actual: number }>;
  orphans: Record<string, number>;
  sequencesReset: number;
  attachmentsRestored: number;
  attachmentsMissing: number;
}

export interface RestorePreview {
  backupId: number;
  manifest: {
    businessId: number;
    businessName: string;
    businessSlug: string;
    createdAt: string;
    appVersion: string;
    modules: string[];
    recordCounts: Record<string, number>;
    attachmentCounts: Record<string, number>;
    warnings: string[];
  };
  mode: "full" | "new_business" | "selective";
  requestedModules: string[];
  checks: Array<{ check: string; ok: boolean; detail: string }>;
  warnings: string[];
  readyForRestore: boolean;
  requiresSafetyBackup: boolean;
}

export interface BackupSchedule {
  id?: number;
  enabled: boolean;
  frequency: "daily" | "weekly";
  hour: number;
  dayOfWeek: number | null;
  retentionDays: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface BackupModulesInfo {
  storageEnabled: boolean;
  groups: Array<{ key: string; label: string; requires: string[]; tables: number }>;
}

export async function getBackupModulesApi(): Promise<BackupModulesInfo> {
  const res = await api.get<{ success: boolean; data: BackupModulesInfo }>(
    "/backups/modules",
  );
  return res.data.data;
}

export async function createBackupApi(modules?: string[] | null): Promise<BackupRow> {
  const res = await api.post<{ success: boolean; data: BackupRow }>("/backups", {
    ...(modules ? { modules } : {}),
  });
  return res.data.data;
}

export async function listBackupsApi(params: {
  page?: number;
  pageSize?: number;
  status?: string;
} = {}): Promise<{ items: BackupRow[]; total: number; page: number; pageSize: number }> {
  const res = await api.get<{
    success: boolean;
    data: { items: BackupRow[]; total: number; page: number; pageSize: number };
  }>("/backups", { params });
  return res.data.data;
}

export async function getBackupApi(id: number): Promise<BackupRow> {
  const res = await api.get<{ success: boolean; data: BackupRow }>(`/backups/${id}`);
  return res.data.data;
}

export async function verifyBackupApi(id: number): Promise<{
  verified: boolean;
  error?: string;
}> {
  const res = await api.post<{ success: boolean; data: { verified: boolean; error?: string } }>(
    `/backups/${id}/verify`,
  );
  return res.data.data;
}

export async function deleteBackupApi(id: number): Promise<void> {
  await api.delete(`/backups/${id}`);
}

/** Authenticated streaming download — works for object storage AND the
 * local-fallback mode; no presigned URLs reach the JS layer. */
export async function downloadBackupApi(id: number, fileName: string): Promise<void> {
  const res = await api.get(`/backups/${id}/download`, { responseType: "blob" });
  const url = URL.createObjectURL(res.data as Blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || `backup-${id}.ezbackup`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function presignUploadApi(): Promise<{ storageKey: string; uploadUrl: string; maxMb: number }> {
  const res = await api.post<{ success: boolean; data: { storageKey: string; uploadUrl: string; maxMb: number } }>(
    "/backups/upload/presign",
  );
  return res.data.data;
}

export async function registerUploadApi(storageKey: string, fileName: string): Promise<BackupRow> {
  const res = await api.post<{ success: boolean; data: BackupRow }>(
    "/backups/upload/register",
    { storageKey, fileName },
  );
  return res.data.data;
}

export async function previewRestoreApi(input: {
  backupId: number;
  mode: "full" | "new_business" | "selective";
  modules?: string[] | null;
}): Promise<RestorePreview> {
  const res = await api.post<{ success: boolean; data: RestorePreview }>(
    "/backups/restore/preview",
    input,
  );
  return res.data.data;
}

export async function restoreApi(input: {
  backupId: number;
  mode: "full" | "new_business" | "selective";
  modules?: string[] | null;
}): Promise<RestoreJob> {
  const res = await api.post<{ success: boolean; data: RestoreJob }>(
    "/backups/restore",
    { ...input, confirm: "RESTORE" },
  );
  return res.data.data;
}

export async function getRestoreJobApi(id: number): Promise<RestoreJob> {
  const res = await api.get<{ success: boolean; data: RestoreJob }>(
    `/backups/restore/${id}`,
  );
  return res.data.data;
}

export async function getScheduleApi(): Promise<{ schedule: BackupSchedule | null; storageEnabled: boolean }> {
  const res = await api.get<{
    success: boolean;
    data: { schedule: BackupSchedule | null; storageEnabled: boolean };
  }>("/backups/schedule");
  return res.data.data;
}

export async function saveScheduleApi(input: {
  enabled: boolean;
  frequency: "daily" | "weekly";
  hour: number;
  dayOfWeek?: number | null;
  retentionDays: number;
}): Promise<BackupSchedule> {
  const res = await api.put<{ success: boolean; data: BackupSchedule }>(
    "/backups/schedule",
    input,
  );
  return res.data.data;
}
