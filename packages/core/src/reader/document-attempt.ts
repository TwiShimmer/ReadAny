interface OwnedDocument {
  destroy?(): void | Promise<void>;
}

/** One reader attempt owns its document. Views borrow it until the signal aborts. */
export function createDocumentAttempt(onFailure: (error: unknown) => void) {
  const controller = new AbortController();
  const { signal } = controller;
  let ownedDocument: OwnedDocument | undefined;

  const destroy = async (doc: OwnedDocument | undefined) => {
    try {
      await doc?.destroy?.();
    } catch (error) {
      console.warn("Failed to release reader document:", error);
    }
  };

  const release = () => {
    if (signal.aborted) return;
    controller.abort();
    const doc = ownedDocument;
    ownedDocument = undefined;
    void destroy(doc);
  };

  return {
    signal,
    own(doc: OwnedDocument) {
      if (signal.aborted) {
        void destroy(doc);
        return;
      }
      ownedDocument = doc;
    },
    release,
    fail(error: unknown) {
      if (signal.aborted) return;
      release();
      onFailure(error);
    },
  };
}
