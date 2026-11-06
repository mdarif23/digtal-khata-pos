import { beforeEach, describe, expect, it } from "vitest";
import {
  bindTerminalScope,
  currentTerminalId,
  persistTerminalBinding,
  readPersistedTerminalId,
} from "./terminalBinding.js";

describe("terminalBinding (multi-terminal Phase 1)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts unbound", () => {
    bindTerminalScope(1, 10);
    expect(currentTerminalId()).toBeNull();
  });

  it("persists and restores a binding for the matching user+business scope", () => {
    persistTerminalBinding(1, 10, 42);
    expect(readPersistedTerminalId(1, 10)).toBe(42);

    bindTerminalScope(1, 10);
    expect(currentTerminalId()).toBe(42);
  });

  it("never leaks a binding across users or businesses", () => {
    persistTerminalBinding(1, 10, 42);
    expect(readPersistedTerminalId(2, 10)).toBeNull();
    expect(readPersistedTerminalId(1, 11)).toBeNull();

    bindTerminalScope(2, 10);
    expect(currentTerminalId()).toBeNull();
  });

  it("clears the binding with null and removes the stored key", () => {
    persistTerminalBinding(1, 10, 42);
    persistTerminalBinding(1, 10, null);
    expect(readPersistedTerminalId(1, 10)).toBeNull();
    expect(localStorage.getItem("ezpos-terminal")).toBeNull();
  });
});
