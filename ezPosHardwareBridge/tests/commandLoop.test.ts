import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import * as http from "node:http";
import * as net from "node:net";
import { executeCommand, runOnce, runLoop } from "../src/services/commandLoop.js";
import { AuthError } from "../src/services/bridgeClient.js";
import { RawTcpAdapter } from "../src/adapters/rawTcpAdapter.js";
import type {
  BridgeConfig,
  DrawerAdapter,
  DrawerKickResult,
  PrinterConfig,
  TerminalCredentials,
} from "../src/types.js";
import { DrawerKickError } from "../src/types.js";

/**
 * Command-loop integration tests against a mock ezPos backend that mimics
 * the bridge endpoints (claim / ack). Hardware adapters are replaced with
 * scripted mocks — physical hardware is verified separately on a real
 * machine (see README). The one REAL-hardware-behavior test uses an
 * actual refused TCP connection to prove the failed-vs-unknown split.
 */

interface MockState {
  pending: { id: number; type: string }[];
  acks: { commandId: number; status: string; detail?: Record<string, unknown> }[];
  nextId: number;
  authMode: "ok" | "reject";
}

function startMockBackend(): Promise<{ url: string; state: MockState; close: () => Promise<void> }> {
  const state: MockState = { pending: [], acks: [], nextId: 100, authMode: "ok" };
  const server = http.createServer((request, response) => {
    const auth = request.headers.authorization ?? "";
    if (state.authMode !== "ok" || auth !== "Bearer test-secret") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, message: "Bad terminal credentials." }));
      return;
    }
    const body: unknown[] = [];
    request.on("data", (chunk) => body.push(chunk));
    request.on("end", () => {
      const payload =
        body.length > 0 ? (JSON.parse(body.join("") as string) as Record<string, unknown>) : {};
      if (request.url === "/api/bridge/commands/claim" && request.method === "POST") {
        const delivered = state.pending;
        state.pending = [];
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            success: true,
            data: delivered.map((command) => ({
              ...command,
              status: "received",
              terminalId: 1,
              saleId: null,
              reason: null,
            })),
          }),
        );
        return;
      }
      const ackMatch = request.url?.match(/^\/api\/bridge\/commands\/(\d+)\/ack$/);
      if (ackMatch && request.method === "POST") {
        const status = String(payload.status);
        state.acks.push({
          commandId: Number(ackMatch[1]),
          status,
          detail: payload.detail as Record<string, unknown> | undefined,
        });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: true, data: { id: Number(ackMatch[1]), status } }));
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, message: "not found" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        state,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

const credentials: TerminalCredentials = {
  terminalId: 1,
  secret: "test-secret",
  terminalName: "Mock Terminal",
  locationId: 1,
  pairedAt: new Date().toISOString(),
};

/** Scripted adapter for behavior tests. */
function makeAdapter(script: () => Promise<DrawerKickResult>): (printer: PrinterConfig) => DrawerAdapter {
  return () => ({
    printer: { name: "scripted", kind: "rawTcp", host: "scripted" },
    kick: script,
    dispose: () => undefined,
  });
}

describe("command loop", () => {
  let backend: Awaited<ReturnType<typeof startMockBackend>>;

  before(async () => {
    backend = await startMockBackend();
  });

  after(async () => {
    await backend.close();
  });

  function config(): BridgeConfig {
    return {
      backendUrl: backend.url,
      pollIntervalMs: 10,
      printers: [{ name: "scripted", kind: "rawTcp", host: "scripted" }],
    };
  }

  function issueCommand(type = "drawer_open"): number {
    const id = backend.state.nextId++;
    backend.state.pending.push({ id, type });
    return id;
  }

  function acksFor(commandId: number): string[] {
    return backend.state.acks
      .filter((ack) => ack.commandId === commandId)
      .map((ack) => ack.status);
  }

  it("runs the full lifecycle: claim → validated → executing → completed", async () => {
    const commandId = issueCommand();
    await runOnce(config(), credentials, {}, makeAdapter(async () => ({
      sent: true,
      detail: { adapter: "scripted", note: "kick delivered" },
    })));
    assert.deepEqual(acksFor(commandId), ["validated", "executing", "completed"]);
  });

  it("acks failed for unsupported command types without executing", async () => {
    const commandId = issueCommand("time_travel");
    await runOnce(config(), credentials, {}, makeAdapter(async () => {
      throw new Error("adapter must never run");
    }));
    assert.deepEqual(acksFor(commandId), ["failed"]);
  });

  it("acks failed when nothing left the machine (safe to retry)", async () => {
    const commandId = issueCommand();
    await runOnce(config(), credentials, {}, makeAdapter(async () => {
      throw new DrawerKickError("printer unreachable", false);
    }));
    assert.deepEqual(acksFor(commandId), ["validated", "executing", "failed"]);
  });

  it("acks unknown_outcome when bytes may have reached the printer", async () => {
    const commandId = issueCommand();
    await runOnce(config(), credentials, {}, makeAdapter(async () => {
      throw new DrawerKickError("socket died mid-write", true);
    }));
    assert.deepEqual(acksFor(commandId), ["validated", "executing", "unknown_outcome"]);
  });

  it("a refused raw TCP connection is failed (nothing sent), never unknown", async () => {
    const commandId = issueCommand();
    // Port 1 on loopback is refused — a real pre-send failure through the
    // actual rawTcp adapter (no mocks).
    await runOnce(config(), credentials, {}, () =>
      new RawTcpAdapter({ name: "refused", kind: "rawTcp", host: "127.0.0.1", port: 1 }, { connectMs: 500, ioMs: 500 }),
    );
    assert.deepEqual(acksFor(commandId), ["validated", "executing", "failed"]);
  });

  it("claiming returns each command exactly once", async () => {
    const commandId = issueCommand();
    await runOnce(config(), credentials, {}, makeAdapter(async () => ({ sent: true, detail: {} })));
    const second = await runOnce(config(), credentials, {}, makeAdapter(async () => ({ sent: true, detail: {} })));
    assert.equal(second, 0);
    assert.ok(backend.state.acks.some((ack) => ack.commandId === commandId));
  });

  it("converts backend 401s into AuthError so the loop can stop", async () => {
    backend.state.authMode = "reject";
    try {
      await assert.rejects(
        () => runOnce(config(), credentials),
        (error: unknown) => error instanceof AuthError,
      );
    } finally {
      backend.state.authMode = "ok";
    }
  });

  it("runLoop stops cleanly on the stop predicate", async () => {
    let cycles = 0;
    await runLoop(config(), credentials, {
      maxBackoffMs: 20,
      sleep: async () => {
        cycles += 1;
      },
      shouldStop: () => cycles >= 1,
    });
    assert.ok(cycles >= 1);
  });

  it("executeCommand surfaces the honest no-open-sensor caveat in the detail", async () => {
    const commandId = issueCommand();
    await executeCommand(
      config(),
      credentials,
      { id: commandId, terminalId: 1, type: "drawer_open", status: "received", saleId: null, reason: null },
      {},
      makeAdapter(async () => ({
        sent: true,
        detail: { adapter: "scripted", note: "no open-sensor feedback" },
      })),
    );
    const ack = backend.state.acks.find((entry) => entry.commandId === commandId && entry.status === "completed");
    assert.ok(ack);
    assert.equal(ack.detail?.note, "no open-sensor feedback");
  });
});
