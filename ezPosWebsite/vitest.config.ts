import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The `@` alias mirrors tsconfig paths — without it any test importing via
// "@/..." fails with "Cannot find package".
export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
