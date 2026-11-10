import { toast } from "@/components/ui/toast";

interface EntityToastProps<TData, TResult = unknown> {
  data: TData;
  apiCall: (data: TData) => Promise<TResult>;
  entityName: string;
  displayName?: string; // Make this optional since we might use the API message
  getSuccessMessage?: (response: TResult) => string; // NEW: Extract message from API
}

export async function createEntityPromiseToast<TData, TResult = unknown>(
  apiCallOrProps:
    | ((data: TData) => Promise<TResult>)
    | EntityToastProps<TData, TResult>,
  legacyOptions?: { success?: string; loading?: string },
) {
  // Two call conventions exist across the finance pages: the object form
  // ({data, apiCall, entityName, ...}) and a legacy positional form
  // (createEntityPromiseToast(() => api(...), { success, loading })).
  // Support both — a positional call used to crash with
  // "TypeError: apiCall is not a function".
  const isProps =
    typeof apiCallOrProps === "object" &&
    apiCallOrProps !== null &&
    "apiCall" in apiCallOrProps;
  const props = isProps
    ? (apiCallOrProps as EntityToastProps<TData, TResult>)
    : ({
        data: undefined as TData,
        apiCall: apiCallOrProps as (data: TData) => Promise<TResult>,
        entityName: legacyOptions?.success ?? "entity",
        displayName: legacyOptions?.success,
        getSuccessMessage: legacyOptions?.success
          ? () => legacyOptions.success!
          : undefined,
      } as EntityToastProps<TData, TResult>);
  const { data, apiCall, entityName, displayName, getSuccessMessage } = props;
  const loadingMessage = isProps
    ? `Processing ${entityName}...`
    : legacyOptions?.loading ?? `Processing ${entityName}...`;
  return await toast.promise(apiCall(data), {
    loading: loadingMessage,
    success: (response) => {
      // 1. If you provided a custom message extractor, use it!
      if (getSuccessMessage) {
        return getSuccessMessage(response);
      }
      // 2. Otherwise, fall back to the default displayName message
      return `${displayName || entityName} processed successfully!`;
    },
    error: (error) =>
      error?.response?.data?.message ??
      error?.message ??
      `Could not process ${entityName}`,
  });
}
