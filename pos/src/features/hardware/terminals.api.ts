import api from "../../api/axios.js";

/**
 * POS terminal (hardware bridge) API — mirrors the backend Phase 5
 * endpoints. Terminals are location-scoped; the backend resolves the
 * location from the active-location header, so no ids are sent here.
 */

export interface TerminalSummary {
  id: number;
  name: string;
  status: "active" | "inactive";
  paired: boolean;
  deviceInfo: Record<string, unknown> | null;
  lastSeenAt: string | null;
  pairedAt: string | null;
  createdAt: string | null;
}

export interface PairingCodeIssue {
  code: string;
  expiresAt: string;
}

export interface HardwareCommand {
  id: number;
  terminalId: number;
  type: string;
  status:
    | "pending"
    | "received"
    | "validated"
    | "executing"
    | "completed"
    | "failed"
    | "expired"
    | "unknown_outcome";
  requestedBy: number | null;
  saleId: number | null;
  reason: string | null;
  note: string | null;
  result: Record<string, unknown> | null;
  expiresAt: string;
  claimedAt: string | null;
  settledAt: string | null;
  createdAt: string | null;
}

export async function getTerminalsApi(): Promise<TerminalSummary[]> {
  const res = await api.get<{ success: boolean; data: TerminalSummary[] }>(
    "/terminals",
  );
  return res.data.data;
}

export async function patchTerminalApi(
  terminalId: number,
  input: { name?: string; status?: "active" | "inactive" },
): Promise<TerminalSummary> {
  const res = await api.patch<{ success: boolean; data: TerminalSummary }>(
    `/terminals/${terminalId}`,
    input,
  );
  return res.data.data;
}

export async function deleteTerminalApi(terminalId: number): Promise<void> {
  await api.delete(`/terminals/${terminalId}`);
}

export async function mintPairingCodeApi(): Promise<PairingCodeIssue> {
  const res = await api.post<{ success: boolean; data: PairingCodeIssue }>(
    "/terminals/pairing-code",
  );
  return res.data.data;
}

export async function rotateSecretApi(
  terminalId: number,
): Promise<{ terminalId: number; secret: string }> {
  const res = await api.post<{ success: boolean; data: { terminalId: number; secret: string } }>(
    `/terminals/${terminalId}/rotate-secret`,
  );
  return res.data.data;
}

export async function getTerminalCommandsApi(
  terminalId: number,
): Promise<HardwareCommand[]> {
  const res = await api.get<{ success: boolean; data: HardwareCommand[] }>(
    `/terminals/${terminalId}/commands`,
  );
  return res.data.data;
}

export async function createDrawerCommandApi(
  terminalId: number,
  saleId?: number,
): Promise<HardwareCommand> {
  const res = await api.post<{ success: boolean; data: HardwareCommand }>(
    "/hardware/commands",
    {
      terminalId,
      type: "drawer_open",
      ...(saleId !== undefined ? { saleId } : {}),
    },
  );
  return res.data.data;
}

export async function getCommandStatusApi(
  commandId: number,
): Promise<HardwareCommand> {
  const res = await api.get<{ success: boolean; data: HardwareCommand }>(
    `/hardware/commands/${commandId}`,
  );
  return res.data.data;
}
