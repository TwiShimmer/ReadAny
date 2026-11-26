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
const viewChunk = assets.find((name) => /^view-[\w-]+\.js$/.test(name));
assert.ok(
  pdfChunk && configChunk && workerChunk && viewChunk,
  "Run pnpm --filter app build before this smoke test",
);

function makePdf(pages) {
  const pageIds = pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, text] of pages.entries()) {
    const streamId = 5 + index * 2;
    const content = `BT /F1 12 Tf 20 40 Td (${text}) Tj ET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    );
  }
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
  const workerEvents = [];
  let result;
  try {
    const activeWorkers = new Map();
    let nextWorkerId = 0;
    const openWorkerCounts = [];
    const closedWorkerCounts = [];
    const pagesShown = [];
    let firstPageError;
    class TrackedWorker extends Worker {
      constructor(url, options) {
        super(url, options);
        const id = ++nextWorkerId;
        activeWorkers.set(this, id);
        workerEvents.push({ action: "construct", id, url: String(url), active: activeWorkers.size });
      }
      terminate() {
        super.terminate();
        const id = activeWorkers.get(this);
        activeWorkers.delete(this);
        workerEvents.push({ action: "terminate", id, active: activeWorkers.size });
      }
    }
    globalThis.Worker = TrackedWorker;
    const { ensurePdfWorker, withPdfDocument } = await import(${JSON.stringify(`/assets/${configChunk}`)});
    const pdfModule = await import(${JSON.stringify(`/assets/${pdfChunk}`)});
    const { makePDF } = pdfModule.makePDF ? pdfModule : Object.values(pdfModule).find((value) => typeof value?.makePDF === "function");
    const { View } = await import(${JSON.stringify(`/assets/${viewChunk}`)});
    globalThis.__READANY_PDF_ASSET_BASE__ = new URL("/vendor/pdfjs/", location.href).href;
    ensurePdfWorker();
    const pdfSource = ${JSON.stringify(makePdf([expectedText, "Second page"]))};
    const mountView = async (book) => {
      const view = new View();
      Object.assign(view.style, { display: "block", width: "600px", height: "400px" });
      document.body.append(view);
      await view.open(book);
      view.renderer.setAttribute("spread", "none");
      return view;
    };
    for (let index = 0; index < 3; index += 1) {
      const book = await makePDF(new File([pdfSource], "sample.pdf"));
      try {
        openWorkerCounts.push(activeWorkers.size);
        if (index === 0) {
          const view = await mountView(book);
          try {
            if (view.renderer.index !== -1) throw new Error("Layout triggered navigation before init");
            await view.init({});
            for (const navigate of [() => {}, () => view.next()]) {
              await navigate();
              const { doc } = view.renderer.getContents()[0];
              if (!doc.querySelector("#canvas canvas")) throw new Error("Page canvas is missing");
              pagesShown.push(view.renderer.index + 1);
            }
          } finally {
            view.close();
            view.remove();
          }

          const first = book.sections[0];
          const load = first.load;
          const failure = new Error("Injected first-page canvas failure");
          first.load = async () => ({ ...await load(), onZoom: async () => { throw failure; } });
          const restored = await mountView(book);
          try {
            await restored.init({ lastLocation: "epubcfi(/6/2)" });
          } catch (error) {
            if (error !== failure || restored.renderer.index !== -1) throw error;
            firstPageError = error.message;
          } finally {
            restored.close();
            restored.remove();
          }
        }
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
      text, attempts, workerEvents, openWorkerCounts, closedWorkerCounts, pagesShown, firstPageError,
      patched: typeof Map.prototype.getOrInsertComputed === "function",
    };
  } catch (error) {
    result = { error: String(error), attempts, workerEvents };
  }
  await fetch("/result", { method: "POST", body: JSON.stringify(result) });
</script>`;

const { promise: result, resolve: report } = Promise.withResolvers();
const workerFetchDestinations = [];
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
      if (path === `assets/${workerChunk}`) {
        workerFetchDestinations.push(request.headers["sec-fetch-dest"]);
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
  console.log(`Production dist chunks: ${pdfChunk}, ${configChunk}, ${workerChunk}, ${viewChunk}`);
  console.log(`Worker lifecycle: ${JSON.stringify(outcome.workerEvents)}`);
  console.log(`Worker fetch destinations: ${JSON.stringify(workerFetchDestinations)}`);
  assert.equal(outcome.error, undefined);
  const workerUrl = `/assets/${workerChunk}`;
  assert.deepEqual(
    outcome.workerEvents,
    Array.from({ length: 6 }, (_, index) => [
      { action: "construct", id: index + 1, url: workerUrl, active: 1 },
      { action: "terminate", id: index + 1, active: 0 },
    ]).flat(),
  );
  assert.deepEqual(outcome.openWorkerCounts, [1, 1, 1]);
  assert.deepEqual(outcome.closedWorkerCounts, [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(outcome.pagesShown, [1, 2]);
  assert.equal(outcome.firstPageError, "Injected first-page canvas failure");
  assert.deepEqual(outcome.attempts, [workerUrl]);
  assert.ok(workerFetchDestinations.includes("worker"));
  assert.ok(
    workerFetchDestinations.includes("script"),
    "Expected a production worker script import",
  );
  assert.equal(outcome.text, expectedText);
  assert.equal(outcome.patched, true);
  console.log(`First open displayed pages ${outcome.pagesShown.join(", ")}, in order.`);
  console.log(`Restoring page 1 propagated the canvas failure: ${outcome.firstPageError}`);
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
