import { defineConfig } from "vitest/config";

// Unit tests: no database, no network. Integration tests (tests/integration) need Postgres and run with
// `npm run test:integration`.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["tests/setupEnv.ts"],
  },
});
