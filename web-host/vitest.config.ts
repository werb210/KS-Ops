import { defineConfig } from "vitest/config";

// The web host's own tests: no network, no database, no Azure (the registry and the blob store are faked).
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
