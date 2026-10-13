import { defineConfig } from "vitest/config";

const packages = [
  "plan-format",
  "core",
  "engine",
  "adapter-claude-code",
  "host",
  "cli",
  "app",
  "ui",
];

export default defineConfig({
  test: {
    projects: packages.map((name) => ({
      test: {
        name,
        environment: "node",
        include: [`packages/${name}/tests/**/*.test.ts`],
      },
    })),
  },
});
