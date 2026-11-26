import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentAttempt } from "./document-attempt";

function controlledPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const renderer = Object.assign(new EventTarget(), {
  open: vi.fn(),
  destroy: vi.fn(),
  remove: vi.fn(),
  setAttribute: vi.fn(),
  goTo: vi.fn(),
});

it("release waits for a late loader result and its destruction on the same promise", async () => {
  const attempt = createDocumentAttempt(vi.fn());
  const delivery = controlledPromise<{ destroy: () => Promise<void> }>();
  const cleanup = controlledPromise<void>();
  const destroy = vi.fn(() => cleanup.promise);
  const opening = attempt.load(
    () => delivery.promise,
    (doc) => doc,
  );
  const done = vi.fn();
  const release = attempt.release();
  const observed = release.then(done);
  expect(attempt.release()).toBe(release);
  expect(attempt.signal.aborted).toBe(true);
  delivery.resolve({ destroy });
  await opening;
  await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
  expect(destroy).toHaveBeenCalledExactlyOnceWith();
  expect(done).not.toHaveBeenCalled();
  cleanup.resolve(undefined);
  await observed;
  expect(done).toHaveBeenCalledTimes(1);
});

it.each(["failed", "cancelled"])("settles release when a delayed loader is %s", async (kind) => {
  const showError = vi.fn();
  const attempt = createDocumentAttempt(showError);
  const delivery = Promise.withResolvers<undefined>();
  const opening = attempt.load(
    () => delivery.promise,
    () => undefined,
  );
  const reason =
    kind === "cancelled" ? new DOMException("Cancelled", "AbortError") : new Error("Failed");
  const observed = expect(opening).rejects.toBe(reason);
  const done = vi.fn();
  const release = attempt.release();
  const released = release.then(done);
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  delivery.reject(reason);
  await Promise.all([observed, released, attempt.fail(reason)]);
  expect(attempt.release()).toBe(release);
  expect(showError).not.toHaveBeenCalled();
});
const createElement = vi.fn<(name: string) => unknown>();
const removeView = vi.fn();

class MockViewElement extends EventTarget {
  attachShadow() {
    return { append: vi.fn(), replaceChildren: vi.fn() };
  }

  getBoundingClientRect() {
    return { width: 800, height: 600 };
  }

  remove() {
    removeView();
  }
}

async function openAttempt() {
  const { View } = await import("../../../foliate-js/view.js");
  const showError = vi.fn();
  const attempt = createDocumentAttempt(showError);
  const destroy = vi.fn();
  const book = {
    destroy,
    renderSignal: attempt.signal,
    rendition: { layout: "pre-paginated" },
    sections: [{ id: 0 }],
  };
  await attempt.load(
    async () => book,
    (doc) => doc,
  );
  return { view: new View(), attempt, book, destroy, showError };
}

describe("reader view and document ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createElement.mockReturnValue(renderer);
    vi.stubGlobal("HTMLElement", MockViewElement);
    vi.stubGlobal("customElements", { get: () => true });
    vi.stubGlobal("NodeFilter", { SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_CDATA_SECTION: 8 });
    vi.stubGlobal("document", { createElement });
    vi.stubGlobal(
      "CSSStyleSheet",
      class {
        replaceSync() {}
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("closes the partially built renderer before releasing a rejected open", async () => {
    const { view, attempt, book, destroy, showError } = await openAttempt();
    const error = new Error("Renderer initialization failed");
    renderer.open.mockImplementationOnce(() => {
      throw error;
    });

    await expect(
      view.open(book).catch(async (cause: unknown) => {
        await attempt.fail(cause);
        throw cause;
      }),
    ).rejects.toBe(error);
    view.close();
    await attempt.release();
    expect(renderer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(destroy).toHaveBeenCalledExactlyOnceWith();
    expect(renderer.destroy).toHaveBeenCalledBefore(destroy);
    expect(destroy).toHaveBeenCalledBefore(showError);
  });

  it("releases the open view and document while the reader stays on its error panel", async () => {
    const { view, attempt, book, destroy, showError } = await openAttempt();
    await view.open(book);
    const error = new Error("First page failed to render");

    await Promise.all([attempt.fail(error), attempt.fail(new Error("Late renderer error"))]);
    expect(showError).toHaveBeenCalledExactlyOnceWith(error);
    expect(renderer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(removeView).toHaveBeenCalledExactlyOnceWith();
    expect(destroy).toHaveBeenCalledExactlyOnceWith();
    expect(removeView).toHaveBeenCalledBefore(destroy);
    expect(destroy).toHaveBeenCalledBefore(showError);
  });

  it("waits for the shared teardown before publishing a first-page error", async () => {
    const { view, attempt, book, destroy, showError } = await openAttempt();
    const teardown = controlledPromise<void>();
    destroy.mockReturnValueOnce(teardown.promise);
    await view.open(book);

    const error = new Error("First page failed to render");
    const failing = attempt.fail(error);
    const repeatedFailure = attempt.fail(new Error("Late renderer error"));
    expect(renderer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(showError).not.toHaveBeenCalled();

    teardown.resolve(undefined);
    await Promise.all([failing, repeatedFailure]);
    expect(destroy).toHaveBeenCalledExactlyOnceWith();
    expect(showError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("does not publish a failure when the attempt is replaced during teardown", async () => {
    const { attempt, destroy, showError } = await openAttempt();
    const teardown = controlledPromise<void>();
    destroy.mockReturnValueOnce(teardown.promise);
    const failing = attempt.fail(new Error("First page failed to render"));
    const release = attempt.release();
    expect(attempt.release()).toBe(release);
    teardown.resolve(undefined);
    await Promise.all([failing, release]);
    expect(destroy).toHaveBeenCalledExactlyOnceWith();
    expect(showError).not.toHaveBeenCalled();
  });

  async function openFixedLayout({ pageCount = 3, reportInvalidLocation = vi.fn() } = {}) {
    const { FixedLayout } = await import("../../../foliate-js/fixed-layout.js");
    const { view, book, attempt, destroy, showError } = await openAttempt();
    const firstPage = controlledPromise<undefined>();
    const loadFirst = vi.fn(() => firstPage.promise);
    const loadSecond = vi.fn(async () => undefined);
    const thirdPage = controlledPromise<undefined>();
    const loadThird = vi.fn(() => thirdPage.promise);
    const layout = new FixedLayout();
    layout.remove = vi.fn();
    createElement.mockImplementation((name = "foliate-fxl") => {
      if (name === "foliate-fxl") return layout;
      if (name === "iframe") {
        const frame = Object.assign(new EventTarget(), {
          style: {},
          setAttribute: vi.fn(),
          contentDocument: Object.assign(new EventTarget(), {
            querySelector: () => null,
            documentElement: Object.assign(new EventTarget(), { style: {} }),
          }),
        });
        queueMicrotask(() => frame.dispatchEvent(new Event("load")));
        return frame;
      }
      return { append: vi.fn(), setAttribute: vi.fn(), style: {} };
    });
    layout.setAttribute = (name: string, value: string) => {
      if (name === "spread") layout.attributeChangedCallback(name, null, value);
    };
    await view.open({
      ...book,
      rendition: { ...book.rendition, viewport: { width: 600, height: 800 } },
      resolveHref: (href: string) => ({ index: Number(href) }),
      reportRenderError: attempt.fail,
      reportInvalidLocation,
      sections: [
        { id: 0, load: loadFirst },
        { id: 1, load: loadSecond },
        { id: 2, load: loadThird },
      ].slice(0, pageCount),
    });
    return {
      view,
      layout,
      firstPage,
      loadFirst,
      loadSecond,
      loadThird,
      thirdPage,
      destroy,
      showError,
    };
  }

  it("lets init load the first page of a multi-page document after applying layout settings", async () => {
    const { view, layout, firstPage, loadFirst, loadSecond } = await openFixedLayout();
    layout.setAttribute("spread", "none");
    const callsBeforeInit = loadFirst.mock.calls.length;
    const initializing = view.init({});
    firstPage.resolve(undefined);
    await initializing;

    expect(callsBeforeInit).toBe(0);
    expect(loadFirst).toHaveBeenCalledExactlyOnceWith();
    expect(loadSecond).not.toHaveBeenCalled();
    expect(layout.index).toBe(0);
    await view.next();
    expect(layout.index).toBe(1);
  });

  it("makes init await a pending restored spread and receive its first-page failure", async () => {
    const { view, layout, loadFirst } = await openFixedLayout();
    const error = new Error("First PDF page failed to load");
    const page = Promise.reject(error);
    loadFirst.mockReturnValueOnce(page);
    const navigation = layout.goToSpread(0, "right", "page");
    const initializing = view.init({ lastLocation: "epubcfi(/6/2)" });

    await expect(navigation).rejects.toBe(error);
    await expect(initializing).rejects.toBe(error);
    expect(loadFirst).toHaveBeenCalledExactlyOnceWith();
    expect(layout.index).toBe(-1);
  });

  it.each(["epubcfi(/6/6)", "epubcfi(/6/3)", "epubcfi(/4/2)", "not-a-cfi"])(
    "discards invalid fixed-layout position %s before rendering page one",
    async (lastLocation) => {
      const reportInvalidLocation = vi.fn();
      const { view, layout, firstPage, loadFirst, loadThird, destroy, showError } =
        await openFixedLayout({ pageCount: 1, reportInvalidLocation });
      layout.setAttribute("spread", "none");
      const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const initializing = view.init({ lastLocation });
        await vi.waitFor(() => expect(loadFirst).toHaveBeenCalledOnce());
        expect(reportInvalidLocation).toHaveBeenCalledExactlyOnceWith(lastLocation);
        firstPage.resolve(undefined);
        await initializing;
        expect(layout.index).toBe(0);
        expect(view.lastLocation.cfi).toBe("epubcfi(/6/2)");
        expect(loadThird).not.toHaveBeenCalled();
        expect(showError).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
      } finally {
        diagnostic.mockRestore();
      }
    },
  );

  it("blocks next and TOC navigation while restoring a later spread", async () => {
    const { view, layout, thirdPage, loadThird, loadFirst, loadSecond } = await openFixedLayout();
    layout.setAttribute("spread", "none");
    const initializing = view.init({ lastLocation: "epubcfi(/6/6)" });
    await vi.waitFor(() => expect(loadThird).toHaveBeenCalledOnce());
    await Promise.all([view.next(), view.goTo("0")]);
    expect(layout.index).toBe(-1);
    expect(loadFirst).not.toHaveBeenCalled();
    expect(loadSecond).not.toHaveBeenCalled();
    thirdPage.resolve(undefined);
    await initializing;
    expect(layout.index).toBe(2);
    expect(view.history.canGoBack).toBe(false);
    await view.prev();
    expect(layout.index).toBe(1);
  });

  it("rejects init without writing history if a renderer supersedes the restored spread", async () => {
    const { view, layout, loadThird } = await openFixedLayout();
    layout.setAttribute("spread", "none");
    const initializing = view.init({ lastLocation: "epubcfi(/6/6)" });
    const failed = expect(initializing).rejects.toThrow("was not displayed");
    await vi.waitFor(() => expect(loadThird).toHaveBeenCalledOnce());
    const historyChanged = vi.fn();
    view.history.addEventListener("index-change", historyChanged);
    await layout.goTo({ index: 1 });
    await failed;
    expect(layout.index).toBe(1);
    expect(historyChanged).not.toHaveBeenCalled();
  });

  it.each(["next", "TOC"])(
    "reports a later zoom failure and releases the book on %s",
    async (mode) => {
      const { view, layout, firstPage, destroy, showError } = await openFixedLayout();
      layout.setAttribute("spread", "none");
      const failure = new Error("Second page canvas failed");
      const section = view.book.sections[1];
      section.load = async () => ({
        src: "blob:second",
        onZoom: vi.fn().mockRejectedValue(failure),
      });
      firstPage.resolve(undefined);
      await view.init({});
      expect(layout.index).toBe(0);

      if (mode === "next") await view.next();
      else await view.goTo("1");
      expect(destroy).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledBefore(showError);
      expect(showError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(removeView).toHaveBeenCalledOnce();
      expect(view.history.canGoBack).toBe(false);
    },
  );

  it("removes a pending view on replacement and stops a late open from building a renderer", async () => {
    const { view, attempt, book, destroy } = await openAttempt();
    const toc = controlledPromise<[number, null]>();
    const splitTOCHref = vi.fn(() => toc.promise);
    const opening = view.open({
      ...book,
      toc: [{ href: "0" }],
      splitTOCHref,
      getTOCFragment: () => null,
    });
    const stopped = expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(splitTOCHref).toHaveBeenCalledExactlyOnceWith("0");

    await attempt.release();
    expect(removeView).toHaveBeenCalled();
    expect(removeView).toHaveBeenCalledBefore(destroy);
    await stopped;
    toc.resolve([0, null]);
    await toc.promise;
    expect(createElement).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledExactlyOnceWith();
  });

  it("cancels a pending view when its element disconnects before the owner releases", async () => {
    const { view, attempt, book, destroy, showError } = await openAttempt();
    const toc = controlledPromise<[number, null]>();
    const opening = view.open({
      ...book,
      toc: [{ href: "0" }],
      splitTOCHref: () => toc.promise,
      getTOCFragment: () => null,
    });
    const stopped = expect(opening).rejects.toMatchObject({ name: "AbortError" });

    view.disconnectedCallback();
    await attempt.release();
    await stopped;
    toc.resolve([0, null]);
    await toc.promise;
    expect(createElement).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledExactlyOnceWith();
    expect(showError).not.toHaveBeenCalled();
  });

  it("closes a renderer during first-page initialization before destroying its document", async () => {
    const { view, attempt, book, destroy } = await openAttempt();
    const page = controlledPromise<void>();
    await view.open(book);
    renderer.goTo.mockReturnValueOnce(page.promise);
    const initializing = view.init({});
    const stopped = expect(initializing).rejects.toMatchObject({ name: "AbortError" });

    await attempt.release();
    expect(renderer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(renderer.destroy).toHaveBeenCalledBefore(destroy);
    page.resolve(undefined);
    await stopped;
    expect(destroy).toHaveBeenCalledExactlyOnceWith();
  });
});
