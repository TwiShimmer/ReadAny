// PDF.js 4 and 5 pass the document URL to fetch (HTTP/S) or XHR (e.g. Tauri
// asset:). Give each load its own internal URL, so closing one load cannot
// affect another load of the same PDF. The fragment never reaches the server.
const requests = new Map();
let nextRequestId = 0;
let fetchInstalled = false;
let xhrInstalled = false;

function linkSignals(owner, reader) {
  if (!reader) return owner;
  if (AbortSignal.any) return AbortSignal.any([owner, reader]);

  // Keep older WebViews working without losing PDF.js's own per-reader abort.
  const controller = new AbortController();
  for (const signal of [owner, reader]) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
      signal: controller.signal,
    });
  }
  return controller.signal;
}

function installFetch() {
  if (fetchInstalled) return;
  const fetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const request = requests.get(input instanceof URL ? input.href : input);
    if (!request) return fetch.call(this, input, init);
    return fetch.call(this, request.url, {
      ...init,
      signal: linkSignals(request.signal, init?.signal),
    });
  };
  fetchInstalled = true;
}

function installXHR() {
  if (xhrInstalled) return;
  const { open } = XMLHttpRequest.prototype;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    const request = requests.get(url instanceof URL ? url.href : url);
    if (!request) return open.call(this, method, url, ...args);
    request.signal.throwIfAborted();
    open.call(this, method, request.url, ...args);

    const abort = () => this.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    this.addEventListener("loadend", () => request.signal.removeEventListener("abort", abort), {
      once: true,
      signal: request.signal,
    });
  };
  xhrInstalled = true;
}

export function ownPDFURL(source) {
  const url = new URL(source, globalThis.location?.href);
  if (url.protocol === "http:" || url.protocol === "https:") installFetch();
  else installXHR();

  const scoped = new URL(url);
  scoped.hash = `readany-pdf-${++nextRequestId}`;
  const key = scoped.href;
  const controller = new AbortController();
  requests.set(key, { url, signal: controller.signal });
  return {
    url: scoped,
    close() {
      try {
        controller.abort();
      } finally {
        requests.delete(key);
      }
    },
  };
}
