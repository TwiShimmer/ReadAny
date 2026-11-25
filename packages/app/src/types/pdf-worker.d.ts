// Side-effect only import: the worker entry loads pdf.worker.mjs to install
// pdf.js's worker-side message handler. No exports are consumed by the app.
declare module "pdfjs-dist/build/pdf.worker.mjs";
