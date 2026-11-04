import type { BridgeCommand, TerminalCredentials } from "../types.js";
import type { AckStatus } from "../types.js";

/**
 * Authenticated ezPos backend client for the bridge (outbound HTTPS/HTTP).
 * Every call carries the terminal identity; 401/403 surface as typed
 * errors so the command loop can stop instead of spinning.
 */

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export interface PairResponse {
  terminalId: number;
  terminalName: string;
  locationId: number;
  secret: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

async function request<T>(
  baseUrl: string,
  method: string,
  path: string,
  auth: { terminalId?: number; secret?: string } | null,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth?.terminalId !== undefined && auth?.secret
          ? {
              Authorization: `Bearer ${auth.secret}`,
              "X-Terminal-Id": String(auth.terminalId),
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new NetworkError(
      `Cannot reach the backend: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  type ApiEnvelope = { success?: boolean; message?: string; data?: T };
  let payload: ApiEnvelope | null = null;
  try {
    payload = text === "" ? null : ((JSON.parse(text) as ApiEnvelope) satisfies ApiEnvelope | null);
  } catch {
    payload = null;
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(
      payload?.message ?? "The backend rejected this terminal's credentials.",
    );
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.message ?? `Request failed with status ${response.status}.`,
    );
  }
  if (payload === null || payload.success !== true) {
    throw new ApiError(response.status, "The backend returned an unexpected response.");
  }
  return payload.data as T;
}

export async function pairTerminal(
  baseUrl: string,
  code: string,
  deviceName: string,
  deviceInfo: Record<string, unknown>,
): Promise<PairResponse> {
  return request<PairResponse>(baseUrl, "POST", "/api/bridge/pair", null, {
    code,
    deviceName,
    deviceInfo,
  });
}

export async function terminalSelf(
  baseUrl: string,
  credentials: TerminalCredentials,
): Promise<{ terminalId: number; name: string; locationId: number }> {
  return request(
    baseUrl,
    "GET",
    "/api/bridge/terminal",
    { terminalId: credentials.terminalId, secret: credentials.secret },
  );
}

export async function claimCommands(
  baseUrl: string,
  credentials: TerminalCredentials,
): Promise<BridgeCommand[]> {
  return request<BridgeCommand[]>(
    baseUrl,
    "POST",
    "/api/bridge/commands/claim",
    { terminalId: credentials.terminalId, secret: credentials.secret },
  );
}

export async function ackCommand(
  baseUrl: string,
  credentials: TerminalCredentials,
  commandId: number,
  status: AckStatus,
  detail?: Record<string, unknown>,
): Promise<BridgeCommand> {
  return request<BridgeCommand>(
    baseUrl,
    "POST",
    `/api/bridge/commands/${commandId}/ack`,
    { terminalId: credentials.terminalId, secret: credentials.secret },
    { status, ...(detail !== undefined ? { detail } : {}) },
  );
}
