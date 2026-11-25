/**
 * Configures pdf.js to use the app-bundled worker instead of the CDN worker
 * previously hardcoded in foliate-js/pdf.js.
 *
 * Why a bundled worker:
 *  - the CDN worker cannot be patched for old WebView2 builds (this is the
 *    `getOrInsertComputed is not a function` regression);
 *  - it works offline in the Tauri app;
 *  - our worker entry installs the runtime polyfills inside the worker realm
 *    before pdf.worker.mjs is evaluated.
 *
 * `?worker&url` returns the emitted worker asset URL. pdf.js then creates one
 * Worker per document from `workerSrc` (rather than sharing a single
 * `workerPort`, which pdf.js destroys together with the first document).
 */
import { GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "./pdf-worker-entry.ts?worker&url";

let configured = false;

export function ensurePdfWorker(): void {
  if (configured) return;
  configured = true;
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}
