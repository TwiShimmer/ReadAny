import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dist = new URL("../packages/app/dist/", import.meta.url);
const browser =
  process.env.READANY_PDF_SMOKE_BROWSER ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find((file) => existsSync(file)) ||
  "chromium";
const assets = await readdir(new URL("assets/", dist));
const pdfChunk = assets.find((name) => /^pdf-(?!worker-)[\w-]+\.js$/.test(name));
const configChunk = assets.find((name) => /^pdf-worker-(?!entry-)[\w-]+\.js$/.test(name));
const workerChunk = assets.find((name) => /^pdf-worker-entry-[\w-]+\.js$/.test(name));
assert.ok(
  pdfChunk && configChunk && workerChunk,
  "Run pnpm --filter app build before this smoke test",
);

function onePagePdf(text) {
  const content = `BT /F1 12 Tf 20 40 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = ["0000000000 65535 f \n"];
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(pdf.length).padStart(10, "0")} 00000 n \n`);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  return `${pdf}xref\n0 ${offsets.length}\n${offsets.join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

const expectedText = "ReadAny production fallback";
const page = `<!doctype html><meta charset="utf-8"><script type="module">
  const attempts = [];
  let result;
  try {
    const activeWorkers = new Set();
    let startedWorkers = 0;
    const openWorkerCounts = [];
    const closedWorkerCounts = [];
    class TrackedWorker extends Worker {
      constructor(...args) {
        super(...args);
        activeWorkers.add(this);
        startedWorkers += 1;
      }
      terminate() {
        super.terminate();
        activeWorkers.delete(this);
      }
    }
    globalThis.Worker = TrackedWorker;
    const { ensurePdfWorker, withPdfDocument } = await import(${JSON.stringify(`/assets/${configChunk}`)});
    const pdfModule = await import(${JSON.stringify(`/assets/${pdfChunk}`)});
    const { makePDF } = Object.values(pdfModule).find((value) => typeof value?.makePDF === "function");
    globalThis.__READANY_PDF_ASSET_BASE__ = new URL("/vendor/pdfjs/", location.href).href;
    ensurePdfWorker();
    const pdfSource = ${JSON.stringify(onePagePdf(expectedText))};
    for (let index = 0; index < 3; index += 1) {
      const book = await makePDF(new File([pdfSource], "sample.pdf"));
      try {
        openWorkerCounts.push(activeWorkers.size);
      } finally {
        await Promise.all([book.destroy(), book.destroy()]);
      }
      closedWorkerCounts.push(activeWorkers.size);
      try {
        const invalid = await makePDF(new File(["%PDF-1.7\\ninvalid"], "corrupt.pdf"));
        await invalid.destroy();
        throw new Error("Corrupt PDF unexpectedly opened");
      } catch (error) {
        if (error.name !== "InvalidPDFException") throw error;
      }
      closedWorkerCounts.push(activeWorkers.size);
    }

    globalThis.Worker = class {
      constructor(url) {
        attempts.push(String(url));
        throw new Error("Forced module worker startup failure");
      }
    };
    for (const proto of [Map.prototype, WeakMap.prototype]) {
      Reflect.deleteProperty(proto, "getOrInsert");
      Reflect.deleteProperty(proto, "getOrInsertComputed");
    }
    const data = new TextEncoder().encode(pdfSource);
    const text = await withPdfDocument({
      data, useWorkerFetch: false, useSystemFonts: false,
      standardFontDataUrl: new URL("/vendor/pdfjs/standard_fonts/", location.href).href,
    }, async (pdf) => {
      const page = await pdf.getPage(1);
      const { items } = await page.getTextContent();
      return items.map((item) => item.str ?? "").join("");
    });
    result = {
      text, attempts, startedWorkers, openWorkerCounts, closedWorkerCounts,
      patched: typeof Map.prototype.getOrInsertComputed === "function",
    };
  } catch (error) {
    result = { error: String(error), attempts };
  }
  await fetch("/result", { method: "POST", body: JSON.stringify(result) });
</script>`;

const { promise: result, resolve: report } = Promise.withResolvers();
let fallbackModuleRequested = false;
const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/result") {
      let json = "";
      for await (const chunk of request) json += chunk;
      report(JSON.parse(json));
      response.end();
    } else if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    } else if (/^\/(assets|vendor\/pdfjs\/standard_fonts)\/[\w.-]+$/.test(request.url ?? "")) {
      const path = request.url.slice(1);
      const data = await readFile(new URL(path, dist));
      if (path === `assets/${workerChunk}` && request.headers["sec-fetch-dest"] === "script") {
        fallbackModuleRequested = true;
      }
      response
        .writeHead(200, {
          "content-type": path.endsWith(".js") ? "text/javascript" : "application/octet-stream",
          "cache-control": "no-store",
        })
        .end(data);
    } else {
      response.writeHead(404).end();
    }
  } catch {
    response.writeHead(404).end();
  }
});

const profile = await mkdtemp(join(tmpdir(), "readany-pdf-smoke-"));
let child;
let timeout;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  child = spawn(browser, [
    "--headless",
    "--disable-gpu",
    "--disable-background-networking",
    "--no-first-run",
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${server.address().port}/`,
  ]);
  const browserExited = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Browser exited before reporting (${code})`)));
  });
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Timed out waiting for PDF fallback result")),
      30_000,
    );
  });
  const outcome = await Promise.race([result, browserExited, deadline]);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.startedWorkers, 6);
  assert.deepEqual(outcome.openWorkerCounts, [1, 1, 1]);
  assert.deepEqual(outcome.closedWorkerCounts, [0, 0, 0, 0, 0, 0]);
  assert.equal(outcome.attempts.length, 1);
  assert.ok(outcome.attempts[0].endsWith(`/${workerChunk}`));
  assert.ok(fallbackModuleRequested, "Expected PDF.js to import the production worker on fallback");
  assert.equal(outcome.text, expectedText);
  assert.equal(outcome.patched, true);
  console.log(`Production fallback (${workerChunk}) read page 1: ${outcome.text}`);
  console.log("Active workers returned to zero after 3 closes and 3 corrupt PDF retries.");
} finally {
  clearTimeout(timeout);
  server.closeAllConnections();
  server.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
