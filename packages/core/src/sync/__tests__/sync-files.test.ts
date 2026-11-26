import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FetchOptions,
  FileTransferError,
  type IPlatformService,
  setPlatformService,
} from "../../services/platform";
import { TxtToEpubConverter } from "../../utils/txt-to-epub";
import type { ISyncBackend, RemoteFile } from "../sync-backend";
import {
  REMOTE_BOOKS_ROOT,
  REMOTE_COVERS,
  REMOTE_FILES,
  REMOTE_FILE_MANIFEST,
} from "../sync-types";
import { WebDavBackend } from "../webdav-backend";
import { WebDavClient, WebDavError } from "../webdav-client";
import { epubFixture, epubPackageXml } from "./epub-fixture";

const mockAdapter = {
  getAppDataDir: vi.fn().mockResolvedValue("/appdata"),
  getTempDir: vi.fn().mockResolvedValue("/tmp"),
  joinPath: vi.fn((...segs: string[]) => segs.join("/")),
  fileExists: vi.fn(),
  hashFile: vi.fn().mockResolvedValue("local-hash"),
  readFileBytes: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  readFilePrefix: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  getFileSize: vi.fn().mockResolvedValue(null),
  maxBufferedTransferBytes: undefined as number | undefined,
  writeFileBytes: vi.fn(),
  copyFile: vi.fn(),
  replaceFile: vi.fn(),
  deleteFile: vi.fn(),
  ensureDir: vi.fn(),
  listFiles: vi.fn().mockResolvedValue([]),
};
vi.mock("../sync-adapter", () => ({
  getSyncAdapter: vi.fn(() => mockAdapter),
}));

const mockSelect = vi.fn();
const mockSetBookSyncStatus = vi.fn();
const mockUpdateBook = vi.fn();
vi.mock("../../db/database", () => ({
  getDB: vi.fn(async () => ({ select: mockSelect })),
  setBookSyncStatus: mockSetBookSyncStatus,
  updateBook: mockUpdateBook,
}));

const { syncFiles, downloadBookFile } = await import("../sync-files");

const epubBytes = await epubFixture();
const emptyOpf = '<package xmlns="http://www.idpf.org/2007/opf"/>';
const nestedOpfPath = "OPS/pkg/book.opf";
const nestedChapterPath = "OPS/text/chapter.xhtml";
const spineEntryLimit = 16 * 1024 * 1024;

function nestedEpub(href: string, chapterPath = nestedChapterPath) {
  return epubFixture({
    rootfile: nestedOpfPath,
    opfPath: nestedOpfPath,
    opf: epubPackageXml
      .replace("./chapter%20one.xhtml", href)
      .replace('href="toc.ncx"', 'href="../toc.ncx"'),
    chapterPath,
    ncxChapterHref: "text/chapter.xhtml",
  });
}

async function corruptChapter(bytes: Uint8Array<ArrayBuffer>, path: string, method = 8) {
  const zip = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const chapter = (await zip.getEntries()).find((entry) => entry.filename === path);
    if (!chapter || chapter.compressionMethod !== method) throw new Error("Unexpected ZIP chapter");
    const broken = bytes.slice();
    const view = new DataView(broken.buffer);
    const offset = chapter.offset;
    const dataOffset =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    // For Deflate, BTYPE=3 is invalid. For Stored data, change a byte without changing the size.
    // Only touch the chapter data, not any ZIP headers or checksums.
    broken[dataOffset] = method === 8 ? 0x07 : broken[dataOffset] ^ 1;
    return broken;
  } finally {
    await zip.close();
  }
}

function addSpineChapters(extraChapters: Array<[path: string, text: string]>) {
  const opf = epubPackageXml
    .replace(
      "</manifest>",
      `${extraChapters.map(([path], i) => `<item id="extra${i}" href="${path}" media-type="application/xhtml+xml"/>`).join("")}</manifest>`,
    )
    .replace(
      "</spine>",
      `${extraChapters.map((_, i) => `<itemref idref="extra${i}" linear="no"/>`).join("")}</spine>`,
    );
  return epubFixture({
    opf,
    extraChapters: extraChapters.map(([path, text]) => [`OPS/${path}`, text]),
  });
}

function largeChapter(bytes: number) {
  // Keep the compressed fixture small without triggering the existing ZIP compression-ratio limit.
  const paragraphs = Array.from({ length: 1024 }, (_, i) => `<p>Sample paragraph ${i}.</p>`).join(
    "",
  );
  const start = '<html xmlns="http://www.w3.org/1999/xhtml"><body>';
  const end = "</body></html>";
  const bodySize = bytes - start.length - end.length;
  const body = paragraphs.repeat(Math.floor(bodySize / paragraphs.length));
  return `${start}${body}${" ".repeat(bodySize - body.length)}${end}`;
}

const config = {
  type: "webdav",
  url: "https://dav.example.com/dav",
  username: "alice",
  autoSync: false,
  syncIntervalMins: 30,
  wifiOnly: false,
  notifyOnComplete: false,
} as const;

function davListing(...entries: Array<[path: string, collection: boolean]>): Response {
  return new Response(
    `<D:multistatus xmlns:D="DAV:">${entries
      .map(
        ([path, collection]) => `
      <D:response><D:href>${path}</D:href><D:propstat><D:prop>
      <D:resourcetype>${collection ? "<D:collection/>" : ""}</D:resourcetype>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      )
      .join("")}</D:multistatus>`,
    { status: 207 },
  );
}

function createMockBackend(overrides: Partial<ISyncBackend> = {}): ISyncBackend {
  return {
    type: "webdav",
    testConnection: vi.fn(),
    ensureDirectories: vi.fn(),
    put: vi.fn(),
    get: vi.fn().mockResolvedValue(epubBytes),
    getJSON: vi.fn(),
    putJSON: vi.fn(),
    listDir: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    move: vi.fn(),
    getDisplayName: vi.fn(),
    ...overrides,
  } as ISyncBackend;
}

describe("sync-files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockResolvedValue([]);
    mockAdapter.fileExists.mockResolvedValue(false);
    mockAdapter.listFiles.mockResolvedValue([]);
    mockAdapter.getFileSize.mockResolvedValue(epubBytes.length);
    mockAdapter.readFilePrefix.mockImplementation(
      async (_path: string, limit: number, offset = 0) =>
        epubBytes.subarray(offset, offset + limit),
    );
    mockAdapter.maxBufferedTransferBytes = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setPlatformService(null as unknown as IPlatformService);
  });

  describe("syncFiles", () => {
    it("returns zero counts when no books exist", async () => {
      mockSelect.mockResolvedValue([]);
      const backend = createMockBackend();

      const result = await syncFiles(backend);
      expect(result).toEqual({
        filesUploaded: 0,
        filesDownloaded: 0,
        filesUploadFailed: 0,
        filesDownloadFailed: 0,
        failures: [],
      });
    });

    it("uploads local book files to the new per-book layout when remote is empty", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Test Book",
        },
      ]);

      mockAdapter.fileExists.mockResolvedValue(true);

      const backend = createMockBackend({
        listDir: vi.fn().mockResolvedValue([]),
      });

      const result = await syncFiles(backend);
      expect(result.filesUploaded).toBe(1);
      expect(backend.put).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
        expect.any(Uint8Array),
      );
    });

    it("uses direct file upload when the backend supports it", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Test Book",
        },
      ]);

      mockAdapter.fileExists.mockResolvedValue(true);

      const backend = createMockBackend({
        listDir: vi.fn().mockResolvedValue([]),
        putFile: vi.fn().mockResolvedValue(undefined),
      });

      const result = await syncFiles(backend);
      expect(result.filesUploaded).toBe(1);
      expect(backend.putFile).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
        "/appdata/books/book-1.epub",
        expect.any(Function),
      );
      expect(mockAdapter.readFileBytes).not.toHaveBeenCalled();
      expect(backend.put).not.toHaveBeenCalled();
    });

    it("lets a streaming platform upload a 262 MB file without the buffered cap", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.pdf",
          file_hash: "h1",
          cover_url: null,
          title: "Huge PDF",
        },
      ]);

      mockAdapter.fileExists.mockResolvedValue(true);
      mockAdapter.getFileSize.mockResolvedValue(262 * 1024 * 1024);

      const backend = createMockBackend({
        listDir: vi.fn().mockResolvedValue([]),
        putFile: vi.fn().mockResolvedValue(undefined),
      });

      const result = await syncFiles(backend);
      expect(result.filesUploaded).toBe(1);
      expect(result.filesUploadFailed).toBe(0);
      expect(result.failures).toEqual([]);
      expect(backend.putFile).toHaveBeenCalledTimes(1);
      expect(mockAdapter.readFileBytes).not.toHaveBeenCalled();
      expect(backend.put).not.toHaveBeenCalled();
    });

    it("does not buffer oversized uploads when the platform sets a transfer limit", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Huge Book",
        },
      ]);

      mockAdapter.fileExists.mockResolvedValue(true);
      mockAdapter.getFileSize.mockResolvedValue(20 * 1024 * 1024);
      mockAdapter.maxBufferedTransferBytes = 16 * 1024 * 1024;

      const backend = createMockBackend({
        listDir: vi.fn().mockResolvedValue([]),
      });

      const result = await syncFiles(backend);
      expect(result.filesUploaded).toBe(0);
      expect(result.filesUploadFailed).toBe(1);
      expect(result.failures[0]?.path).toContain("Huge Book.epub");
      expect(result.failures[0]?.message).toContain("20.00 MB");
      expect(result.failures[0]?.message).toContain("16.00 MB");
      expect(mockAdapter.readFileBytes).not.toHaveBeenCalled();
      expect(backend.put).not.toHaveBeenCalled();
    });

    it("refuses to buffer an oversized upload when the platform sets no explicit limit", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.pdf",
          file_hash: "h1",
          cover_url: null,
          title: "Huge PDF",
        },
      ]);

      mockAdapter.fileExists.mockResolvedValue(true);
      mockAdapter.getFileSize.mockResolvedValue(262 * 1024 * 1024);
      mockAdapter.maxBufferedTransferBytes = undefined;

      const backend = createMockBackend({
        listDir: vi.fn().mockResolvedValue([]),
      });

      const result = await syncFiles(backend);
      expect(result.filesUploaded).toBe(0);
      expect(result.filesUploadFailed).toBe(1);
      expect(result.failures[0]?.path).toContain("Huge PDF.pdf");
      expect(result.failures[0]?.message).toContain("262.00 MB");
      expect(result.failures[0]?.message).toContain("256.00 MB");
      expect(mockAdapter.readFileBytes).not.toHaveBeenCalled();
      expect(backend.put).not.toHaveBeenCalled();
    });

    it("rejects buffered uploads of unknown size before reading bytes", async () => {
      mockSelect.mockResolvedValue([
        { id: "book-1", file_path: "books/book-1.epub", title: "Unknown", cover_url: null },
      ]);
      mockAdapter.fileExists.mockResolvedValue(true);
      mockAdapter.getFileSize.mockResolvedValue(null);
      const backend = createMockBackend();

      const result = await syncFiles(backend);

      expect(result.filesUploadFailed).toBe(1);
      expect(result.failures[0]?.message).toContain("256.00 MB");
      expect(result.failures[0]?.message).toContain("Unknown.epub");
      expect(mockAdapter.readFileBytes).not.toHaveBeenCalled();
      expect(backend.put).not.toHaveBeenCalled();
    });

    it("reports the first upload failure with path, message and status", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Denied Book",
        },
      ]);

      mockAdapter.fileExists.mockResolvedValue(true);
      mockAdapter.listFiles.mockRejectedValueOnce(new Error("Local cleanup unavailable"));
      const denied = Object.assign(new Error("WebDAV 访问被拒绝"), { status: 403 });
      const backend = createMockBackend({
        listDir: vi.fn().mockResolvedValue([]),
        put: vi.fn().mockRejectedValue(denied),
      });

      const result = await syncFiles(backend);
      expect(result.filesUploadFailed).toBe(1);
      expect(result.failures).toEqual([
        {
          path: `${REMOTE_BOOKS_ROOT}/Denied Book-book-1/Denied Book.epub`,
          message: expect.stringContaining("403"),
          status: 403,
        },
      ]);
    });

    it.each(["upload", "download"] as const)(
      "attributes out-of-order %s failures to the file that failed",
      async (operation) => {
        const isUpload = operation === "upload";
        const books = ["A", "B"].map((title) => ({
          id: `book-${title}`,
          title,
          file_path: `books/book-${title}.epub`,
          cover_url: null,
        }));
        const paths = books.map(
          ({ title, id }) => `${REMOTE_BOOKS_ROOT}/${title}-${id}/${title}.epub`,
        );
        mockSelect.mockResolvedValue(books);
        mockAdapter.fileExists.mockResolvedValue(isUpload);
        let finishFirst = () => {};
        const firstFinished = new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
        const denied = new WebDavError("forbidden", "Cannot access C:\\private\\book.epub", {
          status: 403,
        });
        const backend = createMockBackend({
          getJSON: vi.fn().mockResolvedValue({
            version: 1,
            generatedAt: 1,
            books: Object.fromEntries(
              books.map(({ title, id }, index) => [
                id,
                { folderName: `${title}-${id}`, filePath: paths[index] },
              ]),
            ),
          }),
          putFile: async (path) => {
            if (path === paths[1]) throw denied;
            await firstFinished;
          },
          getFileToPath: async (path) => {
            if (path === paths[1]) throw denied;
            await firstFinished;
          },
        });

        const result = await syncFiles(
          backend,
          (progress) => {
            if (progress.failure) finishFirst();
          },
          {
            concurrency: 2,
            forceUploadAll: isUpload,
            forceDownloadAll: !isUpload,
            downloadRemoteBooks: !isUpload,
          },
        );

        expect(isUpload ? result.filesUploaded : result.filesDownloaded).toBe(1);
        expect(isUpload ? result.filesUploadFailed : result.filesDownloadFailed).toBe(1);
        expect(result.failures).toEqual([
          { path: paths[1], status: 403, message: expect.stringContaining("403") },
        ]);
        expect(result.failures[0]?.message).not.toContain("private");
      },
    );

    it("migrates legacy files to the new layout via MOVE", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Test Book",
        },
      ]);

      // Local file is missing → downloadRemoteBooks default off, so this just verifies migration.
      mockAdapter.fileExists.mockResolvedValue(false);

      const legacyFiles: RemoteFile[] = [
        {
          name: "book-1.epub",
          path: `${REMOTE_FILES}/book-1.epub`,
          size: 100,
          lastModified: 1000,
          isDirectory: false,
        },
      ];
      const backend = createMockBackend({
        listDir: vi.fn().mockImplementation(async (path: string) => {
          if (path === REMOTE_FILES) return legacyFiles;
          return [];
        }),
        move: vi.fn().mockResolvedValue(undefined),
      });

      await syncFiles(backend);
      expect(backend.move).toHaveBeenCalledWith(
        `${REMOTE_FILES}/book-1.epub`,
        `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
      );
    });

    it("keeps the legacy book after a MOVE conflict even if the new path exists", async () => {
      mockSelect.mockResolvedValue([
        { id: "book-1", file_path: "books/book-1.epub", title: "Test Book", cover_url: null },
      ]);
      const legacy = `${REMOTE_FILES}/book-1.epub`;
      const backend = createMockBackend({
        listDir: vi.fn(async (path: string) =>
          path === REMOTE_FILES
            ? [
                {
                  path: legacy,
                  name: "book-1.epub",
                  size: 100,
                  lastModified: 0,
                  isDirectory: false,
                },
              ]
            : [],
        ),
        move: vi.fn().mockRejectedValue(new WebDavError("http", "MOVE conflict", { status: 412 })),
        exists: vi.fn().mockResolvedValue(true),
        get: vi.fn().mockRejectedValue(new Error("Target unreadable")),
      });
      const result = await syncFiles(backend, undefined, {
        forceDownloadAll: true,
        disableUploads: true,
      });
      expect(backend.move).toHaveBeenCalledOnce();
      expect(result.filesDownloadFailed).toBe(1);
      expect(backend.delete).not.toHaveBeenCalledWith(legacy);
    });

    it("downloads remote files from the new layout when forceDownloadAll is set", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Test Book",
        },
      ]);

      mockAdapter.fileExists.mockResolvedValue(false);

      const remoteBookDirs: RemoteFile[] = [
        {
          name: "Test Book-book-1",
          path: `${REMOTE_BOOKS_ROOT}/Test Book-book-1`,
          size: 0,
          lastModified: 0,
          isDirectory: true,
        },
      ];
      const folderContents: RemoteFile[] = [
        {
          name: "Test Book.epub",
          path: `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
          size: 100,
          lastModified: 1000,
          isDirectory: false,
        },
      ];

      const backend = createMockBackend({
        listDir: vi.fn().mockImplementation(async (path: string) => {
          if (path === REMOTE_BOOKS_ROOT) return remoteBookDirs;
          if (path === `${REMOTE_BOOKS_ROOT}/Test Book-book-1`) return folderContents;
          return [];
        }),
      });

      const result = await syncFiles(backend, undefined, {
        forceDownloadAll: true,
      });
      expect(result.filesDownloaded).toBe(1);
    });

    it("downloads the EPUB produced by desktop TXT conversion with a first, Stored mimetype", async () => {
      const converter = new TxtToEpubConverter();
      const { file } = await converter.convert({
        file: new File(["Chapter 1\n\nA paragraph.\n\nAnother paragraph."], "Novel & Stories.txt"),
      });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const zip = new ZipReader(new Uint8ArrayReader(bytes));
      try {
        const [first] = await zip.getEntries();
        expect(first).toMatchObject({ filename: "mimetype", offset: 0, compressionMethod: 0 });
      } finally {
        await zip.close();
      }

      setPlatformService({
        fetch: vi.fn(() => new Response(bytes)),
      } as unknown as IPlatformService);
      const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
      await expect(client.get("/books/Novel.epub")).resolves.toEqual(bytes);
    });

    it.each([
      { name: "buffered HTML", body: "<!-- sign in --><html>Login</html>" },
      { name: "staged native HTML", body: "<!-- sign in --><html>Login</html>", native: true },
      { name: "redirect", body: "<html>Login</html>", status: 302 },
      { name: "buffered 200 JSON", body: '{"error":"Login"}', mime: "application/json" },
      { name: "staged native 200 JSON", body: '{"error":"Login"}', native: true },
      { name: "buffered non-ZIP EPUB", body: "Not a ZIP" },
      { name: "staged truncated EPUB", body: epubBytes.subarray(0, 32), native: true },
      { name: "buffered empty ZIP", body: Uint8Array.of(80, 75, 5, 6, ...Array(18).fill(0)) },
      {
        name: "buffered mimetype-only ZIP without a hash",
        body: epubFixture({ rootfile: "", opfPath: "" }),
      },
      {
        name: "staged ZIP missing container.xml without a hash",
        body: epubFixture({ rootfile: "" }),
        native: true,
      },
      {
        name: "buffered ZIP with a missing rootfile",
        body: epubFixture({ rootfile: "OPS/missing.opf" }),
      },
      {
        name: "staged ZIP with a traversing rootfile",
        body: epubFixture({ rootfile: "../book.opf", opfPath: "../book.opf" }),
        native: true,
      },
      {
        name: "staged EPUB with the wrong mimetype",
        body: epubFixture({ mime: "application/zip" }),
        native: true,
      },
      { name: "EPUB without rootfile media-type", body: epubFixture({ rootfileMediaType: "" }) },
      { name: "EPUB with an empty OPF", body: epubFixture({ opf: emptyOpf }), native: true },
      {
        name: "EPUB without metadata",
        body: epubFixture({
          opf: epubPackageXml.replace(/<metadata[^>]*>[\s\S]*?<\/metadata>/, ""),
        }),
      },
      {
        name: "EPUB with an empty manifest",
        body: epubFixture({
          opf: epubPackageXml.replace(/<manifest>[\s\S]*?<\/manifest>/, "<manifest/>"),
        }),
      },
      {
        name: "EPUB with an empty spine",
        body: epubFixture({ opf: epubPackageXml.replace('<itemref idref="chapter"/>', "") }),
      },
      {
        name: "EPUB with a dangling spine idref",
        body: epubFixture({ opf: epubPackageXml.replace('idref="chapter"', 'idref="missing"') }),
      },
      {
        name: "EPUB with a missing manifest resource",
        body: epubFixture({ opf: epubPackageXml.replace('href="toc.ncx"', 'href="missing.ncx"') }),
      },
      { name: "EPUB with an empty chapter", body: epubFixture({ chapter: "" }) },
      {
        name: "EPUB with a missing spine chapter",
        body: epubFixture({ chapterPath: "OPS/other.xhtml" }),
      },
      {
        name: "EPUB with a corrupt Deflate chapter and intact ZIP headers (buffered)",
        body: corruptChapter(epubBytes, "OPS/chapter one.xhtml"),
      },
      {
        name: "EPUB with a corrupt Deflate chapter and intact ZIP headers (native)",
        body: corruptChapter(epubBytes, "OPS/chapter one.xhtml"),
        native: true,
      },
      {
        name: "EPUB with a corrupt second, non-linear chapter",
        body: addSpineChapters([["second.xhtml", "<html><body>Second chapter</body></html>"]]).then(
          (bytes) => corruptChapter(bytes, "OPS/second.xhtml"),
        ),
      },
      {
        name: "EPUB with a mismatched chapter CRC",
        body: epubFixture({ chapterLevel: 0 }).then((bytes) =>
          corruptChapter(bytes, "OPS/chapter one.xhtml", 0),
        ),
      },
      {
        name: "EPUB with only NCX in the spine",
        body: epubFixture({ opf: epubPackageXml.replace('idref="chapter"', 'idref="ncx"') }),
      },
      {
        name: "EPUB with an oversized chapter",
        body: epubFixture({ chapter: largeChapter(spineEntryLimit + 1) }),
      },
      {
        name: "EPUB with oversized combined spine resources",
        body: (() => {
          const chapter = largeChapter(spineEntryLimit);
          return addSpineChapters(
            Array.from({ length: 8 }, (_, i) => [`extra${i}.xhtml`, chapter]),
          );
        })(),
      },
      {
        name: "EPUB with percent-encoded traversal beyond the ZIP root",
        body: epubFixture({
          opf: epubPackageXml.replace(
            "./chapter%20one.xhtml",
            "%2e%2e/%2e%2e/OPS/chapter%20one.xhtml",
          ),
        }),
      },
      {
        name: "EPUB with an absolute chapter path",
        body: nestedEpub("/OPS/text/chapter.xhtml"),
      },
      {
        name: "EPUB with a parent-relative chapter",
        body: nestedEpub("../text/chapter.xhtml"),
        valid: true,
      },
      {
        name: "EPUB with a parent-relative chapter using the wrong case",
        body: nestedEpub("../Text/chapter.xhtml"),
      },
      {
        name: "EPUB with a parent-relative chapter using Windows separators",
        body: nestedEpub("..\\text\\chapter.xhtml"),
      },
      {
        name: "EPUB with a parent-relative chapter path that escapes the root",
        body: epubFixture({
          opf: epubPackageXml.replace("./chapter%20one.xhtml", "../../outside"),
          chapterPath: "outside",
        }),
      },
      {
        name: "EPUB with an embedded traversal that escapes the root",
        body: epubFixture({
          opfPath: "book.opf",
          rootfile: "book.opf",
          opf: epubPackageXml
            .replace("./chapter%20one.xhtml", "OPS/../../outside")
            .replace('href="toc.ncx"', 'href="OPS/toc.ncx"'),
          chapterPath: "outside",
        }),
      },
      {
        name: "historical Deflate mimetype with an empty OPF",
        body: epubFixture({ mimeLevel: 6, opf: emptyOpf }),
      },
      {
        name: "historical Deflate mimetype with a complete OPF",
        body: epubFixture({ mimeLevel: 6 }),
        valid: true,
      },
      { name: "buffered TXT", body: "<chapter> is the title.\n", ext: "txt", valid: true },
      {
        name: "staged native TXT",
        body: "<chapter> is the title.\n",
        ext: "txt",
        native: true,
        valid: true,
      },
      { name: "buffered EPUB", body: epubBytes, valid: true },
      { name: "staged native EPUB", body: epubBytes, native: true, valid: true },
      { name: "mismatched book hash", body: epubBytes, hash: "a".repeat(64) },
      { name: "matching book hash", body: epubBytes, hash: "b".repeat(64), valid: true },
      {
        name: "source hash for a converted TXT",
        body: epubBytes,
        hash: "a".repeat(64),
        format: "txt",
        valid: true,
      },
    ])(
      "validates a forced $name download before changing the local book and status",
      async ({
        body,
        ext = "epub",
        format = ext,
        hash,
        native,
        status = 200,
        mime = "text/plain",
        valid = false,
      }) => {
        const localPath = `/appdata/books/book-1.${ext}`;
        const oldBytes = new Uint8Array([1, 2, 3]);
        const bytes = typeof body === "string" ? new TextEncoder().encode(body) : await body;
        const files = new Map([[localPath, oldBytes]]);
        mockAdapter.fileExists.mockImplementation(async (path: string) => files.has(path));
        mockAdapter.writeFileBytes.mockImplementation(
          async (path: string, bytes: Uint8Array<ArrayBuffer>) => {
            files.set(path, bytes);
          },
        );
        const replaceFile = async (source: string, destination: string) => {
          const bytes = files.get(source);
          if (!bytes) throw new Error("Missing staged test file");
          files.set(destination, bytes);
        };
        mockAdapter.replaceFile.mockImplementation(replaceFile);
        mockAdapter.copyFile.mockImplementation(replaceFile);
        mockAdapter.readFilePrefix.mockImplementation(
          async (path: string, limit: number, offset = 0) =>
            files.get(path)?.subarray(offset, offset + limit),
        );
        mockAdapter.getFileSize.mockImplementation(
          async (path: string) => files.get(path)?.length ?? null,
        );
        mockAdapter.hashFile.mockResolvedValue("b".repeat(64));
        mockAdapter.deleteFile.mockImplementation(async (path: string) => files.delete(path));
        mockSelect.mockResolvedValue([
          {
            id: "book-1",
            file_path: `books/book-1.${ext}`,
            file_hash: hash ?? "h1",
            format,
            cover_url: null,
            title: "Test Book",
            sync_status: "remote",
          },
        ]);

        setPlatformService({
          fetch: vi.fn(
            async () =>
              new Response(bytes, {
                status,
                headers: { "Content-Type": mime, Location: "/login" },
              }),
          ),
        } as unknown as IPlatformService);
        const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");
        const backend = createMockBackend({
          get: client.get.bind(client),
          ...(native && {
            getFileToPath: async (_remotePath: string, path: string) => {
              files.set(path, bytes);
            },
          }),
          getJSON: vi.fn().mockResolvedValue({
            version: 1,
            generatedAt: 1000,
            books: {
              "book-1": {
                folderName: "Test Book-book-1",
                filePath: `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.${ext}`,
                fileSize: 100,
              },
            },
          }),
        });

        try {
          const result = await syncFiles(backend, undefined, {
            forceDownloadAll: true,
            disableUploads: true,
          });
          if (valid) expect(result.failures).toEqual([]);
          expect(result.filesDownloaded).toBe(valid ? 1 : 0);
          expect(result.filesDownloadFailed).toBe(valid ? 0 : 1);
          expect(files).toEqual(new Map([[localPath, valid ? bytes : oldBytes]]));
          if (valid) expect(mockSetBookSyncStatus).toHaveBeenCalledWith("book-1", "local");
          else expect(mockSetBookSyncStatus).not.toHaveBeenCalled();
          expect(mockUpdateBook).not.toHaveBeenCalled();
          expect(mockAdapter.deleteFile).not.toHaveBeenCalledWith(localPath);
        } finally {
          for (const method of [
            mockAdapter.writeFileBytes,
            mockAdapter.replaceFile,
            mockAdapter.copyFile,
            mockAdapter.deleteFile,
          ]) {
            method.mockReset();
          }
          mockAdapter.readFilePrefix.mockReset();
          mockAdapter.getFileSize.mockReset();
          mockAdapter.hashFile.mockReset().mockResolvedValue("local-hash");
        }
      },
      20_000, // The aggregate-budget fixture compresses 128 MiB of chapter data.
    );

    it("uses the remote file manifest for downloads without scanning remote directories", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Test Book",
        },
      ]);

      mockAdapter.fileExists.mockResolvedValue(false);

      const backend = createMockBackend({
        getJSON: vi.fn().mockResolvedValue({
          version: 1,
          generatedAt: 1000,
          books: {
            "book-1": {
              folderName: "Test Book-book-1",
              filePath: `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
            },
          },
        }),
        listDir: vi.fn().mockResolvedValue([]),
      });

      const result = await syncFiles(backend, undefined, {
        forceDownloadAll: true,
      });

      expect(result.filesDownloaded).toBe(1);
      expect(backend.getJSON).toHaveBeenCalledWith(REMOTE_FILE_MANIFEST);
      expect(backend.listDir).not.toHaveBeenCalled();
      expect(backend.get).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
      );
    });

    it("falls back to a remote scan when the manifest is missing needed download data", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Test Book",
        },
      ]);

      mockAdapter.fileExists.mockResolvedValue(false);

      const remoteBookDirs: RemoteFile[] = [
        {
          name: "Test Book-book-1",
          path: `${REMOTE_BOOKS_ROOT}/Test Book-book-1`,
          size: 0,
          lastModified: 0,
          isDirectory: true,
        },
      ];
      const folderContents: RemoteFile[] = [
        {
          name: "Test Book.epub",
          path: `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
          size: 100,
          lastModified: 1000,
          isDirectory: false,
        },
      ];

      const backend = createMockBackend({
        getJSON: vi.fn().mockResolvedValue({
          version: 1,
          generatedAt: 1000,
          books: {},
        }),
        listDir: vi.fn().mockImplementation(async (path: string) => {
          if (path === REMOTE_BOOKS_ROOT) return remoteBookDirs;
          if (path === `${REMOTE_BOOKS_ROOT}/Test Book-book-1`) return folderContents;
          return [];
        }),
      });

      const result = await syncFiles(backend, undefined, {
        downloadRemoteBooks: true,
      });

      expect(result.filesDownloaded).toBe(1);
      expect(backend.listDir).toHaveBeenCalledWith(REMOTE_BOOKS_ROOT);
      expect(backend.get).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
      );
    });

    it("uploads a local file and writes it into the manifest without scanning remote directories", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Test Book",
        },
      ]);

      mockAdapter.fileExists.mockResolvedValue(true);

      const backend = createMockBackend({
        getJSON: vi.fn().mockResolvedValue({
          version: 1,
          generatedAt: 1000,
          books: {},
        }),
        listDir: vi.fn().mockResolvedValue([]),
      });

      const result = await syncFiles(backend);

      expect(result.filesUploaded).toBe(1);
      expect(backend.listDir).not.toHaveBeenCalled();
      expect(backend.put).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
        expect.any(Uint8Array),
      );
      expect(backend.putJSON).toHaveBeenCalledWith(
        REMOTE_FILE_MANIFEST,
        expect.objectContaining({
          version: 1,
          books: {
            "book-1": expect.objectContaining({
              folderName: "Test Book-book-1",
              filePath: `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
            }),
          },
        }),
      );
    });

    it("uses direct file download when the backend supports it", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Test Book",
        },
      ]);

      mockAdapter.fileExists.mockResolvedValue(false);

      const remoteBookDirs: RemoteFile[] = [
        {
          name: "Test Book-book-1",
          path: `${REMOTE_BOOKS_ROOT}/Test Book-book-1`,
          size: 0,
          lastModified: 0,
          isDirectory: true,
        },
      ];
      const folderContents: RemoteFile[] = [
        {
          name: "Test Book.epub",
          path: `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
          size: 100,
          lastModified: 1000,
          isDirectory: false,
        },
      ];

      const backend = createMockBackend({
        getFileToPath: vi.fn().mockResolvedValue(undefined),
        listDir: vi.fn().mockImplementation(async (path: string) => {
          if (path === REMOTE_BOOKS_ROOT) return remoteBookDirs;
          if (path === `${REMOTE_BOOKS_ROOT}/Test Book-book-1`) return folderContents;
          return [];
        }),
      });

      const result = await syncFiles(backend, undefined, {
        forceDownloadAll: true,
      });

      expect(result.filesDownloaded).toBe(1);
      expect(backend.getFileToPath).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
        expect.stringMatching(/^\/appdata\/books\/\.readany-transfer-.*\.tmp$/),
        expect.any(Function),
      );
      expect(mockAdapter.replaceFile).toHaveBeenCalledWith(
        expect.stringMatching(/^\/appdata\/books\/\.readany-transfer-.*\.tmp$/),
        "/appdata/books/book-1.epub",
      );
      expect(mockAdapter.writeFileBytes).not.toHaveBeenCalled();
      expect(backend.get).not.toHaveBeenCalled();
    });

    it("marks books as remote when local file missing and remote exists in new layout", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Remote Book",
        },
      ]);

      mockAdapter.fileExists.mockResolvedValue(false);

      const remoteBookDirs: RemoteFile[] = [
        {
          name: "Remote Book-book-1",
          path: `${REMOTE_BOOKS_ROOT}/Remote Book-book-1`,
          size: 0,
          lastModified: 0,
          isDirectory: true,
        },
      ];
      const folderContents: RemoteFile[] = [
        {
          name: "Remote Book.epub",
          path: `${REMOTE_BOOKS_ROOT}/Remote Book-book-1/Remote Book.epub`,
          size: 100,
          lastModified: 1000,
          isDirectory: false,
        },
      ];

      const backend = createMockBackend({
        listDir: vi.fn().mockImplementation(async (path: string) => {
          if (path === REMOTE_BOOKS_ROOT) return remoteBookDirs;
          if (path === `${REMOTE_BOOKS_ROOT}/Remote Book-book-1`) return folderContents;
          return [];
        }),
      });

      await syncFiles(backend);
      expect(mockSetBookSyncStatus).toHaveBeenCalledWith("book-1", "remote");
    });

    it("reports progress via callback", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Test",
        },
      ]);
      mockAdapter.fileExists.mockResolvedValue(true);

      const backend = createMockBackend({
        listDir: vi.fn().mockResolvedValue([]),
      });
      const onProgress = vi.fn();

      await syncFiles(backend, onProgress);

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "files",
          operation: "upload",
        }),
      );
    });

    it("reports direct transfer byte progress", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Test",
        },
      ]);
      mockAdapter.fileExists.mockResolvedValue(true);

      const backend = createMockBackend({
        listDir: vi.fn().mockResolvedValue([]),
        putFile: vi.fn(async (_remotePath, _localPath, onProgress) => {
          onProgress?.(50, 100);
        }),
      });
      const onProgress = vi.fn();

      await syncFiles(backend, onProgress);

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "files",
          operation: "upload",
          completedFiles: 0,
          totalFiles: 1,
          currentBytes: 50,
          totalBytes: 100,
        }),
      );
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "files",
          operation: "upload",
          completedFiles: 1,
          totalFiles: 1,
        }),
      );
    });

    it("does not rewrite the remote file manifest when it is unchanged", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: null,
          title: "Test Book",
        },
      ]);
      mockAdapter.fileExists.mockResolvedValue(true);

      const manifest = {
        version: 1 as const,
        generatedAt: 1000,
        books: {
          "book-1": {
            folderName: "Test Book-book-1",
            filePath: `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
            updatedAt: 1000,
          },
        },
      };
      const backend = createMockBackend({
        getJSON: vi.fn().mockResolvedValue(manifest),
        listDir: vi.fn().mockResolvedValue([]),
      });

      const result = await syncFiles(backend);

      expect(result.filesUploaded).toBe(0);
      expect(backend.listDir).not.toHaveBeenCalled();
      expect(backend.putJSON).not.toHaveBeenCalledWith(REMOTE_FILE_MANIFEST, expect.anything());
    });

    it.each([false, true])(
      "handles a legacy directory 404 during file scanning (HTML: %s)",
      async (html) => {
        const fetch = vi.fn((url: string, options?: FetchOptions) => {
          const path = new URL(url).pathname;
          if (options?.method === "GET")
            return new Response(null, { status: 404, headers: { "Content-Length": "0" } });
          if (path === `/dav${REMOTE_FILES}/` || path === `/dav${REMOTE_COVERS}/`) {
            return new Response(html ? "<html>Login</html>" : "Not Found", {
              status: 404,
              headers: { "Content-Type": html ? "text/html" : "text/plain" },
            });
          }
          return davListing([path, true]);
        });
        setPlatformService({ fetch } as unknown as IPlatformService);
        const sync = syncFiles(new WebDavBackend(config, "secret"));
        if (html)
          await expect(sync).rejects.toMatchObject({ kind: "unexpected-response", status: 404 });
        else
          await expect(sync).resolves.toMatchObject({
            filesUploadFailed: 0,
            filesDownloadFailed: 0,
          });
        expect(
          fetch.mock.calls.filter(([, options]) => options?.method === "PROPFIND"),
        ).toHaveLength(3);
      },
    );

    it.each(["empty", "encoded child", "unverifiable", "new child", "initially empty"])(
      "keeps the former WebDAV collection without a recursive DELETE (%s)",
      async (remaining) => {
        mockSelect.mockResolvedValue([
          {
            id: "book-1",
            file_path: "books/book-1.epub",
            title: "New Title",
          },
        ]);
        let moved = false;
        let oldCollectionExists = true;
        const root = `/dav${REMOTE_BOOKS_ROOT}/`;
        const oldDir = `${root}Old%20Title-book-1/`;
        const source = `${oldDir}Old%20Title.epub`;
        const fetch = vi.fn((url: string, options?: FetchOptions) => {
          const path = new URL(url).pathname;
          switch (options?.method) {
            case "GET":
              return new Response(null, { status: 404, headers: { "Content-Length": "0" } });
            case "PROPFIND": {
              if (path === root && new Headers(options.headers).get("Depth") === "1")
                return davListing([root, true], [oldDir, true]);
              if (path !== oldDir) return davListing([path, true]);
              if (moved && remaining === "unverifiable")
                return new Response("<html>Login</html>", { status: 404 });
              const entries: Array<[string, boolean]> = [[oldDir, true]];
              if (!moved && remaining !== "initially empty") entries.push([source, false]);
              if (remaining === "encoded child") entries.push([`${oldDir}extra%2Fdata`, false]);
              if (moved && remaining === "new child") entries.push([`${oldDir}new.txt`, false]);
              return davListing(...entries);
            }
            case "MOVE":
              expect(path).toBe(source);
              moved = true;
              return new Response(null, { status: 201 });
            case "DELETE":
              if (path === oldDir.slice(0, -1)) oldCollectionExists = false;
              return new Response(null, { status: 204 });
            case "PUT":
              return new Response(null, { status: 201 });
            default:
              throw new Error(`Unexpected method ${options?.method}`);
          }
        });
        setPlatformService({ fetch } as unknown as IPlatformService);
        const backend = new WebDavBackend(config, "secret");
        await syncFiles(backend, undefined, { disableUploads: true });
        expect(moved).toBe(remaining !== "initially empty");
        expect(oldCollectionExists).toBe(true);
        const deletes = fetch.mock.calls.filter(([, options]) => options?.method === "DELETE");
        expect(deletes).toEqual([]);
      },
    );

    it.each([true, false])(
      "prefers the current WebDAV collection on a later scan after MOVE (force download: %s)",
      async (forceDownloadAll) => {
        mockSelect.mockResolvedValue([
          { id: "book-1", file_path: "books/book-1.epub", title: "New Title" },
        ]);
        mockAdapter.fileExists.mockResolvedValue(true);

        let moved = false;
        const root = `/dav${REMOTE_BOOKS_ROOT}/`;
        const oldDir = `${root}Old%20Title-book-1/`;
        const currentDir = `${root}New%20Title-book-1/`;
        const source = `${oldDir}Old%20Title.epub`;
        const target = `${currentDir}New%20Title.epub`;
        const fetch = vi.fn((url: string, options?: FetchOptions) => {
          const path = new URL(url).pathname;
          switch (options?.method) {
            case "GET":
              if (path === target && moved) return new Response(epubBytes);
              return new Response(null, { status: 404, headers: { "Content-Length": "0" } });
            case "PROPFIND":
              if (path === root)
                return moved
                  ? davListing([root, true], [oldDir, true], [currentDir, true])
                  : davListing([root, true], [oldDir, true]);
              if (path === oldDir)
                return moved
                  ? davListing([oldDir, true])
                  : davListing([oldDir, true], [source, false]);
              if (path === currentDir && moved)
                return davListing([currentDir, true], [target, false]);
              return davListing([path, true]);
            case "MOVE":
              expect(path).toBe(source);
              expect(new URL(new Headers(options.headers).get("Destination") ?? "").pathname).toBe(
                target,
              );
              moved = true;
              return new Response(null, { status: 201 });
            case "PUT":
              return new Response(null, { status: 201 });
            default:
              throw new Error(`Unexpected method ${options?.method}`);
          }
        });
        setPlatformService({ fetch } as unknown as IPlatformService);

        await syncFiles(new WebDavBackend(config, "secret"), undefined, { disableUploads: true });
        expect(moved).toBe(true);
        const laterRequestsStart = fetch.mock.calls.length;
        // A fresh client cannot rely on either the last scan's in-memory map or the manifest.
        const result = await syncFiles(new WebDavBackend(config, "secret"), undefined, {
          forceDownloadAll,
        });

        const requests = fetch.mock.calls
          .slice(laterRequestsStart)
          .map(([url, options]) => [options?.method, new URL(url).pathname]);
        if (forceDownloadAll) expect(requests).toContainEqual(["GET", target]);
        expect(requests).not.toContainEqual(["PROPFIND", oldDir]);
        expect(requests).not.toContainEqual(["PUT", target]);
        expect(result).toMatchObject({
          filesDownloaded: forceDownloadAll ? 1 : 0,
          filesUploaded: 0,
          failures: [],
        });
        expect(fetch.mock.calls.filter(([, options]) => options?.method === "DELETE")).toEqual([]);
      },
    );

    it.each([
      { name: "forced download", forceDownloadAll: true, failAgain: false, cover: false },
      { name: "uploads enabled", forceDownloadAll: false, failAgain: false, cover: false },
      { name: "MOVE fails again", forceDownloadAll: true, failAgain: true, cover: false },
      { name: "only the cover is left", forceDownloadAll: true, failAgain: false, cover: true },
      {
        name: "Export.epub with forced download",
        forceDownloadAll: true,
        sourceName: "Export.epub",
      },
      {
        name: "Export.epub with uploads enabled",
        forceDownloadAll: false,
        sourceName: "Export.epub",
      },
      {
        name: "Export.epub MOVE fails again",
        forceDownloadAll: true,
        failAgain: true,
        sourceName: "Export.epub",
      },
      {
        name: "ambiguous EPUB files",
        forceDownloadAll: true,
        sourceName: "Export.epub",
        backup: true,
      },
      { name: "exact name with a backup EPUB", forceDownloadAll: true, backup: true },
    ])(
      "recovers a WebDAV rename on a later scan with no manifest ($name)",
      async ({ forceDownloadAll, failAgain, cover, sourceName = "Old Title.epub", backup }) => {
        const book = {
          id: "book-1",
          file_path: "books/book-1.epub",
          title: "New Title",
          cover_url: cover ? "covers/book-1.jpg" : null,
        };
        const ambiguous = backup && sourceName === "Export.epub";
        const blocked = failAgain || ambiguous;
        mockSelect.mockResolvedValue([book]);
        mockAdapter.fileExists.mockResolvedValue(true);

        const root = `/dav${REMOTE_BOOKS_ROOT}/`;
        const manifest = `/dav${REMOTE_FILE_MANIFEST}`;
        const oldDir = `${root}Old%20Title-book-1/`;
        const currentDir = `${root}New%20Title-book-1/`;
        const source = `${oldDir}${encodeURIComponent(sourceName)}`;
        const backupSource = `${oldDir}Backup.epub`;
        const target = `${currentDir}New%20Title.epub`;
        const coverSource = `${oldDir}Old%20Title.jpg`;
        const coverTarget = `${currentDir}New%20Title.jpg`;
        const otherDir = `${root}Other-book-2/`;
        const otherFile = `${otherDir}Other.epub`;
        const paths = new Map([[source, target]]);
        if (cover) paths.set(coverSource, coverTarget);
        const failedSource = cover ? coverSource : source;
        const absent = () =>
          new Response(null, { status: 404, headers: { "Content-Length": "0" } });
        const moved = new Set<string>();
        let currentCreated = false;
        let firstScan = true;

        const fetch = vi.fn((url: string, options?: FetchOptions) => {
          const path = new URL(url).pathname;
          switch (options?.method) {
            case "GET":
              if (path === manifest) return absent();
              if (path === otherFile) return new Response(epubBytes);
              if ([...moved].some((from) => paths.get(from) === path))
                return new Response(epubBytes);
              throw new Error(`Unexpected GET ${path}`);
            case "PROPFIND": {
              if (path === root) {
                const entries: Array<[string, boolean]> = [
                  [root, true],
                  [oldDir, true],
                ];
                if (currentCreated) entries.push([currentDir, true]);
                if (!firstScan && blocked) entries.push([otherDir, true]);
                return davListing(...entries);
              }
              if (path === currentDir && !currentCreated) return absent();
              if (path === otherDir) return davListing([otherDir, true], [otherFile, false]);
              const entries: Array<[string, boolean]> = [[path, true]];
              if (path === oldDir && backup) entries.push([backupSource, false]);
              for (const [from, to] of paths) {
                if (path === oldDir && !moved.has(from)) entries.push([from, false]);
                if (path === currentDir && moved.has(from)) entries.push([to, false]);
              }
              return davListing(...entries);
            }
            case "MKCOL":
              expect(path).toBe(currentDir);
              currentCreated = true;
              return new Response(null, { status: 201 });
            case "MOVE":
              expect(currentCreated).toBe(true);
              expect(moved.has(path)).toBe(false);
              expect(new URL(new Headers(options.headers).get("Destination") ?? "").pathname).toBe(
                paths.get(path),
              );
              if (path === failedSource && (firstScan || failAgain)) {
                return new Response(null, { status: 403 });
              }
              moved.add(path);
              return new Response(null, { status: 201 });
            case "PUT":
              return new Response(null, { status: 201 });
            default:
              throw new Error(`Unexpected method ${options?.method}`);
          }
        });
        setPlatformService({ fetch } as unknown as IPlatformService);

        const firstResult = await syncFiles(new WebDavBackend(config, "secret"), undefined, {
          disableUploads: true,
        });
        const requests = () =>
          fetch.mock.calls.map(([url, options]) => [options?.method, new URL(url).pathname]);
        const firstRequests = requests();
        expect(firstRequests.filter(([method]) => method === "MOVE")).toEqual(
          ambiguous ? [] : [...paths.keys()].map((path) => ["MOVE", path]),
        );
        expect(firstRequests.filter(([method]) => method === "PUT")).toEqual([]);
        if (ambiguous) {
          expect(firstResult.failures).toEqual([
            expect.objectContaining({
              message: expect.stringContaining("Backup.epub, Export.epub"),
            }),
          ]);
          // Another client may create the current collection even when this scan is blocked.
          currentCreated = true;
        } else {
          expect(firstRequests).toContainEqual(["MKCOL", currentDir]);
        }
        expect(moved.has(failedSource)).toBe(false);

        if (blocked) {
          // A healthy book would otherwise give this scan a nonempty manifest to write.
          mockSelect.mockResolvedValue([
            book,
            { id: "book-2", file_path: "books/book-2.epub", title: "Other" },
          ]);
        }
        firstScan = false;
        const laterRequestsStart = fetch.mock.calls.length;
        const result = await syncFiles(new WebDavBackend(config, "secret"), undefined, {
          forceDownloadAll,
        });

        const laterRequests = requests().slice(laterRequestsStart);
        expect(laterRequests).toContainEqual(["GET", manifest]);
        expect(laterRequests.filter(([method]) => method === "MOVE")).toEqual(
          ambiguous ? [] : [["MOVE", failedSource]],
        );
        expect(requests().filter(([method]) => method === "DELETE")).toEqual([]);
        const downloads = laterRequests.filter(
          ([method, path]) => method === "GET" && path !== manifest,
        );
        const uploads = laterRequests.filter(([method]) => method === "PUT");
        if (blocked) {
          expect(downloads).toEqual([["GET", otherFile]]);
          expect(uploads).toEqual([]);
          expect(result).toEqual({
            filesUploaded: 0,
            filesDownloaded: 1,
            filesUploadFailed: 1,
            filesDownloadFailed: 1,
            failures: [
              {
                path: `${REMOTE_BOOKS_ROOT}/New Title-book-1/New Title.epub`,
                ...(ambiguous
                  ? { message: expect.stringContaining("Backup.epub, Export.epub") }
                  : { status: 403, message: expect.stringContaining("MOVE") }),
              },
            ],
          });
        } else {
          expect(downloads.map(([, path]) => path).sort()).toEqual(
            forceDownloadAll ? [...paths.values()].sort() : [],
          );
          expect(uploads).toEqual([["PUT", manifest]]);
          expect(result).toMatchObject({
            filesDownloaded: forceDownloadAll ? paths.size : 0,
            filesUploaded: 0,
            failures: [],
          });
        }
      },
    );

    it.each(["ambiguous", "current unreadable", "fallback ambiguous", "fallback unreadable"])(
      "reports unverifiable scan results without transferring or deleting book data (%s)",
      async (scenario) => {
        const id = "550e8400-e29b-41d4-a716-446655440000";
        mockSelect.mockResolvedValue([
          { id, file_path: `books/${id}.epub`, title: "Current Title" },
        ]);
        mockAdapter.fileExists.mockResolvedValue(true);

        const currentName = `Current Title-${id}`;
        const oldName = `Old Title-${id}`;
        const currentDir = `${REMOTE_BOOKS_ROOT}/${currentName}`;
        const oldDir = `${REMOTE_BOOKS_ROOT}/${oldName}`;
        const names = [oldName];
        if (scenario !== "ambiguous") names.unshift(currentName);
        if (scenario.endsWith("ambiguous")) names.push(`Older Title-${id}`);
        const unreadableDir = scenario === "current unreadable" ? currentDir : oldDir;
        const ambiguous = scenario.endsWith("ambiguous");
        const backend = createMockBackend({
          listDir: vi.fn(async (path: string) => {
            if (path === REMOTE_BOOKS_ROOT) {
              return names.map((name) => ({
                name,
                path: `${path}/${name}`,
                size: 0,
                lastModified: 0,
                isDirectory: true,
              }));
            }
            if (!ambiguous && path === unreadableDir)
              throw new WebDavError("forbidden", "Cannot list collection", { status: 403 });
            return [];
          }),
        });

        const result = await syncFiles(backend, undefined, { forceDownloadAll: true });

        expect(result).toEqual({
          filesUploaded: 0,
          filesDownloaded: 0,
          filesUploadFailed: 1,
          filesDownloadFailed: 1,
          failures: [
            {
              path: `${currentDir}/Current Title.epub`,
              ...(ambiguous
                ? {
                    message: expect.stringContaining(
                      names
                        .filter((name) => name !== currentName)
                        .sort()
                        .join(", "),
                    ),
                  }
                : { message: `Cannot verify remote book folder: ${unreadableDir}`, status: 403 }),
            },
          ],
        });
        expect(backend.get).not.toHaveBeenCalled();
        expect(backend.put).not.toHaveBeenCalled();
        expect(backend.move).not.toHaveBeenCalled();
        expect(backend.delete).not.toHaveBeenCalled();
        expect(backend.putJSON).not.toHaveBeenCalled();
      },
    );

    it.each([true, false])(
      "never probes or deletes the old folder (all moved: %s)",
      async (allMoved) => {
        mockSelect.mockResolvedValue([
          {
            id: "book-1",
            file_path: "books/book-1.epub",
            file_hash: "h1",
            cover_url: "covers/book-1.jpg",
            title: "New Title",
          },
        ]);

        mockAdapter.fileExists.mockResolvedValue(true);

        const oldDirName = "Old Title-book-1";
        const oldDirPath = `${REMOTE_BOOKS_ROOT}/${oldDirName}`;
        const oldFolderEntry: RemoteFile = {
          name: oldDirName,
          path: oldDirPath,
          size: 0,
          lastModified: 0,
          isDirectory: true,
        };
        const oldFiles: RemoteFile[] = [
          {
            name: "Old Title.epub",
            path: `${oldDirPath}/Old Title.epub`,
            size: 100,
            lastModified: 1000,
            isDirectory: false,
          },
          {
            name: "Old Title.jpg",
            path: `${oldDirPath}/Old Title.jpg`,
            size: 50,
            lastModified: 1000,
            isDirectory: false,
          },
        ];

        const backend = createMockBackend({
          listDir: vi.fn().mockImplementation(async (path: string) => {
            if (path === REMOTE_BOOKS_ROOT) return [oldFolderEntry];
            if (path === oldDirPath) return oldFiles;
            return [];
          }),
          move: vi.fn(async (source) => {
            if (!allMoved && source.endsWith("epub"))
              throw new WebDavError("forbidden", "MOVE blocked", { status: 403 });
          }),
          isDirectoryEmpty: vi.fn().mockResolvedValue(true),
          exists: vi
            .fn()
            .mockRejectedValue(new WebDavError("network", "Cannot verify destination")),
          delete: vi.fn().mockResolvedValue(undefined),
        });

        await syncFiles(backend);

        expect(backend.move).toHaveBeenCalledWith(
          `${oldDirPath}/Old Title.epub`,
          `${REMOTE_BOOKS_ROOT}/New Title-book-1/New Title.epub`,
        );
        expect(backend.move).toHaveBeenCalledWith(
          `${oldDirPath}/Old Title.jpg`,
          `${REMOTE_BOOKS_ROOT}/New Title-book-1/New Title.jpg`,
        );
        expect(backend.isDirectoryEmpty).not.toHaveBeenCalled();
        expect(backend.delete).not.toHaveBeenCalled();
      },
    );

    it("deletes remote orphan folders for books no longer in DB", async () => {
      mockSelect.mockResolvedValue([]);
      const orphanDir = "Old-550e8400-e29b-41d4-a716-446655440000";
      const orphanPath = `${REMOTE_BOOKS_ROOT}/${orphanDir}`;
      const orphanChild: RemoteFile = {
        name: "Old.epub",
        path: `${orphanPath}/Old.epub`,
        size: 1,
        lastModified: 0,
        isDirectory: false,
      };

      const backend = createMockBackend({
        listDir: vi.fn().mockImplementation(async (path: string) => {
          if (path === REMOTE_BOOKS_ROOT) {
            return [
              {
                name: orphanDir,
                path: orphanPath,
                size: 0,
                lastModified: 0,
                isDirectory: true,
              },
            ];
          }
          if (path === orphanPath) return [orphanChild];
          return [];
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      });

      await syncFiles(backend);
      expect(backend.delete).toHaveBeenCalledWith(`${orphanPath}/Old.epub`);
      expect(backend.delete).toHaveBeenCalledWith(orphanPath);
    });

    it("keeps the active custom cover during local orphan cleanup", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.txt",
          file_hash: "h1",
          cover_url: "covers/book-1-custom-123.jpg",
          title: "Text Book",
        },
      ]);
      mockAdapter.fileExists.mockResolvedValue(true);
      mockAdapter.getFileSize.mockResolvedValue(100);
      mockAdapter.listFiles.mockImplementation(async (path: string) => {
        if (path === "/appdata/covers") return ["book-1-custom-123.jpg", "gone-book.jpg"];
        return [];
      });

      const backend = createMockBackend({
        listDir: vi.fn().mockResolvedValue([]),
      });

      await syncFiles(backend);

      expect(mockAdapter.deleteFile).not.toHaveBeenCalledWith(
        "/appdata/covers/book-1-custom-123.jpg",
      );
      expect(mockAdapter.deleteFile).toHaveBeenCalledWith("/appdata/covers/gone-book.jpg");
    });

    it("uploads the active custom cover when the remote manifest has no reliable cover size", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.txt",
          file_hash: "h1",
          cover_url: "covers/book-1-custom-123.jpg",
          title: "Text Book",
        },
      ]);
      mockAdapter.fileExists.mockResolvedValue(true);
      mockAdapter.getFileSize.mockResolvedValue(100);

      const manifest = {
        version: 1 as const,
        generatedAt: 1000,
        books: {
          "book-1": {
            folderName: "Text Book-book-1",
            filePath: `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.txt`,
            coverPath: `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.jpg`,
            updatedAt: 1000,
          },
        },
      };
      const backend = createMockBackend({
        getJSON: vi.fn().mockResolvedValue(manifest),
        listDir: vi.fn().mockResolvedValue([]),
      });

      const result = await syncFiles(backend);

      expect(result.filesUploaded).toBe(1);
      expect(backend.put).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.jpg`,
        expect.any(Uint8Array),
      );
    });

    it("uploads a replaced custom cover when the local cover path changes but size stays the same", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.txt",
          file_hash: "h1",
          cover_url: "covers/book-1-custom-456.jpg",
          title: "Text Book",
        },
      ]);
      mockAdapter.fileExists.mockResolvedValue(true);
      mockAdapter.getFileSize.mockImplementation(async (path: string) => {
        if (path === "/appdata/books/book-1.txt") return 500;
        if (path === "/appdata/covers/book-1-custom-456.jpg") return 100;
        return null;
      });
      mockAdapter.hashFile.mockResolvedValue("new-cover-hash");

      const manifest = {
        version: 1 as const,
        generatedAt: 1000,
        books: {
          "book-1": {
            folderName: "Text Book-book-1",
            filePath: `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.txt`,
            fileSize: 500,
            coverPath: `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.jpg`,
            coverSize: 100,
            coverHash: "old-cover-hash",
            coverSourcePath: "covers/book-1-custom-123.jpg",
            updatedAt: 1000,
          },
        },
      };
      const backend = createMockBackend({
        getJSON: vi.fn().mockResolvedValue(manifest),
        listDir: vi.fn().mockResolvedValue([]),
      });

      const result = await syncFiles(backend);

      expect(result.filesUploaded).toBe(1);
      expect(backend.put).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.jpg`,
        expect.any(Uint8Array),
      );
      expect(backend.putJSON).toHaveBeenCalledWith(
        REMOTE_FILE_MANIFEST,
        expect.objectContaining({
          books: expect.objectContaining({
            "book-1": expect.objectContaining({
              coverHash: "new-cover-hash",
              coverSourcePath: "covers/book-1-custom-456.jpg",
            }),
          }),
        }),
      );
    });

    it("uploads a custom cover when the content hash changes even if the path and size match", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.txt",
          file_hash: "h1",
          cover_url: "covers/book-1-custom-123.jpg",
          title: "Text Book",
        },
      ]);
      mockAdapter.fileExists.mockResolvedValue(true);
      mockAdapter.getFileSize.mockImplementation(async (path: string) => {
        if (path === "/appdata/books/book-1.txt") return 500;
        if (path === "/appdata/covers/book-1-custom-123.jpg") return 100;
        return null;
      });
      mockAdapter.hashFile.mockResolvedValue("new-cover-hash");

      const manifest = {
        version: 1 as const,
        generatedAt: 1000,
        books: {
          "book-1": {
            folderName: "Text Book-book-1",
            filePath: `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.txt`,
            fileSize: 500,
            coverPath: `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.jpg`,
            coverSize: 100,
            coverHash: "old-cover-hash",
            coverSourcePath: "covers/book-1-custom-123.jpg",
            updatedAt: 1000,
          },
        },
      };
      const backend = createMockBackend({
        getJSON: vi.fn().mockResolvedValue(manifest),
        listDir: vi.fn().mockResolvedValue([]),
      });

      const result = await syncFiles(backend);

      expect(result.filesUploaded).toBe(1);
      expect(backend.put).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.jpg`,
        expect.any(Uint8Array),
      );
    });

    it("downloads a newly referenced custom cover when it is missing locally", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.txt",
          file_hash: "h1",
          cover_url: "covers/book-1-custom-123.jpg",
          title: "Text Book",
        },
      ]);
      mockAdapter.fileExists.mockImplementation(async (path: string) => {
        if (path === "/appdata/books/book-1.txt") return true;
        if (path === "/appdata/covers/book-1-custom-123.jpg") return false;
        return false;
      });
      mockAdapter.getFileSize.mockImplementation(async (path: string) => {
        if (path === "/appdata/books/book-1.txt") return 500;
        return null;
      });

      const manifest = {
        version: 1 as const,
        generatedAt: 1000,
        books: {
          "book-1": {
            folderName: "Text Book-book-1",
            filePath: `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.txt`,
            fileSize: 500,
            coverPath: `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.jpg`,
            coverSize: 100,
            updatedAt: 1000,
          },
        },
      };
      const backend = createMockBackend({
        getJSON: vi.fn().mockResolvedValue(manifest),
        listDir: vi.fn().mockResolvedValue([]),
      });

      const result = await syncFiles(backend);

      expect(result.filesDownloaded).toBe(1);
      expect(backend.get).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.jpg`,
      );
      expect(mockAdapter.writeFileBytes).toHaveBeenCalledWith(
        expect.stringMatching(/^\/appdata\/covers\/\.readany-transfer-.*\.tmp$/),
        expect.any(Uint8Array),
      );
      expect(mockAdapter.replaceFile).toHaveBeenCalledWith(
        expect.stringMatching(/^\/appdata\/covers\/\.readany-transfer-.*\.tmp$/),
        "/appdata/covers/book-1-custom-123.jpg",
      );
    });

    it("downloads a changed custom cover in receive-only mode instead of uploading the stale local copy", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.txt",
          file_hash: "h1",
          cover_url: "covers/book-1-custom-123.jpg",
          title: "Text Book",
        },
      ]);
      mockAdapter.fileExists.mockResolvedValue(true);
      mockAdapter.getFileSize.mockImplementation(async (path: string) => {
        if (path === "/appdata/books/book-1.txt") return 500;
        if (path === "/appdata/covers/book-1-custom-123.jpg") return 80;
        return null;
      });

      const manifest = {
        version: 1 as const,
        generatedAt: 1000,
        books: {
          "book-1": {
            folderName: "Text Book-book-1",
            filePath: `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.txt`,
            fileSize: 500,
            coverPath: `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.jpg`,
            coverSize: 120,
            updatedAt: 1000,
          },
        },
      };
      const backend = createMockBackend({
        getJSON: vi.fn().mockResolvedValue(manifest),
        listDir: vi.fn().mockResolvedValue([]),
      });

      const result = await syncFiles(backend, undefined, {
        disableUploads: true,
        disableRemoteDeletes: true,
        downloadRemoteBooks: true,
      });

      expect(result.filesUploaded).toBe(0);
      expect(result.filesDownloaded).toBe(1);
      expect(backend.put).not.toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.jpg`,
        expect.any(Uint8Array),
      );
      expect(backend.get).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Text Book-book-1/Text Book.jpg`,
      );
    });
  });

  describe("downloadBookFile", () => {
    it("downloads via the new layout when the book is in DB", async () => {
      mockSelect.mockResolvedValue([{ id: "book-1", title: "Test Book" }]);

      const backend = createMockBackend({
        get: vi.fn().mockResolvedValue(epubBytes),
      });

      const result = await downloadBookFile(backend, "book-1", "books/book-1.epub");

      expect(result).toBe("ok");
      expect(backend.get).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
      );
      expect(mockAdapter.writeFileBytes).toHaveBeenCalled();
      expect(mockUpdateBook).toHaveBeenCalledWith("book-1", {
        filePath: "books/book-1.epub",
        syncStatus: "local",
      });
    });

    it("downloads on-demand via direct file transfer when available", async () => {
      mockSelect.mockResolvedValue([{ id: "book-1", title: "Test Book" }]);

      const backend = createMockBackend({
        getFileToPath: vi.fn().mockResolvedValue(undefined),
      });

      const result = await downloadBookFile(backend, "book-1", "books/book-1.epub");

      expect(result).toBe("ok");
      expect(backend.getFileToPath).toHaveBeenCalledWith(
        `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`,
        expect.stringMatching(/^\/appdata\/books\/\.readany-transfer-.*\.tmp$/),
        expect.any(Function),
      );
      expect(mockAdapter.replaceFile).toHaveBeenCalledWith(
        expect.stringMatching(/^\/appdata\/books\/\.readany-transfer-.*\.tmp$/),
        "/appdata/books/book-1.epub",
      );
      expect(mockAdapter.writeFileBytes).not.toHaveBeenCalled();
      expect(backend.get).not.toHaveBeenCalled();
      expect(mockUpdateBook).toHaveBeenCalledWith("book-1", {
        filePath: "books/book-1.epub",
        syncStatus: "local",
      });
    });

    it("downloads source-device absolute paths into the local managed book path", async () => {
      mockSelect.mockResolvedValue([{ id: "book-1", title: "Test Book" }]);

      const backend = createMockBackend({
        getFileToPath: vi.fn().mockResolvedValue(undefined),
      });

      const result = await downloadBookFile(
        backend,
        "book-1",
        "file:///data/user/0/com.readany.app/files/books/source-device-copy.epub",
      );

      expect(result).toBe("ok");
      expect(mockAdapter.replaceFile).toHaveBeenCalledWith(
        expect.stringMatching(/^\/appdata\/books\/\.readany-transfer-.*\.tmp$/),
        "/appdata/books/book-1.epub",
      );
      expect(mockUpdateBook).toHaveBeenCalledWith("book-1", {
        filePath: "books/book-1.epub",
        syncStatus: "local",
      });
    });

    it("falls back to the legacy path when the new path is missing", async () => {
      mockSelect.mockResolvedValue([{ id: "book-1", title: "Test Book" }]);

      const getMock = vi
        .fn<(p: string) => Promise<Uint8Array>>()
        .mockImplementation(async (path: string) => {
          if (path === `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.epub`) {
            throw new WebDavError("not-found", "远端文件不存在", { status: 404 });
          }
          if (path === `${REMOTE_FILES}/book-1.epub`) {
            return epubBytes;
          }
          throw new Error(`unexpected path ${path}`);
        });
      const backend = createMockBackend({ get: getMock });

      const result = await downloadBookFile(backend, "book-1", "books/book-1.epub");

      expect(result).toBe("ok");
      expect(getMock).toHaveBeenCalledWith(`${REMOTE_FILES}/book-1.epub`);
      expect(mockUpdateBook).toHaveBeenCalledWith("book-1", {
        filePath: "books/book-1.epub",
        syncStatus: "local",
      });
    });

    it("returns 'not-found' and marks book as remote when neither path has the file", async () => {
      mockSelect.mockResolvedValue([{ id: "book-1", title: "Test Book" }]);
      const downloadFile = vi
        .fn()
        .mockRejectedValue(new FileTransferError("远端文件不存在", { status: 404 }));
      setPlatformService({ downloadFile } as unknown as IPlatformService);
      const client = new WebDavClient("https://dav.example.com/dav", "alice", "secret");

      const backend = createMockBackend({
        getFileToPath: client.getFileToPath.bind(client),
      });

      const result = await downloadBookFile(backend, "book-1", "books/book-1.epub");

      expect(result).toBe("not-found");
      expect(downloadFile).toHaveBeenCalledTimes(2);
      expect(mockSetBookSyncStatus).toHaveBeenCalledWith("book-1", "remote");
    });

    it("reports progress", async () => {
      mockSelect.mockResolvedValue([{ id: "book-1", title: "Test Book" }]);
      const backend = createMockBackend({
        get: vi.fn().mockResolvedValue(epubBytes),
      });
      const onProgress = vi.fn();

      await downloadBookFile(backend, "book-1", "books/book-1.epub", onProgress);

      expect(onProgress).toHaveBeenCalledWith({ downloaded: 0, total: 100 });
      expect(onProgress).toHaveBeenCalledWith({ downloaded: 100, total: 100 });
    });

    it("returns 'error' on transient network failure", async () => {
      mockSelect.mockResolvedValue([{ id: "book-1", title: "Test Book" }]);
      const backend = createMockBackend({
        get: vi.fn().mockRejectedValue(new Error("network error")),
      });

      const result = await downloadBookFile(backend, "book-1", "books/book-1.epub");

      expect(result).toBe("error");
      expect(mockSetBookSyncStatus).toHaveBeenCalledWith("book-1", "remote");
    });
  });

  describe("legacy cover migration", () => {
    it("migrates a legacy cover via MOVE", async () => {
      mockSelect.mockResolvedValue([
        {
          id: "book-1",
          file_path: "books/book-1.epub",
          file_hash: "h1",
          cover_url: "covers/book-1.jpg",
          title: "Test Book",
        },
      ]);
      mockAdapter.fileExists.mockResolvedValue(false);

      const backend = createMockBackend({
        listDir: vi.fn().mockImplementation(async (path: string) => {
          if (path === REMOTE_COVERS) {
            return [
              {
                name: "book-1.jpg",
                path: `${REMOTE_COVERS}/book-1.jpg`,
                size: 50,
                lastModified: 1000,
                isDirectory: false,
              },
            ];
          }
          return [];
        }),
        move: vi.fn().mockResolvedValue(undefined),
      });

      await syncFiles(backend);
      expect(backend.move).toHaveBeenCalledWith(
        `${REMOTE_COVERS}/book-1.jpg`,
        `${REMOTE_BOOKS_ROOT}/Test Book-book-1/Test Book.jpg`,
      );
    });
  });
});
