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
 * `?worker&url` returns the emitted worker asset URL. The adapter owns a
 * separate worker for each document from construction through teardown.
 */
import { configurePDFWorker, createPDFLoadingTask } from "foliate-js/pdf.js";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, getDocument } from "pdfjs-dist";
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

export async function withPdfDocument<T>(
  source: Parameters<typeof getDocument>[0],
  useDocument: (pdf: PDFDocumentProxy) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  ensurePdfWorker();
  const { task, destroy }: { task: PDFDocumentLoadingTask; destroy: () => Promise<void> } =
    await createPDFLoadingTask(source, signal);
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const abort = () => reject(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const reading = task.promise.then((doc) => {
      signal?.throwIfAborted();
      return useDocument(doc);
    });
    if (signal?.aborted) abort();
    return await (signal ? Promise.race([reading, aborted]) : reading);
  } finally {
    signal?.removeEventListener("abort", abort);
    await destroy();
  }
}
