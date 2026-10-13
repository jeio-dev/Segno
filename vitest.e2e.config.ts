import { defineConfig } from "vitest/config";

// S9: the built app, end to end. Run after `pnpm --filter @segno/app build`.
export default defineConfig({
  test: {
    name: "app-e2e",
    environment: "node",
    include: ["packages/app/tests/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
