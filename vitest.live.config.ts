import { defineConfig } from "vitest/config";

// Live checks: the real `claude` on the developer's subscription. Never in CI.
export default defineConfig({
  test: {
    name: "live",
    environment: "node",
    include: ["packages/*/tests/live/**/*.live.ts"],
    fileParallelism: false,
    testTimeout: 10 * 60_000,
    hookTimeout: 60_000,
  },
});
