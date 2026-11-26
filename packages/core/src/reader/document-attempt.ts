interface OwnedDocument {
  destroy?(): void | Promise<void>;
}

/** One reader attempt owns its document. Views borrow it until the signal aborts. */
export function createDocumentAttempt(onFailure: (error: unknown) => void) {
  const controller = new AbortController();
  const { signal } = controller;
  let ownedDocument: OwnedDocument | undefined;
  let opening: Promise<void> | undefined;
  let teardown: Promise<void> | undefined;
  let released = false;

  const destroy = async (doc: OwnedDocument | undefined) => {
    try {
      await doc?.destroy?.();
    } catch (error) {
      console.warn("Failed to release reader document:", error);
    }
  };

  const stop = () => {
    if (teardown) return teardown;
    teardown = Promise.resolve().then(async () => {
      // Observe only the loader, never its consumer (which may call fail/release).
      await opening;
      opening = undefined;
      const doc = ownedDocument;
      ownedDocument = undefined;
      await destroy(doc);
    });
    controller.abort();
    return teardown;
  };

  return {
    signal,
    load<T>(
      loader: (signal: AbortSignal) => Promise<T>,
      documentOf: (value: T) => OwnedDocument | undefined,
    ) {
      if (opening) throw new Error("This reader attempt already has a loader");
      signal.throwIfAborted();
      const result = Promise.resolve().then(async () => {
        const value = await loader(signal);
        ownedDocument = documentOf(value);
        return value;
      });
      opening = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    release() {
      released = true;
      return stop();
    },
    async fail(error: unknown) {
      if (teardown) return teardown;
      await stop();
      if (!released) onFailure(error);
    },
  };
}
