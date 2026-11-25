import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type FetchOptions,
  FileTransferError,
  type FileTransferOptions,
  type IPlatformService,
  setPlatformService,
} from "../services/platform";
import { DEFAULT_WEBDAV_REMOTE_ROOT, type WebDavConfig } from "./sync-backend";
import { WebDavBackend } from "./webdav-backend";
import { WebDavClient, WebDavError } from "./webdav-client";

function installFetchStub(
  handler: (url: string, options?: FetchOptions) => Response | Promise<Response>,
): void {
  setPlatformService({
    platformType: "web",
    isMobile: false,
    isDesktop: false,
    fetch: handler,
  } as unknown as IPlatformService);
}

function installTransferStub(options: {
  fetch: (url: string, options?: FetchOptions) => Response | Promise<Response>;
  uploadFile?: (url: string, filePath: string, options?: FileTransferOptions) => Promise<void>;
}): void {
  setPlatformService({
    platformType: "web",
    isMobile: false,
    isDesktop: false,
    fetch: options.fetch,
    uploadFile: options.uploadFile,
  } as unknown as IPlatformService);
}

function webDavConfig(): WebDavConfig {
  return {
    type: "webdav",
    url: "https://dav.example.com/dav",
    username: "alice",
    remoteRoot: DEFAULT_WEBDAV_REMOTE_ROOT,
    allowInsecure: false,
    autoSync: false,
    syncIntervalMins: 30,
    wifiOnly: false,
    notifyOnComplete: false,
  };
}

describe("WebDavBackend directory healing", () => {
  afterEach(() => {
    setPlatformService(null as unknown as IPlatformService);
  });

  it("putJSON creates the missing /readany/sync collection and retries instead of surfacing the 404", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      const method = String(options?.method ?? "GET");
      calls.push({ method, url });
      if (method === "PUT") {
        const putCount = calls.filter((call) => call.method === "PUT").length;
        return new Response("", { status: putCount === 1 ? 404 : 200 });
      }
      if (method === "PROPFIND") {
        return new Response("", { status: url.endsWith("/readany/") ? 207 : 404 });
      }
      if (method === "MKCOL") {
        return new Response("", { status: 201 });
      }
      return new Response("", { status: 404 });
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const backend = new WebDavBackend(webDavConfig(), "secret");
      await backend.putJSON("/readany/sync/device-abc.json", { deviceId: "abc" });
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
    expect(
      calls.some((call) => call.method === "MKCOL" && call.url.endsWith("/readany/sync/")),
    ).toBe(true);
  });

  it("putFile ensures the parent collection and retries once after a 409", async () => {
    const calls: { method: string; url: string }[] = [];
    let uploads = 0;
    installTransferStub({
      fetch: (url, options) => {
        const method = String(options?.method ?? "GET");
        calls.push({ method, url });
        if (method === "PROPFIND") return new Response("", { status: 404 });
        if (method === "MKCOL") return new Response("", { status: 201 });
        return new Response("", { status: 404 });
      },
      uploadFile: async (url) => {
        uploads++;
        if (uploads === 1) {
          throw new FileTransferError("File upload failed: 409", { status: 409, url });
        }
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const backend = new WebDavBackend(webDavConfig(), "secret");
      await backend.putFile("/readany/data/books/Book-1/Book.epub", "/tmp/book.epub");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(uploads).toBe(2);
    expect(
      calls.some(
        (call) =>
          call.method === "MKCOL" && call.url.endsWith("/readany/data/books/Book-1/"),
      ),
    ).toBe(true);
  });

  it("heals a localized 409 error by status instead of matching the message text", async () => {
    const backend = new WebDavBackend(webDavConfig(), "secret");
    const putSpy = vi
      .spyOn(WebDavClient.prototype, "put")
      .mockRejectedValueOnce(
        new WebDavError("http", "WebDAV 请求失败（409 Conflict），父集合不存在。", { status: 409 }),
      )
      .mockResolvedValueOnce(undefined);
    const ensureSpy = vi
      .spyOn(WebDavClient.prototype, "ensureDirectory")
      .mockResolvedValueOnce(undefined);

    let ensuredPath: string | undefined;
    let putCalls = 0;
    try {
      await backend.put("/readany/sync/device-abc.json", new Uint8Array([1]));
      ensuredPath = ensureSpy.mock.calls[0]?.[0];
      putCalls = putSpy.mock.calls.length;
    } finally {
      putSpy.mockRestore();
      ensureSpy.mockRestore();
    }

    expect(ensuredPath).toBe("/readany/sync");
    expect(putCalls).toBe(2);
  });

  it("does not create legacy file/cover collections during ensureDirectories", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      const method = String(options?.method ?? "GET");
      calls.push({ method, url });
      if (method === "PROPFIND") {
        return new Response("", { status: 404 });
      }
      if (method === "MKCOL") {
        return new Response("", { status: 201 });
      }
      return new Response("", { status: 404 });
    });

    const backend = new WebDavBackend(webDavConfig(), "secret");
    await backend.ensureDirectories();

    const mkcolUrls = calls.filter((call) => call.method === "MKCOL").map((call) => call.url);
    expect(mkcolUrls).toEqual([
      "https://dav.example.com/dav/readany/",
      "https://dav.example.com/dav/readany/sync/",
      "https://dav.example.com/dav/readany/data/",
      "https://dav.example.com/dav/readany/data/books/",
    ]);
  });
});
