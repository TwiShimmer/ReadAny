import { isDavMissingCollectionProbe, isDavMissingResponse } from "@readany/core/sync/dav-response";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { epubFixture } from "../../../../core/src/sync/__tests__/epub-fixture";

const { fetch, files, upload, url } = vi.hoisted(() => ({
  fetch: vi.fn<typeof globalThis.fetch>(),
  files: new Map<string, Uint8Array>(),
  upload: vi.fn(),
  url: "https://dav.example.com/books/book.epub",
}));

vi.mock("expo/fetch", () => ({ fetch }));
vi.mock("../../../modules/sync-file-transfer", () => ({ default: { upload } }));
vi.mock("expo-file-system/legacy", () => ({}));
vi.mock("expo-clipboard", () => ({}));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-network", () => ({}));
vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-sharing", () => ({}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(private readonly path: string) {}

    get exists() {
      return files.has(this.path);
    }

    get size() {
      return files.get(this.path)?.length ?? 0;
    }

    create() {
      files.set(this.path, new Uint8Array());
    }

    open() {
      const path = this.path;
      return {
        offset: 0,
        writeBytes(bytes: Uint8Array) {
          const contents = files.get(path) ?? new Uint8Array();
          const combined = new Uint8Array(contents.length + bytes.length);
          combined.set(contents);
          combined.set(bytes, contents.length);
          files.set(path, combined);
        },
        readBytes(count: number) {
          return files.get(path)?.slice(this.offset, this.offset + count) ?? new Uint8Array();
        },
        close() {},
      };
    }
  },
}));

const { ExpoPlatformService } = await import("./expo-platform-service");
const platform = new ExpoPlatformService();
const path = "/books/local.tmp";
const oldBook = Uint8Array.of(1, 2, 3);

function response(target: string, body: BodyInit | null, status = 200, type = "text/plain") {
  const result = new Response(body, { status, headers: { "Content-Type": type } });
  Object.defineProperty(result, "url", { value: target });
  return result;
}

describe("Expo WebDAV transport", () => {
  beforeEach(() => {
    fetch.mockReset();
    upload.mockReset();
    files.clear();
    files.set(path, oldBook);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([404, 410])(
    "does not treat disguised PROPFIND markup as empty for HTTP %s",
    async (status) => {
      const html = "<!-- gateway --><html>Log in</html>";
      fetch.mockResolvedValueOnce(response(url, html + " ".repeat(2000), status));

      const result = await platform.fetch(url, { method: "PROPFIND", redirect: "error" });

      expect(result.status).toBe(status);
      expect(await isDavMissingResponse(result)).toBe(false);
    },
  );

  it("preserves the rejection of a body when the snapshot Response is streamless", async () => {
    const html = "<!-- gateway --><html>Log in</html>";
    fetch.mockResolvedValueOnce(response(url, html, 404));
    vi.stubGlobal(
      "Response",
      class extends Response {
        get body() {
          return null;
        }
      },
    );

    const result = await platform.fetch(url, { method: "PROPFIND", redirect: "error" });
    expect(result.body).toBeNull();
    expect(await isDavMissingResponse(result)).toBe(false);
  });

  it.each(["PROPFIND", "GET"])(
    "does not turn an unreadable %s error into an empty response",
    async (method) => {
      const raw = response(url, "<html>Log in</html>", 404);
      Object.defineProperty(raw, "body", { value: null });
      const read = vi.spyOn(raw, "arrayBuffer");
      fetch.mockResolvedValueOnce(raw);

      const result = await platform.fetch(url, { method, redirect: "error" });
      expect(await isDavMissingResponse(result)).toBe(false);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(["PROPFIND", "GET"])("accepts an explicitly empty %s 404", async (method) => {
    const raw = response(url, null, 404);
    raw.headers.set("Content-Length", "0");
    fetch.mockResolvedValueOnce(raw);

    const result = await platform.fetch(url, { method, redirect: "error" });
    expect(await isDavMissingResponse(result)).toBe(true);
  });

  it("preserves plain 404 on the Expo snapshot for collection probes only", async () => {
    fetch.mockResolvedValueOnce(response(url, "Not Found", 404));
    const result = await platform.fetch(url, { method: "PROPFIND", redirect: "error" });
    expect(await isDavMissingCollectionProbe(result)).toBe(true);
    expect(await isDavMissingResponse(result)).toBe(false);
  });

  it("rejects an EPUB with only a mimetype entry", async () => {
    fetch.mockResolvedValueOnce(response(url, await epubFixture({ rootfile: "", opfPath: "" })));

    await expect(
      platform.downloadFile(url, "/books/staged.tmp", { rejectRedirects: true }),
    ).rejects.toMatchObject({ status: 200 });
  });

  it.each([
    [200, '{"error":"Login"}', "application/json"],
    [200, "<html>Login</html>", "text/plain"],
    [200, "Not a ZIP", "text/plain"],
    [207, "DAV multistatus", "application/xml"],
    [302, "Login", "text/plain"],
  ])("preserves the local book on HTTP %s with %s", async (status, body, type) => {
    fetch.mockResolvedValueOnce(response(url, body, status, type));

    await expect(platform.downloadFile(url, path, { rejectRedirects: true })).rejects.toMatchObject(
      {
        status,
      },
    );
    expect(files.get(path)).toBe(oldBook);
  });

  it("writes TXT that starts with an ordinary angle-bracket expression", async () => {
    const target = url.replace(/\.epub$/, ".txt");
    const body = "<chapter> is an ordinary text expression.";
    fetch.mockResolvedValueOnce(response(target, body));

    await platform.downloadFile(target, path, { rejectRedirects: true });

    expect(files.get(path)).toEqual(new TextEncoder().encode(body));
  });

  it("writes a valid EPUB and rejects a truncated archive", async () => {
    const zip = await epubFixture();
    fetch.mockResolvedValueOnce(response(url, zip));
    fetch.mockResolvedValueOnce(response(url, zip.subarray(0, 32)));

    await platform.downloadFile(url, path, { rejectRedirects: true });
    expect(files.get(path)).toEqual(zip);
    await expect(
      platform.downloadFile(url, "/books/staged.tmp", { rejectRedirects: true }),
    ).rejects.toMatchObject({ status: 200 });
  });

  it("validates deflated EPUB metadata and chapters without a native DecompressionStream", async () => {
    const text = Array.from({ length: 1024 }, (_, i) => `<p>Sample paragraph ${i}.</p>`).join("");
    // A chapter can exceed the OPF metadata limit without exceeding the spine limit.
    const chapter = `<html><body>${text.repeat(200)}</body></html>`;
    const bytes = await epubFixture({ mimeLevel: 6, chapter });
    fetch.mockResolvedValueOnce(response(url, bytes));
    vi.stubGlobal("DecompressionStream", undefined);
    const hermesPlatform = new ExpoPlatformService();

    await hermesPlatform.downloadFile(url, path, { rejectRedirects: true });
    expect(files.get(path)).toEqual(bytes);
  });

  it("aborts a timed-out fetch while reading its body", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    fetch.mockImplementationOnce(async (_target, options) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          options?.signal?.addEventListener("abort", () => {
            aborted();
            controller.error(options.signal?.reason);
          });
        },
      });
      return response(url, stream, 404);
    });
    const request = platform.fetch(url, { method: "PROPFIND", redirect: "error", timeoutMs: 50 });
    const result = request.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ message: "WebDAV request timed out" });
    expect(aborted).toHaveBeenCalledOnce();
  });

  it.each([200, 207, 302])("refuses a native upload response with HTTP %s", async (status) => {
    const destination = new URL(url);
    upload.mockResolvedValueOnce({
      status,
      url,
      location: status === 302 ? `${destination.origin}/login?token=private` : "",
      contentType: "text/plain",
      prefix: [...new TextEncoder().encode("<!-- gateway --><html>Log in</html>")],
    });

    await expect(platform.uploadFile(url, path, { rejectRedirects: true })).rejects.toMatchObject({
      status,
    });
  });
});
