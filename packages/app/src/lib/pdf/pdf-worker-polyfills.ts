/**
 * Worker-side runtime polyfills. This module MUST be evaluated before
 * pdf.worker.mjs: the worker is a separate JS realm and never sees the
 * polyfills installed by `src/polyfills.ts` on the main thread.
 */
import { installModernMapPolyfills } from "@readany/core/utils/modern-map";

if (typeof Promise.withResolvers === "undefined") {
  Promise.withResolvers = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

installModernMapPolyfills();
