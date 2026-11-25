/**
 * Bundled pdf.js module worker.
 *
 * Vite emits this file as a worker asset (`?worker&url` in pdf-worker.ts) and
 * pdf.js creates one Worker per document from that URL. Static imports run in
 * source order, so the polyfills below are installed before pdf.worker.mjs
 * evaluates and calls `getOrInsertComputed`.
 */
import "./pdf-worker-polyfills";

// The export keeps pdf.js's fake-worker fallback working: if a real Worker
// cannot be constructed, pdf.js dynamically imports this same URL and looks
// for `WorkerMessageHandler`.
export { WorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.mjs";
