import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type FetchOptions,
  FileTransferError,
  type FileTransferOptions,
  type IPlatformService,
  setPlatformService,
} from "../services/platform";
import { WebDavClient, WebDavError, sanitizeWebDavRemoteRoot } from "./webdav-client";

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

describe("WebDavClient PROPFIND parsing", () => {
  afterEach(() => {
    setPlatformService(null as unknown as IPlatformService);
  });

  it("keeps only direct children under the requested WebDAV path", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response>
          <d:href>/dav/readany/sync/</d:href>
          <d:propstat><d:prop><d:resourcetype><d:collection /></d:resourcetype></d:prop></d:propstat>
        </d:response>
        <d:response>
          <d:href>/dav/readany/sync/device-a.json</d:href>
          <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12</d:getcontentlength></d:prop></d:propstat>
        </d:response>
        <d:response>
          <d:href>/dav/readany/sync/archive/</d:href>
          <d:propstat><d:prop><d:resourcetype><d:collection /></d:resourcetype></d:prop></d:propstat>
        </d:response>
        <d:response>
          <d:href>/dav/readany/sync/archive/device-old.json</d:href>
          <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>99</d:getcontentlength></d:prop></d:propstat>
        </d:response>
        <d:response>
          <d:href>/dav/other/sync/device-foreign.json</d:href>
          <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>99</d:getcontentlength></d:prop></d:propstat>
        </d:response>
      </d:multistatus>`;

    installFetchStub(() => new Response(xml, { status: 207 }));

    const client = new WebDavClient("https://dav.example.com/dav/readany", "alice", "secret");
    const resources = await client.propfind("/sync");

    expect(resources).toEqual([
      {
        href: "/dav/readany/sync/device-a.json",
        name: "device-a.json",
        isCollection: false,
        contentLength: 12,
        lastModified: undefined,
        etag: undefined,
      },
      {
        href: "/dav/readany/sync/archive",
        name: "archive",
        isCollection: true,
        contentLength: undefined,
        lastModified: undefined,
        etag: undefined,
      },
    ]);
  });

  it("skips MKCOL when ensureDirectory sees the directory already exists", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      calls.push({ method: String(options?.method ?? "GET"), url });
      return new Response("", { status: 207 });
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await client.ensureDirectory("/readany");

    expect(calls.map((call) => call.method)).toEqual(["PROPFIND"]);
    expect(calls.map((call) => call.url)).toEqual(["https://dav.example.com/dav/readany/"]);
  });

  it("treats MKCOL network failure as success when the directory exists afterward", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      const method = String(options?.method ?? "GET");
      calls.push({ method, url });
      if (method === "MKCOL") {
        throw new Error("XHR request failed with status 0");
      }
      return new Response("", { status: calls.length === 1 ? 404 : 207 });
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
      await client.ensureDirectory("/readany");
    } finally {
      warnSpy.mockRestore();
    }

    expect(calls.map((call) => call.method)).toEqual(["PROPFIND", "MKCOL", "PROPFIND"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://dav.example.com/dav/readany/",
      "https://dav.example.com/dav/readany/",
      "https://dav.example.com/dav/readany/",
    ]);
  });

  it("treats MKCOL auth failure as success when the parent listing shows the directory", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      const method = String(options?.method ?? "GET");
      calls.push({ method, url });

      if (method === "PROPFIND" && url.endsWith("/readany/")) {
        return new Response("", { status: 404 });
      }
      if (method === "MKCOL") {
        return new Response("", { status: 401 });
      }
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:href>/dav/</d:href>
            <d:propstat><d:prop><d:resourcetype><d:collection /></d:resourcetype></d:prop></d:propstat>
          </d:response>
          <d:response>
            <d:href>/dav/readany/</d:href>
            <d:propstat><d:prop><d:resourcetype><d:collection /></d:resourcetype></d:prop></d:propstat>
          </d:response>
        </d:multistatus>`,
        { status: 207 },
      );
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
      await client.ensureDirectory("/readany");
    } finally {
      warnSpy.mockRestore();
    }

    expect(calls.map((call) => call.method)).toEqual(["PROPFIND", "MKCOL", "PROPFIND", "PROPFIND"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://dav.example.com/dav/readany/",
      "https://dav.example.com/dav/readany/",
      "https://dav.example.com/dav/readany/",
      "https://dav.example.com/dav/",
    ]);
  });

  it("uses a collection path when safely reading a directory", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      calls.push({ method: String(options?.method ?? "GET"), url });
      return new Response('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" />', {
        status: 207,
      });
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await client.safeReadDir("/readany/sync");

    expect(calls.map((call) => call.method)).toEqual(["PROPFIND"]);
    expect(calls.map((call) => call.url)).toEqual(["https://dav.example.com/dav/readany/sync/"]);
  });

  it("preserves remote root path casing while normalizing slashes", () => {
    expect(sanitizeWebDavRemoteRoot(" /Apps//ReadAny-Sync/ ")).toBe("Apps/ReadAny-Sync");
  });

  it("percent-encodes non-ASCII WebDAV request paths without adding path headers", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    installFetchStub((url, options) => {
      calls.push({
        url,
        headers: (options?.headers ?? {}) as Record<string, string>,
      });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    const path =
      "/ReadAnySync/data/books/这里是，终末停滞委员会。 [第一卷]/姉の彼女にキスをした.epub";
    await client.get(path);

    const expectedPath = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    expect(calls[0]?.url).toBe(`https://dav.example.com/dav${expectedPath}`);
    expect(Object.keys(calls[0]?.headers ?? {})).toEqual(["Authorization"]);
    expect(
      Object.values(calls[0]?.headers ?? {}).every((value) =>
        Array.from(value).every((char) => char.charCodeAt(0) <= 0x7f),
      ),
    ).toBe(true);
  });
});

describe("WebDavClient PUT/mkcol self-healing", () => {
  afterEach(() => {
    setPlatformService(null as unknown as IPlatformService);
  });

  it("heals a PUT 404 by force-creating the parent collection chain and retrying once", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      const method = String(options?.method ?? "GET");
      calls.push({ method, url });
      if (method === "PUT") {
        const putCount = calls.filter((call) => call.method === "PUT").length;
        return new Response("", { status: putCount === 1 ? 404 : 200 });
      }
      if (method === "MKCOL") {
        return new Response("", { status: 201 });
      }
      return new Response("", { status: 404 });
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
      await client.putJSON("/readany/sync/device-abc.json", { ok: true });
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(calls.map((call) => call.method)).toEqual(["PUT", "MKCOL", "MKCOL", "PUT"]);
    expect(calls[1]?.url).toBe("https://dav.example.com/dav/readany/");
    expect(calls[2]?.url).toBe("https://dav.example.com/dav/readany/sync/");
    expect(calls[0]?.url).toBe("https://dav.example.com/dav/readany/sync/device-abc.json");
    expect(calls[3]?.url).toBe(calls[0]?.url);
  });

  it("heals an MKCOL 409 by force-creating the whole collection chain", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      const method = String(options?.method ?? "GET");
      calls.push({ method, url });
      if (method === "PROPFIND") {
        return new Response("", { status: 207 });
      }
      if (method === "MKCOL") {
        const isBooksCall = url.endsWith("/readany/data/books/");
        const booksAttempts = calls.filter(
          (call) => call.method === "MKCOL" && call.url.endsWith("/readany/data/books/"),
        ).length;
        return new Response("", { status: isBooksCall && booksAttempts === 1 ? 409 : 201 });
      }
      return new Response("", { status: 404 });
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await client.mkcol("/readany/data/books");

    expect(calls.map((call) => call.method)).toEqual(["MKCOL", "MKCOL", "MKCOL", "MKCOL"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://dav.example.com/dav/readany/data/books/",
      "https://dav.example.com/dav/readany/",
      "https://dav.example.com/dav/readany/data/",
      "https://dav.example.com/dav/readany/data/books/",
    ]);
  });

  it("retries MKCOL without the trailing slash on servers that 409 collection URIs", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      const method = String(options?.method ?? "GET");
      calls.push({ method, url });
      if (method === "MKCOL") {
        return new Response("", { status: url.endsWith("/") ? 409 : 201 });
      }
      return new Response("", { status: 404 });
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await client.mkcol("/readany/sync");

    expect(calls.map((call) => call.method)).toEqual(["MKCOL", "MKCOL", "MKCOL", "MKCOL", "MKCOL"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://dav.example.com/dav/readany/sync/",
      "https://dav.example.com/dav/readany/",
      "https://dav.example.com/dav/readany",
      "https://dav.example.com/dav/readany/sync/",
      "https://dav.example.com/dav/readany/sync",
    ]);
  });

  it("ensures the parent collection before a file upload and retries a 409 once", async () => {
    const calls: { method: string; url: string }[] = [];
    let uploadAttempts = 0;
    installTransferStub({
      fetch: (url, options) => {
        const method = String(options?.method ?? "GET");
        calls.push({ method, url });
        if (method === "PROPFIND") {
          return new Response("", { status: 404 });
        }
        if (method === "MKCOL") {
          return new Response("", { status: 201 });
        }
        return new Response("", { status: 404 });
      },
      uploadFile: async (url) => {
        uploadAttempts++;
        calls.push({ method: "UPLOAD", url });
        if (uploadAttempts === 1) {
          // Localized message without the status digits: only `status` may
          // drive the recovery branch.
          throw new FileTransferError("文件上传失败（父目录不存在）", { status: 409, url });
        }
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
      const remotePath = "/readany/data/books/这里是 终末 (1)/正文.epub";
      await client.putFile(remotePath, "/tmp/正文.epub");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }

    const encodedParent = "/readany/data/books/%E8%BF%99%E9%87%8C%E6%98%AF%20%E7%BB%88%E6%9C%AB%20(1)/";
    const encodedFile = `${encodedParent}%E6%AD%A3%E6%96%87.epub`;
    const mkcolUrls = calls.filter((call) => call.method === "MKCOL").map((call) => call.url);
    const uploadUrls = calls.filter((call) => call.method === "UPLOAD").map((call) => call.url);

    expect(mkcolUrls).toContain(`https://dav.example.com/dav${encodedParent}`);
    expect(uploadAttempts).toBe(2);
    expect(uploadUrls).toEqual([
      `https://dav.example.com/dav${encodedFile}`,
      `https://dav.example.com/dav${encodedFile}`,
    ]);
    // The parent was ensured before the first upload attempt.
    expect(calls.findIndex((call) => call.method === "MKCOL")).toBeLessThan(
      calls.findIndex((call) => call.method === "UPLOAD"),
    );
  });

  it("treats a 405 or 301 MKCOL response as an existing collection", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      const method = String(options?.method ?? "GET");
      calls.push({ method, url });
      if (method === "PROPFIND") return new Response("", { status: 404 });
      if (method === "MKCOL") {
        return new Response("", { status: url.endsWith("/readany/") ? 301 : 405 });
      }
      return new Response("", { status: 404 });
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await expect(client.ensureDirectory("/readany/data/books")).resolves.toBeUndefined();

    expect(calls.filter((call) => call.method === "MKCOL")).toHaveLength(3);
  });

  it("handles a localized 404 by status instead of matching the message text", async () => {
    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    vi.spyOn(client, "propfind").mockRejectedValueOnce(
      new WebDavError("not-found", "WebDAV 地址或路径不存在，请检查服务器地址和根路径。", {
        status: 404,
      }),
    );
    const ensureSpy = vi.spyOn(client, "ensureDirectory").mockResolvedValueOnce();

    await expect(client.safeReadDir("/readany/sync")).resolves.toEqual([]);
    expect(ensureSpy).toHaveBeenCalledWith("/readany/sync/");
  });

  it("does not treat an unrelated localized error containing 404 as a missing collection", async () => {
    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    vi.spyOn(client, "propfind").mockRejectedValueOnce(
      new WebDavError("server", "服务器返回 404 之外的异常（500）", { status: 500 }),
    );

    await expect(client.safeReadDir("/readany/sync")).rejects.toMatchObject({ status: 500 });
  });

  it("getJSON returns null for a localized 404 response by status", async () => {
    installFetchStub(() => new Response("", { status: 404 }));
    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await expect(client.getJSON("/readany/sync/missing.json")).resolves.toBeNull();
  });

  it("getJSON returns null for 404 by status and rethrows other failures", async () => {
    installFetchStub(() => new Response("", { status: 404 }));
    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await expect(client.getJSON("/readany/sync/missing.json")).resolves.toBeNull();

    installFetchStub(() => new Response("", { status: 401 }));
    await expect(client.getJSON("/readany/sync/missing.json")).rejects.toThrow();
  });

  it("skips re-probing collections confirmed earlier in the same client", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      calls.push({ method: String(options?.method ?? "GET"), url });
      return new Response("", { status: 207 });
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await client.ensureDirectory("/readany");
    await client.ensureDirectory("/readany");

    expect(calls).toHaveLength(1);
  });
});

describe("sanitizeWebDavRemoteRoot", () => {
  it("preserves case because WebDAV paths can be case-sensitive", () => {
    expect(sanitizeWebDavRemoteRoot("ReadAny/DeviceSync")).toBe("ReadAny/DeviceSync");
  });

  it("trims unsafe path noise without lowercasing user folders", () => {
    expect(sanitizeWebDavRemoteRoot(" /\u0000ReadAny//Sync/ ")).toBe("ReadAny/Sync");
  });
});
