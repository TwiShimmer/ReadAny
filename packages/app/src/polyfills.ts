/**
 * Main-thread runtime polyfills.
 *
 * IMPORTANT: this file is imported first by `main.tsx`, but it does NOT cover
 * module workers. pdf.js runs in its own worker (`lib/pdf/pdf-worker-entry.ts`),
 * which installs the same polyfills before loading pdf.worker.mjs. Keep both
 * call sites on `@readany/core/utils/modern-map` so they cannot drift.
 */
import {
  findMissingMapUpsertApis,
  installModernMapPolyfills,
} from "@readany/core/utils/modern-map";

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

// A frozen/patched prototype can make installation impossible. The runtime
// banner reads this later and points the user at the WebView2 download page.
const missingMapApis = findMissingMapUpsertApis();
if (missingMapApis.length > 0) {
  console.error(
    "[polyfills] runtime is missing Map upsert APIs and could not be patched:",
    missingMapApis.join(", "),
  );
}
