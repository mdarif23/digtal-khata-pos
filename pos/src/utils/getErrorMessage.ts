export function getErrorMessage(err: unknown): string {
  // Prefer the backend's own validation/state message (e.g. "This business
  // has no locations yet…") over axios's generic "Request failed with
  // status code 4xx" text — the backend message tells the user what to do.
  const backendMessage =
    (err as { response?: { data?: { message?: string } } })?.response?.data
      ?.message;
  if (backendMessage) return backendMessage;
  return err instanceof Error ? err.message : String(err);
}
