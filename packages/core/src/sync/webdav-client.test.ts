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
  downloadFile?: (url: string, filePath: string, options?: FileTransferOptions) => Promise<void>;
}): void {
  setPlatformService({
    platformType: "web",
    isMobile: false,
    isDesktop: false,
    fetch: options.fetch,
    uploadFile: options.uploadFile,
    downloadFile: options.downloadFile,
  } as unknown as IPlatformService);
}

function collectionResponse(url: string): Response {
  return new Response(
    `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${new URL(url).pathname}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    { status: 207 },
  );
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
          <d:propstat><d:prop><d:resourcetype><d:collection /></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
        <d:response>
          <d:href>/dav/readany/sync/device-a.json</d:href>
          <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
        <d:response>
          <d:href>/dav/readany/sync/archive/</d:href>
          <d:propstat><d:prop><d:resourcetype><d:collection /></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
        <d:response>
          <d:href>/dav/readany/sync/archive/device-old.json</d:href>
          <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>99</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
        <d:response>
          <d:href>/dav/other/sync/device-foreign.json</d:href>
          <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>99</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
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
      return collectionResponse(url);
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
      return calls.length === 1 ? new Response("", { status: 404 }) : collectionResponse(url);
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
            <d:propstat><d:prop><d:resourcetype><d:collection /></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
          </d:response>
          <d:response>
            <d:href>/dav/readany/</d:href>
            <d:propstat><d:prop><d:resourcetype><d:collection /></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
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
      return collectionResponse(url);
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await client.safeReadDir("/readany/sync");

    expect(calls.map((call) => call.method)).toEqual(["PROPFIND"]);
    expect(calls.map((call) => call.url)).toEqual(["https://dav.example.com/dav/readany/sync/"]);
  });

  it.each([
    ["/dav/one/two/", "/dav/one%2Ftwo/"],
    ["/dav/one%2ftwo/", "/dav/one/two/"],
    ["/dav/one/two/", "/dav/one//two/"],
  ])("does not confirm %s with the propstat for %s", async (path, otherHref) => {
    installFetchStub(() => collectionResponse(`https://dav.example.com${otherHref}`));
    const client = new WebDavClient(
      `https://dav.example.com${path.slice(0, -1)}`,
      "alice",
      "secret",
    );

    await expect(client.ping()).rejects.toMatchObject({ kind: "unexpected-response", status: 207 });
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
    await client.get(path.replace(/\.epub$/, ".bin"));

    const expectedPath = path
      .replace(/\.epub$/, ".bin")
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

  it("heals a PUT 404 by recreating the parent collection and retrying once", async () => {
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

    expect(calls.map((call) => call.method)).toEqual(["PUT", "PROPFIND", "MKCOL", "PUT"]);
    expect(calls[2]?.url).toBe("https://dav.example.com/dav/readany/sync/");
    expect(calls[0]?.url).toBe("https://dav.example.com/dav/readany/sync/device-abc.json");
    expect(calls[3]?.url).toBe(calls[0]?.url);
  });

  it("heals an MKCOL 409 by creating only the collections that are missing", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      const method = String(options?.method ?? "GET");
      calls.push({ method, url });
      if (method === "PROPFIND") {
        return url.endsWith("/readany/")
          ? collectionResponse(url)
          : new Response("", { status: 404 });
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

    expect(calls.filter((call) => call.method === "MKCOL").map((call) => call.url)).toEqual([
      "https://dav.example.com/dav/readany/data/books/",
      "https://dav.example.com/dav/readany/data/",
      "https://dav.example.com/dav/readany/data/books/",
    ]);
  });

  it("does not retry a target MKCOL when only an ancestor was confirmed", async () => {
    const target = vi.fn(() => new Response(null, { status: 409 }));
    installFetchStub((url, options) => {
      const path = new URL(url).pathname;
      if (options?.method === "PROPFIND") {
        if (
          path === "/dav/ancestor/" &&
          (options.headers as Record<string, string>).Depth === "1"
        ) {
          return collectionResponse(url);
        }
        return new Response(null, { status: 404 });
      }
      if (path === "/dav/ancestor/") return new Response(null, { status: 201 });
      if (path === "/dav/ancestor/parent/") return new Response(null, { status: 405 });
      return target();
    });
    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");

    await expect(client.mkcol("/ancestor/parent/target")).rejects.toMatchObject({ status: 409 });
    expect(target).toHaveBeenCalledOnce();
  });

  it("keeps the collection URL when a conflict provides no evidence about the slash", async () => {
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
    await expect(client.mkcol("/readany/sync")).rejects.toMatchObject({ status: 409 });

    expect(calls.filter((call) => call.method === "MKCOL").map((call) => call.url)).toEqual([
      "https://dav.example.com/dav/readany/sync/",
      "https://dav.example.com/dav/readany/",
    ]);
  });

  it("does not retry a conflicted MKCOL when all ancestors already exist", async () => {
    const fetch = vi.fn((url: string, options?: FetchOptions) =>
      options?.method === "PROPFIND"
        ? collectionResponse(url)
        : new Response(null, { status: 409 }),
    );
    installFetchStub(fetch);
    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");

    await expect(client.mkcol("/readany/data/books")).rejects.toMatchObject({ status: 409 });
    expect(
      fetch.mock.calls.map(([url, options]) => [new URL(url).pathname, options?.method]),
    ).toEqual([
      ["/dav/readany/data/books/", "MKCOL"],
      ["/dav/readany/", "PROPFIND"],
      ["/dav/readany/data/", "PROPFIND"],
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

    const encodedParent =
      "/readany/data/books/%E8%BF%99%E9%87%8C%E6%98%AF%20%E7%BB%88%E6%9C%AB%20(1)/";
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

  it("does not cache a collection on an unconfirmed 405", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      const method = String(options?.method ?? "GET");
      calls.push({ method, url });
      if (method === "PROPFIND") return new Response("", { status: 404 });
      if (method === "MKCOL") return new Response("", { status: 405 });
      return new Response("", { status: 404 });
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await expect(client.ensureDirectory("/readany/data/books")).resolves.toBe(false);
    await expect(client.ensureDirectory("/readany/data/books")).resolves.toBe(false);

    expect(calls.filter((call) => call.method === "MKCOL")).toHaveLength(6);
  });

  it("does not treat a bare 301 as a successful MKCOL", async () => {
    installFetchStub((_url, options) => {
      const method = String(options?.method ?? "GET");
      if (method === "PROPFIND") return new Response("", { status: 404 });
      if (method === "MKCOL") {
        return new Response("", {
          status: 301,
          headers: { Location: "https://dav.example.com/login" },
        });
      }
      return new Response("", { status: 404 });
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await expect(client.ensureDirectory("/readany/data/books")).rejects.toMatchObject({
      status: 301,
    });
  });

  it("does not run directory self-healing for a 403 PUT", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      const method = String(options?.method ?? "GET");
      calls.push({ method, url });
      if (method === "PUT") return new Response("", { status: 403 });
      if (method === "PROPFIND") return new Response("", { status: 207 });
      return new Response("", { status: 201 });
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await expect(client.putJSON("/readany/sync/device.json", {})).rejects.toMatchObject({
      status: 403,
      kind: "forbidden",
    });
    expect(calls.filter((call) => call.method === "MKCOL")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("surfaces the original PUT error and keeps the heal failure as cause", async () => {
    const calls: { method: string; url: string }[] = [];
    installFetchStub((url, options) => {
      const method = String(options?.method ?? "GET");
      calls.push({ method, url });
      if (method === "PUT") return new Response("", { status: 404 });
      if (method === "MKCOL") return new Response("", { status: 403 });
      if (method === "PROPFIND") return new Response("", { status: 404 });
      return new Response("", { status: 404 });
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    const error = await client.putJSON("/readany/sync/device.json", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WebDavError);
    expect((error as WebDavError).status).toBe(404);
    expect((error as WebDavError).cause).toBeInstanceOf(WebDavError);
    expect(((error as WebDavError).cause as WebDavError).status).toBe(403);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("retries once when a streamed upload gets a 401 after successful auth", async () => {
    let uploads = 0;
    installTransferStub({
      fetch: (url, options) =>
        options?.method === "PROPFIND"
          ? collectionResponse(url)
          : new Response(null, { status: 201 }),
      uploadFile: async () => {
        uploads++;
        if (uploads === 1) {
          throw new FileTransferError("未授权", { status: 401 });
        }
      },
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await client.putFile("/readany/data/books/Book-1/Book.epub", "/tmp/Book.epub");

    expect(uploads).toBe(2);
  });

  it("caps streamed uploads at two attempts when 409 persists", async () => {
    let uploads = 0;
    const mkcolUrls: string[] = [];
    installTransferStub({
      fetch: (url, options) => {
        const method = String(options?.method ?? "GET");
        if (method === "MKCOL") {
          mkcolUrls.push(url);
          return new Response("", { status: 201 });
        }
        if (method === "PROPFIND")
          return uploads > 0 ? new Response(null, { status: 404 }) : collectionResponse(url);
        return new Response("", { status: 404 });
      },
      uploadFile: async (url) => {
        uploads++;
        throw new FileTransferError("文件上传失败（父目录不存在）", { status: 409, url });
      },
    });

    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await expect(
      client.putFile("/readany/data/books/Book-1/Book.epub", "/tmp/Book.epub"),
    ).rejects.toMatchObject({ status: 409 });

    expect(uploads).toBe(2);
    expect(mkcolUrls).toEqual(["https://dav.example.com/dav/readany/data/books/Book-1/"]);
  });

  it("rejects a followed login redirect even when the final response has status 200", async () => {
    const response = new Response("login", { status: 200 });
    Object.defineProperty(response, "url", {
      value: "https://fake-user@dav.example.com/login?session=example#token",
    });
    installFetchStub(() => response);
    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");

    await expect(client.putJSON("/chat/day.json", {})).rejects.toMatchObject({
      kind: "redirect",
      status: 200,
      cause: "https://dav.example.com/login",
    });
  });

  it.each([403, 404, 302])(
    "only continues past an inconclusive directory preflight (HTTP %s)",
    async (status) => {
      const uploadFile = vi.fn(async () => {});
      installTransferStub({
        fetch: (_url, options) =>
          new Response("", {
            status: options?.method === "MKCOL" ? status : 404,
            headers: { Location: "/login?session=example" },
          }),
        uploadFile,
      });
      const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
      const upload = client.putFile("/chat/photo.jpg", "/mock/photo.jpg");
      if (status === 403) {
        await expect(upload).resolves.toBeUndefined();
        expect(uploadFile).toHaveBeenCalledOnce();
      } else {
        await expect(upload).rejects.toMatchObject({ status, method: "MKCOL" });
        expect(uploadFile).not.toHaveBeenCalled();
      }
    },
  );

  it("does not retry a first 401 after an ordinary GET 200", async () => {
    const put = vi.fn(() => new Response("", { status: 401 }));
    installFetchStub((_url, options) =>
      options?.method === "GET" ? new Response("public") : put(),
    );
    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");

    await client.getText("/public");
    await expect(client.putJSON("/chat/day.json", {})).rejects.toMatchObject({ status: 401 });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 401, 401, 401],
    [429, 409, 503, 401],
  ])(
    "shares the four-PUT retry budget after DAV auth (HTTP %s, %s, %s, %s)",
    async (...statuses) => {
      vi.useFakeTimers();
      try {
        const writes: number[] = [];
        installFetchStub((url, options) => {
          if (options?.method === "PUT") {
            const status = statuses[writes.length] ?? 401;
            writes.push(status);
            return new Response("", { status });
          }
          if (options?.method === "MKCOL") return new Response("", { status: 201 });
          return url.endsWith("/chat/")
            ? new Response("", { status: 404 })
            : collectionResponse(url);
        });
        const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
        await client.ping();
        const result = expect(client.putJSON("/chat/day.json", {})).rejects.toMatchObject({
          status: 401,
        });
        await vi.runAllTimersAsync();
        await result;
        expect(writes).toEqual(statuses);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([404, 410])("lists a missing collection as empty (HTTP %s)", async (status) => {
    const fetch = vi.fn(() => new Response(null, { status, statusText: "Indisponible" }));
    installFetchStub(fetch);
    const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
    await expect(client.safeReadDir("/readany/sync")).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://dav.example.com/dav/readany/sync/",
      expect.objectContaining({ method: "PROPFIND" }),
    );
  });

  it.each(["application/xml", "text/plain"])(
    "rejects an XML error page disguised as a missing collection (%s)",
    async (contentType) => {
      installFetchStub(
        () =>
          new Response('<?xml version="1.0"?><error>Log in</error>', {
            status: 404,
            headers: { "Content-Type": contentType },
          }),
      );
      const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");

      await expect(client.safeReadDir("/readany/sync")).rejects.toMatchObject({
        kind: "unexpected-response",
        status: 404,
      });
    },
  );

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
      return collectionResponse(url);
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
it("uses the target href and the status of its resourcetype in a mixed 207", async () => {
  const fetch = vi.fn((url: string, options?: FetchOptions) => {
    if (options?.method === "PUT") return new Response(null, { status: 401 });
    const path = new URL(url).pathname;
    return new Response(
      `
        <d:multistatus xmlns:d="DAV:">
          <d:response><d:href>${path}other/</d:href><d:propstat>
            <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
          </d:propstat></d:response>
          <d:response><d:href>${path}</d:href>
            <d:propstat><d:prop><d:getetag>etag</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
            <d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat>
          </d:response>
        </d:multistatus>`,
      { status: 207 },
    );
  });
  installFetchStub(fetch);
  const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");

  await expect(client.ping("/root/")).rejects.toMatchObject({ status: 403 });
  await expect(client.safeReadDir("/root/")).rejects.toMatchObject({ status: 403 });
  await expect(client.putJSON("/root/day.json", {})).rejects.toMatchObject({ status: 401 });
  expect(fetch.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(1);
});

it.each([
  [200, "<!-- gateway branding -->\n<html>Login</html>", "unexpected-response"],
  [200, "<?xml version='1.0'?><login/>", "unexpected-response"],
  [302, "", "redirect"],
  [207, "", "unexpected-response"],
])("rejects an invalid PUT acknowledgement (HTTP %s, %s)", async (status, body, kind) => {
  const fetch = vi.fn(
    () => new Response(body, { status, headers: { "Content-Type": "text/plain" } }),
  );
  installFetchStub(fetch);
  const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");

  await expect(client.putJSON("/readany/sync/device.json", {})).rejects.toMatchObject({
    kind,
    status,
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it("accepts a normal PUT 204", async () => {
  installFetchStub(() => new Response(null, { status: 204 }));
  const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
  await expect(client.putJSON("/readany/sync/device.json", {})).resolves.toBeUndefined();
});
