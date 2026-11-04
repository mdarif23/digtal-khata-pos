import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearCredentials,
  dataDir,
  loadConfig,
  loadCredentials,
  saveConfig,
  saveCredentials,
  validatePairingCode,
  redactSecret,
} from "../src/config/config.js";

describe("config + credentials store", () => {
  let original: string | undefined;
  let sandbox: string;

  before(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ezpos-bridge-"));
    original = process.env.EZPOS_BRIDGE_DATA_DIR;
    process.env.EZPOS_BRIDGE_DATA_DIR = sandbox;
  });

  after(() => {
    if (original === undefined) delete process.env.EZPOS_BRIDGE_DATA_DIR;
    else process.env.EZPOS_BRIDGE_DATA_DIR = original;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("saves and loads a valid config round-trip", () => {
    saveConfig({
      backendUrl: "https://api.example.com",
      pollIntervalMs: 1500,
      printers: [
        { name: "Counter", kind: "rawTcp", host: "192.168.1.50", port: 9100, pin: 2 },
        { name: "USB", kind: "spooler", printerName: "POS-80", pin: 5 },
      ],
    });
    const loaded = loadConfig();
    assert.equal(loaded.backendUrl, "https://api.example.com");
    assert.equal(loaded.printers.length, 2);
    assert.equal(dataDir(), sandbox);
  });

  it("rejects rawTcp printers without a host", () => {
    assert.throws(() =>
      saveConfig({
        backendUrl: "https://api.example.com",
        printers: [{ name: "Broken", kind: "rawTcp" } as never],
      }),
    );
  });

  it("rejects spooler printers without a printerName", () => {
    assert.throws(() =>
      saveConfig({
        backendUrl: "https://api.example.com",
        printers: [{ name: "Broken", kind: "spooler" } as never],
      }),
    );
  });

  it("rejects an invalid backend URL", () => {
    assert.throws(() =>
      saveConfig({ backendUrl: "not-a-url", printers: [] } as never),
    );
  });

  it("stores and redacts credentials", () => {
    saveCredentials({
      terminalId: 7,
      secret: "ezpos_tb_0123456789abcdef0123456789abcdef0123456789abcdef",
      terminalName: "Front Counter",
      locationId: 3,
      pairedAt: new Date().toISOString(),
    });
    const creds = loadCredentials();
    assert.ok(creds);
    assert.equal(creds.terminalId, 7);
    const redacted = redactSecret(creds.secret);
    assert.ok(redacted.startsWith("ezpos_tb_"));
    assert.ok(!redacted.includes("0123456789abcdef0123456789abcdef0123456789"));
  });

  it("returns null for missing credentials", () => {
    clearCredentials();
    assert.equal(loadCredentials(), null);
  });

  it("validates pairing-code shape (unambiguous alphabet, 8 chars)", () => {
    assert.equal(validatePairingCode(" abcd2345 "), "ABCD2345");
    assert.throws(() => validatePairingCode("ABCD234"));
    assert.throws(() => validatePairingCode("AB1D2345")); // no 1/I/L/O/0
    assert.throws(() => validatePairingCode("ABOD2345")); // no O/0
  });
});
