import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createBackupApi,
  deleteBackupApi,
  getBackupApi,
  getBackupModulesApi,
  getRestoreJobApi,
  getScheduleApi,
  listBackupsApi,
  previewRestoreApi,
  restoreApi,
  saveScheduleApi,
  verifyBackupApi,
} from "../backups.api";

/** Query-key factory — same convention as terminals/receipt-settings. */
export const backupKeys = {
  all: ["backups"] as const,
  list: (params?: Record<string, unknown>) =>
    [...backupKeys.all, "list", params ?? {}] as const,
  detail: (id: number) => [...backupKeys.all, "detail", id] as const,
  modules: () => [...backupKeys.all, "modules"] as const,
  schedule: () => [...backupKeys.all, "schedule"] as const,
  restoreJob: (id: number) => [...backupKeys.all, "restore", id] as const,
  preview: (backupId: number, mode: string) =>
    [...backupKeys.all, "preview", backupId, mode] as const,
};

export function useBackupModules() {
  return useQuery({
    queryKey: backupKeys.modules(),
    queryFn: getBackupModulesApi,
    staleTime: 60_000,
  });
}

export function useBackups(params: { page?: number; pageSize?: number; status?: string } = {}) {
  return useQuery({
    queryKey: backupKeys.list(params),
    queryFn: () => listBackupsApi(params),
    // In-flight jobs update server-side; keep the table honest.
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some(
        (b) => b.status === "pending" || b.status === "running",
      )
        ? 2_000
        : false,
  });
}

/** Polls one backup until it leaves pending/running. */
export function useBackupDetail(id: number | null) {
  return useQuery({
    queryKey: backupKeys.detail(id ?? -1),
    queryFn: () => getBackupApi(id!),
    enabled: id !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "running" ? 2_000 : false;
    },
  });
}

export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (modules?: string[] | null) => createBackupApi(modules ?? null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: backupKeys.all }),
  });
}

export function useVerifyBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: verifyBackupApi,
    onSuccess: () => void qc.invalidateQueries({ queryKey: backupKeys.all }),
  });
}

export function useDeleteBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteBackupApi,
    onSuccess: () => void qc.invalidateQueries({ queryKey: backupKeys.all }),
  });
}

export function useBackupSchedule() {
  return useQuery({
    queryKey: backupKeys.schedule(),
    queryFn: getScheduleApi,
  });
}

export function useSaveSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveScheduleApi,
    onSuccess: () => void qc.invalidateQueries({ queryKey: backupKeys.schedule() }),
  });
}

export function useRestorePreview(input: {
  backupId: number | null;
  mode: "full" | "new_business" | "selective" | null;
}) {
  return useQuery({
    queryKey: backupKeys.preview(input.backupId ?? -1, input.mode ?? "-"),
    queryFn: () =>
      previewRestoreApi({
        backupId: input.backupId!,
        mode: input.mode!,
      }),
    enabled: input.backupId !== null && input.mode !== null,
    retry: false,
  });
}

export function useRestore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: restoreApi,
    onSuccess: () => void qc.invalidateQueries({ queryKey: backupKeys.all }),
  });
}

export function useRestoreJob(id: number | null) {
  return useQuery({
    queryKey: backupKeys.restoreJob(id ?? -1),
    queryFn: () => getRestoreJobApi(id!),
    enabled: id !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return ["pending", "validating", "running", "verifying"].includes(status ?? "")
        ? 2_000
        : false;
    },
  });
}
