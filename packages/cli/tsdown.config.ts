import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  dts: false,
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: ["yaml", "zod"],
  },
});
