/**
 * pdf.js ships the worker without type declarations. The app imports it only
 * from the bundled worker entry, which re-exports WorkerMessageHandler.
 */
declare module "pdfjs-dist/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
