import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDocument = vi.fn();
const workerOptions = { workerSrc: "" };
const foliateRequire = createRequire(new URL("../../../foliate-js/pdf.js", import.meta.url));

const file = new File(["%PDF-1.7"], "sample.pdf");

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
    }));
    getDocument.mockReset();
    workerOptions.workerSrc = "";
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
