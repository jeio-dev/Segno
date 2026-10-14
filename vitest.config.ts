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
        // Whole Task flows run real git; under a full parallel run they can
        // take longer than the 1 s default.
        expect: { poll: { timeout: 10_000 } },
        include: [`packages/${name}/tests/**/*.test.ts`],
      },
    })),
  },
});
