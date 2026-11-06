import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createDrawerCommandApi,
  deleteTerminalApi,
  getCommandStatusApi,
  getTerminalCommandsApi,
  getTerminalsApi,
  mintPairingCodeApi,
  patchTerminalApi,
  rotateSecretApi,
} from "../terminals.api";

/** Query-key factory — follows the expenses/online-orders convention. */
export const terminalKeys = {
  all: ["terminals"] as const,
  list: () => [...terminalKeys.all, "list"] as const,
  commands: (terminalId: number) =>
    [...terminalKeys.all, "commands", terminalId] as const,
};

/** Terminals at the active location. Re-fetched when dialogs open. */
export function useTerminals(enabled = true) {
  return useQuery({
    queryKey: terminalKeys.list(),
    queryFn: getTerminalsApi,
    enabled,
    // last_seen updates on every bridge call — keep the view fresh.
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
  });
}

export function useTerminalCommands(terminalId: number, enabled = true) {
  return useQuery({
    queryKey: terminalKeys.commands(terminalId),
    queryFn: () => getTerminalCommandsApi(terminalId),
    enabled,
  });
}

export function useUpdateTerminal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      terminalId: number;
      name?: string;
      status?: "active" | "inactive";
      locationId?: number;
    }) =>
      patchTerminalApi(input.terminalId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: terminalKeys.all }),
  });
}

export function useDeleteTerminal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteTerminalApi,
    onSuccess: () => void qc.invalidateQueries({ queryKey: terminalKeys.all }),
  });
}

export function useMintPairingCode() {
  return useMutation({ mutationFn: mintPairingCodeApi });
}

export function useRotateSecret() {
  return useMutation({ mutationFn: rotateSecretApi });
}

export function useCreateDrawerCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { terminalId: number; saleId?: number }) =>
      createDrawerCommandApi(input.terminalId, input.saleId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: terminalKeys.all }),
  });
}

export function useCommandStatus(commandId: number | null) {
  return useQuery({
    queryKey: [...terminalKeys.all, "command", commandId] as const,
    queryFn: () => getCommandStatusApi(commandId as number),
    enabled: commandId !== null,
    // Poll while the drawer command is in flight.
    refetchInterval: (query) =>
      query.state.data &&
      ["completed", "failed", "expired", "unknown_outcome"].includes(
        query.state.data.status,
      )
        ? false
        : 700,
    refetchIntervalInBackground: true,
  });
}
