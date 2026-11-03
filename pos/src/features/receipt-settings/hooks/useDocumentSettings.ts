import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { useSessionStore } from "@/auth/sessionStore.js";
import {
  getBusinessProfileApi,
  getDocumentSettingsApi,
  removeBusinessLogoApi,
  updateBusinessProfileApi,
  updateDocumentSettingsApi,
  uploadBusinessLogoApi,
  type BusinessProfileDto,
  type DocumentSettingsBundleDto,
  type UpdateBusinessProfileInput,
} from "../api/receiptSettings.api.js";
import type { DocumentType } from "../schemas/documentSettings.schema.js";

/** Query-key factory — same convention as procurement/due-management. */
export const documentSettingsKeys = {
  all: ["document-settings"] as const,
  settings: () => [...documentSettingsKeys.all, "settings"] as const,
  business: (businessId: number | null) =>
    [...documentSettingsKeys.all, "business", businessId] as const,
};

export function useDocumentSettings() {
  return useQuery({
    queryKey: documentSettingsKeys.settings(),
    queryFn: getDocumentSettingsApi,
    staleTime: 30_000,
  });
}

export function useBusinessProfile() {
  const businessId = useSessionStore((s) => s.businessId);
  return useQuery({
    queryKey: documentSettingsKeys.business(businessId),
    queryFn: () => getBusinessProfileApi(businessId as number),
    enabled: businessId !== null,
    staleTime: 30_000,
  });
}

function useInvalidateDocumentSettings() {
  const queryClient = useQueryClient();
  const businessId = useSessionStore((s) => s.businessId);
  return () => {
    void queryClient.invalidateQueries({ queryKey: documentSettingsKeys.settings() });
    void queryClient.invalidateQueries({
      queryKey: documentSettingsKeys.business(businessId),
    });
  };
}

export function useUpdateDocumentSettings() {
  const invalidate = useInvalidateDocumentSettings();
  return useMutation({
    mutationFn: ({ docType, config }: { docType: DocumentType; config: unknown }) =>
      updateDocumentSettingsApi(docType, config),
    onSuccess: () => {
      invalidate();
    },
    onError: (err) => {
      toast.add({
        title:
          // axios error shape from the configured instance
          (
            err as { response?: { data?: { message?: string } } }
          ).response?.data?.message ?? "Could not save document settings.",
        type: "error",
      });
    },
  });
}

export function useUpdateBusinessProfile() {
  const invalidate = useInvalidateDocumentSettings();
  return useMutation({
    mutationFn: (input: UpdateBusinessProfileInput) => {
      const businessId = useSessionStore.getState().businessId;
      if (businessId === null) {
        return Promise.reject(new Error("No active business."));
      }
      return updateBusinessProfileApi(businessId, input);
    },
    onSuccess: () => {
      invalidate();
      toast.add({ title: "Business information saved.", type: "success" });
    },
    onError: (err) => {
      toast.add({
        title:
          (err as { response?: { data?: { message?: string } } }).response?.data
            ?.message ?? "Could not save business information.",
        type: "error",
      });
    },
  });
}

export function useUploadBusinessLogo() {
  const invalidate = useInvalidateDocumentSettings();
  return useMutation({
    mutationFn: (dataUrl: string) => {
      const businessId = useSessionStore.getState().businessId;
      if (businessId === null) {
        return Promise.reject(new Error("No active business."));
      }
      return uploadBusinessLogoApi(businessId, dataUrl);
    },
    onSuccess: () => {
      invalidate();
      toast.add({ title: "Logo saved.", type: "success" });
    },
    onError: (err) => {
      toast.add({
        title:
          (err as { response?: { data?: { message?: string } } }).response?.data
            ?.message ?? "Could not upload the logo.",
        type: "error",
      });
    },
  });
}

export function useRemoveBusinessLogo() {
  const invalidate = useInvalidateDocumentSettings();
  return useMutation({
    mutationFn: () => {
      const businessId = useSessionStore.getState().businessId;
      if (businessId === null) {
        return Promise.reject(new Error("No active business."));
      }
      return removeBusinessLogoApi(businessId);
    },
    onSuccess: () => {
      invalidate();
      toast.add({ title: "Logo removed.", type: "success" });
    },
    onError: () => {
      toast.add({ title: "Could not remove the logo.", type: "error" });
    },
  });
}

export type { BusinessProfileDto, DocumentSettingsBundleDto };
