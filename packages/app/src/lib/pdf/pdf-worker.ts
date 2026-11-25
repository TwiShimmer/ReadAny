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
import { configurePDFWorker } from "foliate-js/pdf.js";
import pdfWorkerUrl from "./pdf-worker-entry.ts?worker&url";

let configured = false;

export function ensurePdfWorker(): void {
  if (configured) return;
  try {
    // `configurePDFWorker` also deletes any stale main-thread fake worker so
    // this real worker cannot be shadowed.
    configurePDFWorker({ workerSrc: pdfWorkerUrl });
    configured = true;
  } catch (error) {
    // Leave `configured` false so the next PDF open retries instead of
    // permanently falling back to the CDN/workerSrc-less path.
    console.error("[pdf-worker] Failed to configure the bundled PDF worker:", error);
    throw error;
  }
}
