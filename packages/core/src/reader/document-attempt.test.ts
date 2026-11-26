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
  next: vi.fn(),
});
const createElement = vi.fn(() => renderer);
const removeView = vi.fn();

class MockViewElement extends EventTarget {
  attachShadow() {
    return { append: vi.fn() };
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
  attempt.own(book);
  return { view: new View(), attempt, book, destroy, showError };
}

describe("reader view and document ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("HTMLElement", MockViewElement);
    vi.stubGlobal("customElements", { get: () => true });
    vi.stubGlobal("NodeFilter", { SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_CDATA_SECTION: 8 });
    vi.stubGlobal("document", { createElement });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("closes the partially built renderer before releasing a rejected open", async () => {
    const { view, attempt, book, destroy, showError } = await openAttempt();
    const error = new Error("Renderer initialization failed");
    renderer.open.mockImplementationOnce(() => {
      throw error;
    });

    await expect(
      view.open(book).catch((cause: unknown) => {
        attempt.fail(cause);
        throw cause;
      }),
    ).rejects.toBe(error);
    view.close();
    attempt.release();
    expect(renderer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(destroy).toHaveBeenCalledExactlyOnceWith();
    expect(renderer.destroy).toHaveBeenCalledBefore(destroy);
    expect(destroy).toHaveBeenCalledBefore(showError);
  });

  it("releases the open view and document while the reader stays on its error panel", async () => {
    const { view, attempt, book, destroy, showError } = await openAttempt();
    await view.open(book);
    const error = new Error("First page failed to render");

    attempt.fail(error);
    attempt.fail(new Error("Late renderer error"));
    expect(showError).toHaveBeenCalledExactlyOnceWith(error);
    expect(renderer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(removeView).toHaveBeenCalledExactlyOnceWith();
    expect(destroy).toHaveBeenCalledExactlyOnceWith();
    expect(removeView).toHaveBeenCalledBefore(destroy);
    expect(destroy).toHaveBeenCalledBefore(showError);
  });

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

    attempt.release();
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
    attempt.release();
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
    renderer.next.mockReturnValueOnce(page.promise);
    const initializing = view.init({});
    const stopped = expect(initializing).rejects.toMatchObject({ name: "AbortError" });

    attempt.release();
    expect(renderer.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(renderer.destroy).toHaveBeenCalledBefore(destroy);
    page.resolve(undefined);
    await stopped;
    expect(destroy).toHaveBeenCalledExactlyOnceWith();
  });
});
