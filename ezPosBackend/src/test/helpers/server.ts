import type { AddressInfo } from "node:net";
import { buildApp } from "../../app.js";

/**
 * Boots the real app on an ephemeral port — the same pattern every
 * integration suite uses, extracted so suites stop hand-rolling it.
 */
export function startTestServer(): {
  baseUrl: string;
  close: () => Promise<void>;
} {
  const app = buildApp();
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
