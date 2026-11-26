import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentAttempt } from "../reader/document-attempt";

const getDocument = vi.fn();
const workerOptions = { workerSrc: "" };
const foliateRequire = createRequire(new URL("../../../foliate-js/pdf.js", import.meta.url));

const file = new File(["%PDF-1.7"], "sample.pdf");

const activeWorkers = new Set<EventTarget>();
const destroyWorker = vi.fn();

class TrackedWorker extends EventTarget {
  static created = vi.fn();

  constructor() {
    super();
    activeWorkers.add(this);
    TrackedWorker.created(this);
  }

  terminate() {
    activeWorkers.delete(this);
  }
}

function createTask(promise: Promise<unknown>) {
  void promise.catch(() => {});
  const task = { promise, destroy: vi.fn(async () => {}) };
  getDocument.mockReturnValueOnce(task);
  return task;
}

function createPdf() {
  return {
    numPages: 1,
    getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }) }),
    getMetadata: async () => ({}),
    getOutline: async () => null,
  };
}

describe("Foliate PDF document lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock(foliateRequire.resolve("pdfjs-dist"), () => ({
      version: "4.0.0",
      getDocument,
      GlobalWorkerOptions: workerOptions,
      TextLayer: { cleanup: vi.fn() },
      PDFWorker: class {
        destroy = destroyWorker;
      },
    }));
    getDocument.mockReset();
    destroyWorker.mockReset();
    TrackedWorker.created.mockReset();
    activeWorkers.clear();
    workerOptions.workerSrc = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("releases each loading task exactly once when its book is closed", async () => {
    const { makePDF } = await import("../../../foliate-js/pdf.js");
    for (let i = 0; i < 3; i++) {
      const task = createTask(Promise.resolve(createPdf()));
      const book = await makePDF(file);
      expect(task.destroy).not.toHaveBeenCalled();
      await Promise.all([book.destroy(), book.destroy()]);
      expect(task.destroy).toHaveBeenCalledTimes(1);
    }
    expect(getDocument).toHaveBeenCalledTimes(3);
  });

  it("releases loading tasks after a corrupt PDF or book initialization failure", async () => {
    const { makePDF } = await import("../../../foliate-js/pdf.js");
    const failure = new Error("PDF unavailable");
    const corrupt = createTask(
      Promise.resolve().then(() => {
        throw failure;
      }),
    );
    await expect(makePDF(file)).rejects.toBe(failure);
    expect(corrupt.destroy).toHaveBeenCalledTimes(1);

    const pdf = { ...createPdf(), getMetadata: vi.fn().mockRejectedValue(failure) };
    const incomplete = createTask(Promise.resolve(pdf));
    await expect(makePDF(file)).rejects.toBe(failure);
    expect(incomplete.destroy).toHaveBeenCalledTimes(1);
  });

  it("returns to the worker baseline after repeated corrupt PDF retries", async () => {
    const { makePDF } = await import("../../../foliate-js/pdf.js");
    const workers = new Set<object>();
    const failure = new Error("Corrupt PDF");
    getDocument.mockImplementation(() => {
      const worker = {};
      workers.add(worker);
      return {
        promise: Promise.reject(failure),
        destroy: async () => {
          expect(workers.delete(worker)).toBe(true);
        },
      };
    });

    for (let i = 0; i < 3; i++) {
      await expect(makePDF(file)).rejects.toBe(failure);
      expect(workers.size).toBe(0);
    }
    expect(getDocument).toHaveBeenCalledTimes(3);
  });

  it("shares an in-flight URL between callers and revokes it after the final release", async () => {
    const { makePDF } = await import("../../../foliate-js/pdf.js");
    const pdf = createPdf();
    const page = await pdf.getPage();
    let complete!: (value: typeof page) => void;
    const pending = new Promise<typeof page>((resolve) => {
      complete = resolve;
    });
    const getPage = vi.fn().mockResolvedValueOnce(page).mockReturnValue(pending);
    const task = createTask(Promise.resolve({ ...pdf, getPage }));
    const source = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const book = await makePDF(file);

    const left = book.sections[0].load();
    const right = book.sections[0].load();
    complete(page);
    const [first, second] = await Promise.all([left, right]);
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(source).toHaveBeenCalledTimes(1);
    expect(first.src).toBe(second.src);

    first.release();
    first.release();
    expect(revoke).not.toHaveBeenCalled();
    await book.destroy();
    expect(revoke).not.toHaveBeenCalled();
    second.release();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:shared");
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it("aborts a pending open even if PDF.js leaves its loading promise pending", async () => {
    const { makePDF } = await import("../../../foliate-js/pdf.js");
    const controller = new AbortController();
    const task = createTask(new Promise(() => {}));
    const opening = makePDF(file, { signal: controller.signal });
    await vi.waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));
    const cancelled = expect(opening).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await cancelled;
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it("releases only pending XHRs owned by a closed asset URL PDF task", async () => {
    class AssetRequest extends EventTarget {
      abort = vi.fn();
      url = "";

      open(_method: string, url: string | URL) {
        this.url = String(url);
      }
    }
    vi.stubGlobal("XMLHttpRequest", AssetRequest);
    const { createPDFLoadingTask } = await import("../../../foliate-js/pdf.js");
    const url = "asset://localhost/reader.pdf";
    const send = (url: string | URL) => {
      const xhr = new AssetRequest();
      xhr.open("GET", url);
      expect(xhr.url).toBe("asset://localhost/reader.pdf");
      return xhr;
    };

    createTask(Promise.resolve(createPdf()));
    createTask(Promise.resolve(createPdf()));
    const first = await createPDFLoadingTask({ url });
    const second = await createPDFLoadingTask({ url });
    const pending = send(getDocument.mock.calls[0][0].url);
    const completed = send(getDocument.mock.calls[0][0].url);
    completed.dispatchEvent(new Event("loadend"));
    const other = send(getDocument.mock.calls[1][0].url);
    const unrelated = send(url);

    await Promise.all([first.destroy(), first.destroy()]);
    expect(pending.abort).toHaveBeenCalledOnce();
    expect(completed.abort).not.toHaveBeenCalled();
    expect(other.abort).not.toHaveBeenCalled();
    expect(unrelated.abort).not.toHaveBeenCalled();
    await second.destroy();
    expect(other.abort).toHaveBeenCalledOnce();
  });

  it("terminates the native worker when opening is aborted before the handshake", async () => {
    const { configurePDFWorker, makePDF } = await import("../../../foliate-js/pdf.js");
    vi.stubGlobal("Worker", TrackedWorker);
    configurePDFWorker({ workerSrc: "/pdf-worker.js" });
    const controller = new AbortController();
    const started = Promise.withResolvers<EventTarget>();
    TrackedWorker.created.mockImplementationOnce(started.resolve);
    const opening = makePDF(file, { signal: controller.signal });
    const cancelled = expect(opening).rejects.toMatchObject({ name: "AbortError" });

    await started.promise;
    expect(activeWorkers.size).toBe(1);
    controller.abort();
    await cancelled;
    expect(activeWorkers.size).toBe(0);
    expect(getDocument).not.toHaveBeenCalled();
  });

  it("terminates the owned native worker if PDF.js transport destruction rejects", async () => {
    const { configurePDFWorker, makePDF } = await import("../../../foliate-js/pdf.js");
    vi.stubGlobal("Worker", TrackedWorker);
    configurePDFWorker({ workerSrc: "/pdf-worker.js" });
    const started = Promise.withResolvers<EventTarget>();
    TrackedWorker.created.mockImplementationOnce(started.resolve);
    const task = createTask(Promise.resolve(createPdf()));
    const teardown = Promise.withResolvers<void>();
    task.destroy.mockReturnValueOnce(teardown.promise);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const opening = makePDF(file);
    const worker = await started.promise;
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: { sourceName: "worker", targetName: "main", action: "ready" },
      }),
    );
    const book = await opening;
    const closing = book.destroy();
    expect(book.destroy()).toBe(closing);
    expect(activeWorkers.size).toBe(1);
    expect(destroyWorker).not.toHaveBeenCalled();

    const failure = new Error("Transport destruction failed");
    teardown.reject(failure);
    await closing;
    expect(destroyWorker).toHaveBeenCalledExactlyOnceWith();
    expect(activeWorkers.size).toBe(0);
    expect(warning).toHaveBeenCalledExactlyOnceWith("Failed to release PDF loading task:", failure);
  });

  it.each(["close", "hibernate", "render failure"])(
    "forces worker and transport cleanup within the grace period on %s",
    async (mode) => {
      const { configurePDFWorker, makePDF } = await import("../../../foliate-js/pdf.js");
      vi.stubGlobal("Worker", TrackedWorker);
      configurePDFWorker({ workerSrc: "/pdf-worker.js" });
      const started = Promise.withResolvers<EventTarget>();
      TrackedWorker.created.mockImplementationOnce(started.resolve);
      const task = createTask(Promise.resolve(createPdf()));
      const transport = {
        messageHandler: { destroy: vi.fn() },
        commonObjs: { clear: vi.fn() },
        fontLoader: { clear: vi.fn() },
        filterFactory: { destroy: vi.fn() },
      };
      const loadingTask = Object.assign(task, { _transport: transport });
      task.destroy.mockReturnValueOnce(new Promise(() => {}));
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const showError = vi.fn();
      const attempt = createDocumentAttempt(showError);
      const opening = attempt.load(
        (signal) => makePDF(file, { signal }),
        (book) => book,
      );
      const worker = await started.promise;
      worker.dispatchEvent(
        new MessageEvent("message", {
          data: { sourceName: "worker", targetName: "main", action: "ready" },
        }),
      );
      await opening;
      vi.useFakeTimers();
      const originalError = new Error("Second page failed to render");
      // Close and hibernate both unmount the reader and call release().
      const closing = mode === "render failure" ? attempt.fail(originalError) : attempt.release();
      await vi.advanceTimersByTimeAsync(2499);
      expect(activeWorkers.size).toBe(1);
      expect(showError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(activeWorkers.size).toBe(0);
      expect(loadingTask._transport).toBeNull();
      expect(transport.fontLoader.clear).toHaveBeenCalledOnce();
      expect(task.destroy).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledOnce();
      if (mode === "render failure")
        expect(showError).toHaveBeenCalledExactlyOnceWith(originalError);
      else expect(showError).not.toHaveBeenCalled();
    },
  );

  it("times out and terminates a worker that never handshakes without a signal", async () => {
    const { configurePDFWorker, createPDFLoadingTask } = await import("../../../foliate-js/pdf.js");
    vi.useFakeTimers();
    vi.stubGlobal("Worker", TrackedWorker);
    configurePDFWorker({ workerSrc: "/pdf-worker.js" });
    const opening = createPDFLoadingTask(new Uint8Array([1]));
    const failed = expect(opening).rejects.toThrow("PDF worker did not start in time");
    await vi.advanceTimersByTimeAsync(2999);
    expect(activeWorkers.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(activeWorkers.size).toBe(0);
    expect(getDocument).not.toHaveBeenCalled();
  });

  it("does not create a loading task for an already cancelled open", async () => {
    const { makePDF } = await import("../../../foliate-js/pdf.js");
    const controller = new AbortController();
    controller.abort();

    await expect(makePDF(file, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(getDocument).not.toHaveBeenCalled();
  });

  it("accepts repeated initialization in one mode and rejects a mode switch", async () => {
    const { configurePDFWorker } = await import("../../../foliate-js/pdf.js");
    configurePDFWorker({ workerSrc: "/pdf-worker.js" });
    configurePDFWorker({ workerSrc: "/other-worker.js" });
    expect(workerOptions.workerSrc).toBe("/pdf-worker.js");
    expect(() => configurePDFWorker({ workerMessageHandler: {} })).toThrow(/mode.*configured/);
  });
});
