import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

const here = import.meta.dirname;

/** The built window loads only its own files; the dev server needs HMR. */
const contentSecurityPolicy: Plugin = {
  name: "segno-csp",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: {
        "http-equiv": "Content-Security-Policy",
        content:
          "default-src 'self'; font-src 'self' data:; img-src 'self' data:",
      },
      injectTo: "head-prepend",
    },
  ],
};

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(here, "src/main/index.ts"),
          host: resolve(here, "src/host/index.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(here, "src/preload/index.ts") },
        // Sandboxed preloads must be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(here, "../ui"),
    plugins: [react(), contentSecurityPolicy],
    // The design tokens live in docs/ and are imported, not copied.
    server: { fs: { allow: [resolve(here, "../..")] } },
    build: {
      outDir: resolve(here, "out/renderer"),
      rollupOptions: { input: resolve(here, "../ui/index.html") },
    },
  },
});
