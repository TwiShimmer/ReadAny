/**
 * Bundled pdf.js module worker.
 *
 * Vite emits this file as a worker asset (`?worker&url` in pdf-worker.ts) and
 * pdf.js creates one Worker per document from that URL. Static imports run in
 * source order, so the polyfills below are installed before pdf.worker.mjs
 * evaluates and calls `getOrInsertComputed`.
 */
import "./pdf-worker-polyfills";
export { WorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.mjs";
