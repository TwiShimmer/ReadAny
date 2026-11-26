const parseViewport = (str) =>
  str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter((x) => x)
    ?.map((x) => x.split("=").map((x) => x.trim()));

const getViewport = (doc, viewport) => {
  // use `viewBox` for SVG
  if (doc.documentElement.localName === "svg") {
    const [, , width, height] = doc.documentElement.getAttribute("viewBox")?.split(/\s/) ?? [];
    return { width, height };
  }

  // get `viewport` `meta` element
  const meta = parseViewport(doc.querySelector('meta[name="viewport"]')?.getAttribute("content"));
  if (meta) return Object.fromEntries(meta);

  // fallback to book's viewport
  if (typeof viewport === "string") return parseViewport(viewport);
  if (viewport?.width && viewport.height) return viewport;

  // if no viewport (possibly with image directly in spine), get image size
  const img = doc.querySelector("img");
  if (img) return { width: img.naturalWidth, height: img.naturalHeight };

  // just show *something*, i guess...
  console.warn(new Error("Missing viewport properties"));
  return { width: 1000, height: 2000 };
};

export class FixedLayout extends HTMLElement {
  static observedAttributes = ["zoom", "zoom-factor", "spread"];
  #root = this.attachShadow({ mode: "closed" });
  #observer = new ResizeObserver(() => this.#refreshSpread());
  #spreads;
  #spreadMode;
  #index = -1;
  defaultViewport;
  spread;
  #portrait = false;
  #left;
  #right;
  #center;
  #side;
  #zoom;
  #zoomFactor = 1;
  #pendingSpread;
  #frameController;
  #destroyed = false;
  constructor() {
    super();

    const sheet = new CSSStyleSheet();
    this.#root.adoptedStyleSheets = [sheet];
    sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: safe center;
            align-items: safe center;
            overflow: auto;
        }`);

    this.#observer.observe(this);
  }
  attributeChangedCallback(name, _, value) {
    switch (name) {
      case "zoom":
        this.#zoom =
          value !== "fit-width" && value !== "fit-page" ? Number.parseFloat(value) : value;
        this.#refreshSpread();
        break;
      case "zoom-factor": {
        const parsed = Number.parseFloat(value);
        this.#zoomFactor = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
        this.#refreshSpread();
        break;
      }
      case "spread":
        this.spread = value;
        this.#applySpreadChange();
        break;
    }
  }
  #buildSpreads(book) {
    const rtl = book.dir === "rtl";
    const ltr = !rtl;
    if (this.#spreadMode === "none") return book.sections.map((section) => ({ center: section }));

    return book.sections.reduce(
      (arr, section, i) => {
        const last = arr[arr.length - 1];
        const { pageSpread } = section;
        const newSpread = () => {
          const spread = {};
          arr.push(spread);
          return spread;
        };
        if (pageSpread === "center") {
          const spread = last.left || last.right ? newSpread() : last;
          spread.center = section;
        } else if (pageSpread === "left") {
          const spread = last.center || last.left || (ltr && i) ? newSpread() : last;
          spread.left = section;
        } else if (pageSpread === "right") {
          const spread = last.center || last.right || (rtl && i) ? newSpread() : last;
          spread.right = section;
        } else if (ltr) {
          if (last.center || last.right) newSpread().left = section;
          else if (last.left || !i) last.right = section;
          else last.left = section;
        } else {
          if (last.center || last.left) newSpread().right = section;
          else if (last.right || !i) last.left = section;
          else last.right = section;
        }
        return arr;
      },
      [{}],
    );
  }
  #applySpreadChange() {
    if (this.#destroyed || this.#pendingSpread || !this.book?.sections?.length) return;
    if (this.spread === this.#spreadMode) return;
    const currentSection = this.book.sections[this.index];
    this.#spreadMode = this.spread;
    if (this.book.rendition) this.book.rendition.spread = this.spread;
    this.#spreads = this.#buildSpreads(this.book);
    if (!currentSection) return;
    const target = this.getSpreadOf(currentSection);
    this.#index = -1;
    this.goToSpread(target.index, target.side, "layout").catch((error) => this.#reportRenderError(error));
  }
  async #createFrame({ index, src: srcOption }, signal) {
    signal.throwIfAborted();
    const srcOptionIsString = typeof srcOption === "string";
    const src = srcOptionIsString ? srcOption : srcOption?.src;
    const onZoom = srcOptionIsString ? null : srcOption?.onZoom;
    const element = document.createElement("div");
    element.setAttribute("dir", "ltr");
    const iframe = document.createElement("iframe");
    element.append(iframe);
    Object.assign(iframe.style, {
      border: "0",
      display: "none",
      overflow: "hidden",
    });
    // `allow-scripts` is needed for events because of WebKit bug
    // https://bugs.webkit.org/show_bug.cgi?id=218086
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("part", "filter");
    this.#root.append(element);
    if (!src) return { blank: true, element, iframe };
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      iframe.addEventListener(
        "load",
        () => {
          signal.removeEventListener("abort", abort);
          try {
            const doc = iframe.contentDocument;
            this.dispatchEvent(new CustomEvent("load", { detail: { doc, index } }));
            const { width, height } = getViewport(doc, this.defaultViewport);
            resolve({
              element,
              iframe,
              width: Number.parseFloat(width),
              height: Number.parseFloat(height),
              onZoom,
              signal,
            });
          } catch (error) {
            reject(error);
          }
        },
        { once: true, signal },
      );
      iframe.src = src;
    });
  }
  #render(side = this.#side) {
    if (!side) return;
    const left = this.#left ?? {};
    const right = this.#center ?? this.#right ?? {};
    const target = side === "left" ? left : right;
    const { width, height } = this.getBoundingClientRect();
    const portrait = this.spread !== "both" && this.spread !== "portrait" && height > width;
    this.#portrait = portrait;
    const blankWidth = left.width ?? right.width ?? 0;
    const blankHeight = left.height ?? right.height ?? 0;

    const fitScale =
      typeof this.#zoom === "number" && !Number.isNaN(this.#zoom)
        ? this.#zoom
        : (this.#zoom === "fit-width"
            ? portrait || this.#center
              ? width / (target.width ?? blankWidth)
              : width / ((left.width ?? blankWidth) + (right.width ?? blankWidth))
            : portrait || this.#center
              ? Math.min(
                  width / (target.width ?? blankWidth),
                  height / (target.height ?? blankHeight),
                )
              : Math.min(
                  width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                  height / Math.max(left.height ?? blankHeight, right.height ?? blankHeight),
                )) || 1;
    const scale =
      typeof this.#zoom === "number" && !Number.isNaN(this.#zoom)
        ? fitScale
        : fitScale * this.#zoomFactor;

    const renders = [];
    const transform = (frame) => {
      const { element, iframe, width, height, blank, onZoom, signal } = frame;
      if (!iframe) return;
      if (onZoom) {
        renders.push(
          Promise.resolve().then(() => {
            if (!signal.aborted) return onZoom({ doc: iframe.contentDocument, scale });
          }),
        );
      }
      const iframeScale = onZoom ? scale : 1;
      Object.assign(iframe.style, {
        width: `${width * iframeScale}px`,
        height: `${height * iframeScale}px`,
        transform: onZoom ? "none" : `scale(${scale})`,
        transformOrigin: "top left",
        display: blank ? "none" : "block",
      });
      Object.assign(element.style, {
        width: `${(width ?? blankWidth) * scale}px`,
        height: `${(height ?? blankHeight) * scale}px`,
        overflow: "hidden",
        display: "block",
        flexShrink: "0",
        marginBlock: "auto",
      });
      if (portrait && frame !== target) {
        element.style.display = "none";
      }
    };
    if (this.#center) {
      transform(this.#center);
    } else {
      transform(left);
      transform(right);
    }
    if (renders.length) return Promise.all(renders);
  }
  async #reportRenderError(error) {
    if (!this.book.reportRenderError) {
      console.error("Failed to render fixed-layout page:", error);
      return;
    }
    try {
      await this.book.reportRenderError(error);
    } catch (failure) {
      console.error("Failed to report fixed-layout render error:", failure);
    }
  }
  #refreshSpread() {
    const controller = this.#frameController;
    if (!controller) return;
    const pending = this.#pendingSpread;
    if (pending?.controller === controller) {
      pending.refresh = true;
      return;
    }
    this.#render()?.catch((error) => {
      if (!controller.signal.aborted) return this.#reportRenderError(error);
    });
  }
  #clearFrames() {
    this.#root.replaceChildren();
    this.#left = null;
    this.#right = null;
    this.#center = null;
    this.#frameController?.abort();
    this.#frameController = undefined;
  }
  #spreadSide(side) {
    if (this.#center) return "center";
    if (this.#left?.blank) return "right";
    if (this.#right?.blank) return "left";
    return side;
  }
  async #showSpread({ left, right, center }, pending) {
    const { controller } = pending;
    const { signal } = controller;
    signal.throwIfAborted();
    this.#clearFrames();
    this.#frameController = controller;
    if (center) {
      const frame = await this.#createFrame(center, signal);
      signal.throwIfAborted();
      this.#center = frame;
    } else {
      const leftFrame = await this.#createFrame(left, signal);
      const rightFrame = await this.#createFrame(right, signal);
      signal.throwIfAborted();
      this.#left = leftFrame;
      this.#right = rightFrame;
    }
    const side = this.#spreadSide(pending.side);
    pending.refresh = false;
    await this.#render(side);
    signal.throwIfAborted();
    this.#side = this.#spreadSide(pending.side);
    pending.refresh ||= this.#side !== side;
  }
  #goLeft() {
    if (this.#center || this.#left?.blank) return;
    if (this.#portrait && this.#left?.element?.style?.display === "none") {
      this.#side = "left";
      this.#refreshSpread();
      this.#reportLocation("page");
      return true;
    }
  }
  #goRight() {
    if (this.#center || this.#right?.blank) return;
    if (this.#portrait && this.#right?.element?.style?.display === "none") {
      this.#side = "right";
      this.#refreshSpread();
      this.#reportLocation("page");
      return true;
    }
  }
  open(book) {
    this.book = book;
    const { rendition } = book;
    this.spread = rendition?.spread;
    this.#spreadMode = this.spread;
    this.defaultViewport = rendition?.viewport;

    const rtl = book.dir === "rtl";
    this.rtl = rtl;

    this.#spreads = this.#buildSpreads(book);
  }
  get index() {
    const spread = this.#spreads[this.#index];
    if (!spread) return -1;
    const section =
      spread?.center ??
      (this.#side === "left" ? (spread.left ?? spread.right) : (spread.right ?? spread.left));
    return this.book.sections.indexOf(section);
  }
  #reportLocation(reason) {
    this.dispatchEvent(
      new CustomEvent("relocate", {
        detail: { reason, range: null, index: this.index, fraction: 0, size: 1 },
      }),
    );
  }
  getSpreadOf(section) {
    const spreads = this.#spreads;
    for (let index = 0; index < spreads.length; index++) {
      const { left, right, center } = spreads[index];
      if (left === section) return { index, side: "left" };
      if (right === section) return { index, side: "right" };
      if (center === section) return { index, side: "center" };
    }
  }
  goToSpread(index, side, reason) {
    if (this.#destroyed || !this.#spreads[index]) return Promise.resolve(false);
    const pending = this.#pendingSpread;
    if (pending?.index === index) {
      pending.side = side;
      return pending.promise;
    }
    this.#cancelPendingSpread();
    if (index === this.#index && this.#frameController) {
      const previousSide = this.#side;
      this.#side = this.#spreadSide(side);
      this.#refreshSpread();
      if (previousSide !== this.#side) this.#reportLocation(reason);
      return Promise.resolve(true);
    }
    const load = { index, side, controller: new AbortController(), promise: undefined };
    this.#pendingSpread = load;
    const { signal } = load.controller;
    const cancelled = new Promise((resolve) => {
      load.onAbort = () => resolve(false);
      signal.addEventListener("abort", load.onAbort, { once: true });
    });
    load.promise = Promise.race([
      Promise.resolve().then(() => this.#loadSpread(load, reason)),
      cancelled,
    ]).finally(() => signal.removeEventListener("abort", load.onAbort));
    return load.promise;
  }
  #cancelPendingSpread() {
    const pending = this.#pendingSpread;
    if (!pending) return;
    this.#pendingSpread = undefined;
    if (pending.controller === this.#frameController) this.#clearFrames();
    else pending.controller.abort();
  }
  async #loadSpread(pending, reason) {
    const { index, controller } = pending;
    const { signal } = controller;
    const loadFrame = async (section) => {
      signal.throwIfAborted();
      const src = await section?.load?.();
      if (signal.aborted) {
        src?.release?.();
        signal.throwIfAborted();
      }
      if (src?.release) signal.addEventListener("abort", src.release, { once: true });
      return { src, index: this.book.sections.indexOf(section) };
    };
    const spread = this.#spreads[index];
    try {
      signal.throwIfAborted();
      if (spread.center) {
        const center = await loadFrame(spread.center);
        await this.#showSpread({ center }, pending);
      } else {
        const left = await loadFrame(spread.left);
        const right = await loadFrame(spread.right);
        await this.#showSpread({ left, right }, pending);
      }
      if (signal.aborted) return false;
      this.#index = index;
      this.#pendingSpread = undefined;
      if (pending.refresh) this.#refreshSpread();
      this.#reportLocation(reason);
      this.#applySpreadChange();
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      signal.removeEventListener("abort", pending.onAbort);
      if (this.#pendingSpread === pending) this.#cancelPendingSpread();
      throw error;
    }
  }
  async select(target) {
    await this.goTo(target);
    // TODO
  }
  async goTo(target, reason) {
    const { book } = this;
    const resolved = await target;
    if (!resolved || typeof resolved.index !== "number") return false;
    const section = book.sections[resolved.index];
    if (!section) return false;
    const spread = this.getSpreadOf(section);
    if (!spread) return false;
    const { index, side } = spread;
    return this.goToSpread(index, side, reason);
  }
  async next() {
    const s = !this.#pendingSpread && (this.rtl ? this.#goLeft() : this.#goRight());
    if (!s) return this.goToSpread(this.#index + 1, this.rtl ? "right" : "left", "page");
  }
  async prev() {
    const s = !this.#pendingSpread && (this.rtl ? this.#goRight() : this.#goLeft());
    if (!s) return this.goToSpread(this.#index - 1, this.rtl ? "left" : "right", "page");
  }
  getContents() {
    return Array.from(this.#root.querySelectorAll("iframe"), (frame) => ({
      doc: frame.contentDocument,
      // TODO: index, overlayer
    }));
  }
  destroy() {
    this.#destroyed = true;
    this.#observer.unobserve(this);
    this.#cancelPendingSpread();
    this.#clearFrames();
  }
}

if (!customElements.get("foliate-fxl")) customElements.define("foliate-fxl", FixedLayout);
