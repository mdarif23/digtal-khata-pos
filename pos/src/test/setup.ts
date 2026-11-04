import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./msw/server.js";

// MSW is available to every test; unhandled requests are bypassed so tests
// that stub axios directly remain unaffected. Suites opt in via server.use.
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
