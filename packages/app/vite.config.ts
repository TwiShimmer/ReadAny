import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig, normalizePath } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const pdfjsDist = path.resolve(__dirname, "../../node_modules/pdfjs-dist");
const pdfWorkerEntry = normalizePath(path.resolve(__dirname, "src/lib/pdf/pdf-worker-entry.ts"));

function preservePdfWorkerExports(): Plugin {
  let isPdfWorker = false;
  return {
    name: "readany:pdf-worker-exports",
    // Vite sets preserveEntrySignatures to false after spreading worker.rollupOptions.
    // Rollup's options hook runs after that and can preserve this entry's exports.
    options(options) {
      isPdfWorker = options.input === pdfWorkerEntry;
      if (isPdfWorker) return { ...options, preserveEntrySignatures: "exports-only" };
    },
    generateBundle(_options, bundle) {
      if (!isPdfWorker) return;
      const hasHandler = Object.values(bundle).some(
        (chunk) =>
          chunk.type === "chunk" && chunk.isEntry && chunk.exports.includes("WorkerMessageHandler"),
      );
      if (!hasHandler) this.error("The PDF worker bundle must export WorkerMessageHandler");
    },
  };
}

// The About dialog shows the Tauri framework version. @tauri-apps/api releases
// in lockstep but can differ by a patch, and its package.json is not importable
// (exports map), so read the version the app actually builds against from the
// lockfile. Empty string = the card renders without a version.
function readTauriVersion(): string {
  try {
    const lock = fs.readFileSync(path.resolve(__dirname, "src-tauri/Cargo.lock"), "utf-8");
    return lock.match(/^name = "tauri"\r?\nversion = "([^"]+)"/m)?.[1] ?? "";
  } catch {
    return "";
  }
}

// Same pattern for the TypeScript toolchain version: application source must
// not import a dev-only package's manifest for one field. Resolve through
// Node so hoisting cannot break the path.
function readTypeScriptVersion(): string {
  try {
    const require = createRequire(path.resolve(__dirname, "package.json"));
    return require("typescript/package.json").version ?? "";
  } catch {
    return "";
  }
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  define: {
    __TAURI_VERSION__: JSON.stringify(readTauriVersion()),
    __TS_VERSION__: JSON.stringify(readTypeScriptVersion()),
  },
  plugins: [react(), tailwindcss()],
  worker: {
    format: "es",
    plugins: () => [preservePdfWorkerExports()],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "pdfjs-dist/build/pdf.worker.mjs": path.join(pdfjsDist, "build/pdf.worker.mjs"),
      "pdfjs-dist": pdfjsDist,
      // Map @pdfjs/* to foliate-js vendored pdfjs (v4.7, compatible with foliate-js)
      "@pdfjs": path.resolve(__dirname, "../../foliate-js/vendor/pdfjs"),
    },
    dedupe: ["i18next", "react-i18next", "react", "react-dom"],
  },
  optimizeDeps: {
    // Exclude foliate-js pdf.js from pre-bundling so that @pdfjs alias works
    exclude: ["foliate-js/pdf.js"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
