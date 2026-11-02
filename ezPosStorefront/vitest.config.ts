import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Allow unit-testing pure logic inside "server-only" modules.
      "server-only": path.resolve(__dirname, "./tests/server-only-stub.ts"),
    },
  },
});
