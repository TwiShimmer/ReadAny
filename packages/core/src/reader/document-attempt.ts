interface OwnedDocument {
  destroy?(): void | Promise<void>;
}

/** One reader attempt owns its document. Views borrow it until the signal aborts. */
export function createDocumentAttempt(onFailure: (error: unknown) => void) {
  const controller = new AbortController();
  const { signal } = controller;
  let ownedDocument: OwnedDocument | undefined;
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
    const doc = ownedDocument;
    ownedDocument = undefined;
    teardown = Promise.resolve().then(() => destroy(doc));
    controller.abort();
    return teardown;
  };

  return {
    signal,
    own(doc: OwnedDocument) {
      if (signal.aborted) return destroy(doc);
      ownedDocument = doc;
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
