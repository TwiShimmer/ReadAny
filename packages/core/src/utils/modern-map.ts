/**
 * Polyfills for the TC39 "Map upsert" proposal methods used by pdf.js 5.x:
 *
 *   Map.prototype.getOrInsert(key, value)
 *   Map.prototype.getOrInsertComputed(key, callback)
 *   WeakMap.prototype.getOrInsert(key, value)
 *   WeakMap.prototype.getOrInsertComputed(key, callback)
 *
 * Chromium only shipped these in recent builds. WebView2 143 (and other
 * embedded Chromium runtimes) still lack them, which made every PDF fail with
 * `getOrInsertComputed is not a function`. pdf.js runs inside a module worker
 * as well as on the main thread, so the installer must be callable from both
 * contexts.
 *
 * Semantics follow the proposal:
 *  - an existing key is returned without calling the callback;
 *  - a missing key computes/sets once, passing the key to the callback;
 *  - a non-callable callback throws before the key is looked up;
 *  - a receiver without the right internal slots throws a TypeError;
 *  - native methods are never overwritten and installation is idempotent.
 */

type UpsertHost<K, V> = {
  has(key: K): boolean;
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
};

type UpsertPrototype = {
  prototype: object;
};

const MAP_METHODS = ["getOrInsert", "getOrInsertComputed"] as const;
const WEAK_MAP_METHODS = ["getOrInsert", "getOrInsertComputed"] as const;

export type MapUpsertMethod = (typeof MAP_METHODS)[number];

function methodName(ctorName: string, name: MapUpsertMethod): string {
  return `${ctorName}.prototype.${name}`;
}

function assertReceiver<K, V>(
  ctor: UpsertPrototype,
  receiver: unknown,
  ctorName: string,
  name: MapUpsertMethod,
): asserts receiver is UpsertHost<K, V> {
  if (!Object.prototype.isPrototypeOf.call(ctor.prototype, receiver as object)) {
    throw new TypeError(`${methodName(ctorName, name)} called on incompatible receiver`);
  }
}

function assertCallback<F extends (key: unknown) => unknown>(
  callback: F | unknown,
  ctorName: string,
  name: MapUpsertMethod,
): asserts callback is F {
  if (typeof callback !== "function") {
    throw new TypeError(`${methodName(ctorName, name)}: callback is not a function`);
  }
}

function defineMethod(ctor: UpsertPrototype, name: MapUpsertMethod, value: unknown): boolean {
  const prototype = ctor.prototype as Record<string, unknown>;
  if (typeof prototype[name] === "function") return false;
  Object.defineProperty(prototype, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return true;
}

/**
 * Installs both upsert methods on a Map-like constructor without replacing
 * native implementations. Returns true when at least one method was added.
 */
export function installMapUpsertPolyfill(ctor: UpsertPrototype = Map): boolean {
  let installed = false;

  const getOrInsert = function <K, V>(this: UpsertHost<K, V>, key: K, value: V): V {
    assertReceiver<K, V>(ctor, this, "Map", "getOrInsert");
    if (this.has(key)) return this.get(key) as V;
    this.set(key, value);
    return value;
  };

  const getOrInsertComputed = function <K, V>(
    this: UpsertHost<K, V>,
    key: K,
    callback: (key: K) => V,
  ): V {
    assertReceiver<K, V>(ctor, this, "Map", "getOrInsertComputed");
    assertCallback(callback, "Map", "getOrInsertComputed");
    if (this.has(key)) return this.get(key) as V;
    const value = callback(key);
    this.set(key, value);
    return value;
  };

  installed = defineMethod(ctor, "getOrInsert", getOrInsert) || installed;
  installed = defineMethod(ctor, "getOrInsertComputed", getOrInsertComputed) || installed;
  return installed;
}

/**
 * Installs both upsert methods on a WeakMap-like constructor. Primitive keys
 * are rejected by the receiver's own `has` (native WeakMap throws), preserving
 * spec behaviour without duplicating the key validation here.
 */
export function installWeakMapUpsertPolyfill(ctor: UpsertPrototype = WeakMap): boolean {
  let installed = false;

  const getOrInsert = function <K extends object, V>(this: UpsertHost<K, V>, key: K, value: V): V {
    assertReceiver<K, V>(ctor, this, "WeakMap", "getOrInsert");
    if (this.has(key)) return this.get(key) as V;
    this.set(key, value);
    return value;
  };

  const getOrInsertComputed = function <K extends object, V>(
    this: UpsertHost<K, V>,
    key: K,
    callback: (key: K) => V,
  ): V {
    assertReceiver<K, V>(ctor, this, "WeakMap", "getOrInsertComputed");
    assertCallback(callback, "WeakMap", "getOrInsertComputed");
    if (this.has(key)) return this.get(key) as V;
    const value = callback(key);
    this.set(key, value);
    return value;
  };

  installed = defineMethod(ctor, "getOrInsert", getOrInsert) || installed;
  installed = defineMethod(ctor, "getOrInsertComputed", getOrInsertComputed) || installed;
  return installed;
}

export interface ModernMapInstallResult {
  /** Methods that were missing and are now installed. */
  installed: string[];
  /** Methods that were already present and left untouched. */
  skipped: string[];
}

/**
 * Installs the upsert polyfills on the global Map and WeakMap constructors.
 * Safe to call repeatedly (and from a worker).
 */
export function installModernMapPolyfills(
  mapCtor: UpsertPrototype = Map,
  weakMapCtor: UpsertPrototype = WeakMap,
): ModernMapInstallResult {
  const result: ModernMapInstallResult = { installed: [], skipped: [] };

  const record = (ctor: UpsertPrototype, label: string, methods: readonly MapUpsertMethod[]) => {
    const prototype = ctor.prototype as Record<string, unknown>;
    for (const name of methods) {
      if (typeof prototype[name] === "function") {
        result.skipped.push(`${label}.${name}`);
      } else {
        result.installed.push(`${label}.${name}`);
      }
    }
  };

  record(mapCtor, "Map", MAP_METHODS);
  record(weakMapCtor, "WeakMap", WEAK_MAP_METHODS);

  // Installation is all-or-nothing per constructor; a frozen prototype throws
  // and the caller reports the remaining gaps to the user.
  try {
    installMapUpsertPolyfill(mapCtor);
  } catch {
    // Keep going: WeakMap may still be patchable.
  }
  try {
    installWeakMapUpsertPolyfill(weakMapCtor);
  } catch {
    // The caller verifies support with findMissingMapUpsertApis().
  }

  return result;
}

/**
 * Lists the upsert APIs still missing after installation. A non-empty result
 * means the runtime is too old/crippled and the user should upgrade the
 * embedded WebView (or the OS component that provides it).
 */
export function findMissingMapUpsertApis(
  mapCtor: UpsertPrototype = Map,
  weakMapCtor: UpsertPrototype = WeakMap,
): string[] {
  const missing: string[] = [];
  for (const [ctor, label, methods] of [
    [mapCtor, "Map", MAP_METHODS],
    [weakMapCtor, "WeakMap", WEAK_MAP_METHODS],
  ] as const) {
    const prototype = ctor.prototype as Record<string, unknown>;
    for (const name of methods) {
      if (typeof prototype[name] !== "function") missing.push(`${label}.${name}`);
    }
  }
  return missing;
}

declare global {
  interface Map<K, V> {
    /** Returns the existing value for `key`, or inserts and returns `value`. */
    getOrInsert(key: K, value: V): V;
    /** Returns the existing value, or computes, inserts and returns a new one. */
    getOrInsertComputed(key: K, callback: (key: K) => V): V;
  }

  interface WeakMap<K extends object, V> {
    /** Returns the existing value for `key`, or inserts and returns `value`. */
    getOrInsert(key: K, value: V): V;
    /** Returns the existing value, or computes, inserts and returns a new one. */
    getOrInsertComputed(key: K, callback: (key: K) => V): V;
  }
}
