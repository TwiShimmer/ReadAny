import { describe, expect, it } from "vitest";
import {
  findMissingMapUpsertApis,
  installMapUpsertPolyfill,
  installModernMapPolyfills,
  installWeakMapUpsertPolyfill,
} from "./modern-map";

/**
 * Fresh Map-like constructors per test. Sharing one prototype across tests
 * would leak an earlier install into later "missing method" assertions.
 */
function createMapClass() {
  return class FakeMap<K, V> {
    #data = new Map<K, V>();

    get size(): number {
      return this.#data.size;
    }

    has(key: K): boolean {
      return this.#data.has(key);
    }

    get(key: K): V | undefined {
      return this.#data.get(key);
    }

    set(key: K, value: V): this {
      this.#data.set(key, value);
      return this;
    }

    delete(key: K): boolean {
      return this.#data.delete(key);
    }
  };
}

function createWeakMapClass() {
  return class FakeWeakMap<K extends object, V> {
    #data = new WeakMap<K, V>();

    has(key: K): boolean {
      return this.#data.has(key);
    }

    get(key: K): V | undefined {
      return this.#data.get(key);
    }

    set(key: K, value: V): this {
      this.#data.set(key, value);
      return this;
    }

    delete(key: K): boolean {
      return this.#data.delete(key);
    }
  };
}

const ctorOf = (value: unknown) => value as { prototype: object };

describe("installMapUpsertPolyfill", () => {
  it("installs both methods on a constructor that lacks them", () => {
    const FakeMap = createMapClass();
    installMapUpsertPolyfill(ctorOf(FakeMap));
    const map = new FakeMap<string, number>();

    expect(typeof map.getOrInsert).toBe("function");
    expect(typeof map.getOrInsertComputed).toBe("function");
  });

  it("returns the existing value and does not overwrite it", () => {
    const FakeMap = createMapClass();
    installMapUpsertPolyfill(ctorOf(FakeMap));
    const map = new FakeMap<string, number>();
    map.set("a", 1);

    expect(map.getOrInsert("a", 2)).toBe(1);
    expect(map.get("a")).toBe(1);
  });

  it("inserts and returns the default value for a missing key", () => {
    const FakeMap = createMapClass();
    installMapUpsertPolyfill(ctorOf(FakeMap));
    const map = new FakeMap<string, number>();

    expect(map.getOrInsert("b", 7)).toBe(7);
    expect(map.get("b")).toBe(7);
  });

  it("computes only on a miss and passes the key", () => {
    const FakeMap = createMapClass();
    installMapUpsertPolyfill(ctorOf(FakeMap));
    const map = new FakeMap<string, string>();
    const seen: string[] = [];

    const first = map.getOrInsertComputed("x", (key) => {
      seen.push(key);
      return `value-${key}`;
    });
    const second = map.getOrInsertComputed("x", (key) => {
      seen.push(key);
      return "unexpected";
    });

    expect(first).toBe("value-x");
    expect(second).toBe("value-x");
    expect(seen).toEqual(["x"]);
  });

  it("calls the callback with an undefined receiver", () => {
    const FakeMap = createMapClass();
    installMapUpsertPolyfill(ctorOf(FakeMap));
    const map = new FakeMap<string, number>();
    let receiver: unknown = "not-called";

    map.getOrInsertComputed("x", function (this: unknown) {
      receiver = this;
      return 1;
    });

    expect(receiver).toBeUndefined();
  });

  it("rejects a non-callable callback before looking up the key", () => {
    const FakeMap = createMapClass();
    installMapUpsertPolyfill(ctorOf(FakeMap));
    const map = new FakeMap<string, number>();
    map.set("present", 1);

    expect(() =>
      (
        map as unknown as {
          getOrInsertComputed(key: string, callback: unknown): number;
        }
      ).getOrInsertComputed("present", 42),
    ).toThrow(TypeError);
  });

  it("rejects an incompatible receiver", () => {
    const FakeMap = createMapClass();
    installMapUpsertPolyfill(ctorOf(FakeMap));
    const prototype = FakeMap.prototype as unknown as {
      getOrInsert(this: unknown, key: string, value: number): number;
      getOrInsertComputed(this: unknown, key: string, callback: () => number): number;
    };

    expect(() => prototype.getOrInsert.call({}, "a", 1)).toThrow(TypeError);
    expect(() => prototype.getOrInsertComputed.call({}, "a", () => 1)).toThrow(TypeError);
  });

  it("does not overwrite a native implementation", () => {
    const FakeMap = createMapClass();
    const nativeGetOrInsert = () => "native";
    Object.defineProperty(FakeMap.prototype, "getOrInsert", {
      value: nativeGetOrInsert,
      configurable: true,
      writable: true,
    });

    installMapUpsertPolyfill(ctorOf(FakeMap));

    const map = new FakeMap<string, number>();
    expect(map.getOrInsert).toBe(nativeGetOrInsert);
  });

  it("is idempotent", () => {
    const FakeMap = createMapClass();
    installMapUpsertPolyfill(ctorOf(FakeMap));
    const map = new FakeMap<string, number>();
    const first = map.getOrInsert;

    installMapUpsertPolyfill(ctorOf(FakeMap));

    expect(map.getOrInsert).toBe(first);
  });
});

describe("installWeakMapUpsertPolyfill", () => {
  it("installs both methods and reuses existing values", () => {
    const FakeWeakMap = createWeakMapClass();
    installWeakMapUpsertPolyfill(ctorOf(FakeWeakMap));
    const key = {};
    const map = new FakeWeakMap<object, string>();
    map.set(key, "existing");

    expect(map.getOrInsert(key, "new")).toBe("existing");
    expect(
      map.getOrInsertComputed(key, () => {
        throw new Error("callback should not run");
      }),
    ).toBe("existing");
  });

  it("computes and stores a missing key once", () => {
    const FakeWeakMap = createWeakMapClass();
    installWeakMapUpsertPolyfill(ctorOf(FakeWeakMap));
    const key = {};
    const map = new FakeWeakMap<object, number>();
    let calls = 0;

    expect(
      map.getOrInsertComputed(key, () => {
        calls += 1;
        return 3;
      }),
    ).toBe(3);
    expect(map.getOrInsertComputed(key, () => 4)).toBe(3);
    expect(calls).toBe(1);
  });
});

describe("installModernMapPolyfills", () => {
  it("reports installed and skipped methods", () => {
    const FakeMap = createMapClass();
    const FakeWeakMap = createWeakMapClass();
    const result = installModernMapPolyfills(ctorOf(FakeMap), ctorOf(FakeWeakMap));

    expect(result.installed).toEqual([
      "Map.getOrInsert",
      "Map.getOrInsertComputed",
      "WeakMap.getOrInsert",
      "WeakMap.getOrInsertComputed",
    ]);
    expect(result.skipped).toEqual([]);

    const second = installModernMapPolyfills(ctorOf(FakeMap), ctorOf(FakeWeakMap));
    expect(second.installed).toEqual([]);
    expect(second.skipped).toEqual([
      "Map.getOrInsert",
      "Map.getOrInsertComputed",
      "WeakMap.getOrInsert",
      "WeakMap.getOrInsertComputed",
    ]);
  });

  it("finds missing APIs on an unpatched constructor", () => {
    const FakeMap = createMapClass();
    const FakeWeakMap = createWeakMapClass();

    expect(findMissingMapUpsertApis(ctorOf(FakeMap), ctorOf(FakeWeakMap))).toEqual([
      "Map.getOrInsert",
      "Map.getOrInsertComputed",
      "WeakMap.getOrInsert",
      "WeakMap.getOrInsertComputed",
    ]);
  });

  it("reports no missing APIs once installed", () => {
    const FakeMap = createMapClass();
    const FakeWeakMap = createWeakMapClass();
    installModernMapPolyfills(ctorOf(FakeMap), ctorOf(FakeWeakMap));

    expect(findMissingMapUpsertApis(ctorOf(FakeMap), ctorOf(FakeWeakMap))).toEqual([]);
  });
});
