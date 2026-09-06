import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // These are integration tests against a real Postgres instance —
    // see README "Running tests". Sequential to avoid unique-constraint
    // collisions between tests sharing one DB.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
