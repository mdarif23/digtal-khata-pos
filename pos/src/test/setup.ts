import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./msw/server.js";

// MSW is available to every test; unhandled requests are bypassed so tests
// that stub axios directly remain unaffected. Suites opt in via server.use.
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Node ≥22.4 declares a global `localStorage` *property* even when web storage
// is disabled (no --localstorage-file flag). That pre-existing global blocks
// vitest from populating jsdom's Storage onto the test globals, so bare
// `localStorage` resolves to undefined and every test that persists state
// (terminal binding, language preference) crashes. Install an in-memory
// Storage only in that case — on environments where jsdom's storage populates
// normally this branch never runs.
if (typeof globalThis.localStorage === "undefined") {
  const createMemoryStorage = (): Storage => {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key: string): string | null =>
        map.has(key) ? (map.get(key) as string) : null,
      key: (index: number): string | null =>
        Array.from(map.keys())[index] ?? null,
      removeItem: (key: string): void => {
        map.delete(key);
      },
      setItem: (key: string, value: string): void => {
        map.set(key, String(value));
      },
    } as unknown as Storage;
  };
  const memoryStorage = createMemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
  if (typeof window !== "undefined" && typeof window.localStorage === "undefined") {
    Object.defineProperty(window, "localStorage", {
      value: memoryStorage,
      configurable: true,
    });
  }
}

// R3-004: checkout tests leave a cartPersistence debounce alive past
// teardown; its `indexedDB.open(...)` used to reject with
// "indexedDB is not defined" as an unhandled rejection after the run.
// Provide a benign never-completing stub when jsdom has no IndexedDB —
// pending writes simply never fire (tests that need real IndexedDB
// behavior already inject their own fake).
if (typeof globalThis.indexedDB === "undefined") {
  const stubRequest = {
    onupgradeneeded: null,
    onsuccess: null,
    onerror: null,
    result: null,
    error: null,
    readyState: "done",
    transaction: null,
  };
  const stubFactory = {
    open: () => stubRequest,
    cmp: () => 0,
    deleteDatabase: () => stubRequest,
    databases: () => Promise.resolve([]),
  };
  Object.defineProperty(globalThis, "indexedDB", {
    value: stubFactory,
    configurable: true,
    writable: true,
  });
  if (typeof window !== "undefined" && typeof window.indexedDB === "undefined") {
    Object.defineProperty(window, "indexedDB", {
      value: stubFactory,
      configurable: true,
    });
  }
}

