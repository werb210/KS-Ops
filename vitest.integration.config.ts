import { defineConfig } from "vitest/config";

// Integration tests against a real Postgres (DATABASE_URL). Files run one at a time because they share the database.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/setupEnv.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
