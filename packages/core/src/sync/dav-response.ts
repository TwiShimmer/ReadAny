import { type Entry, type FileEntry, Reader, ZipReader } from "@zip.js/zip.js";
import {
  getPackageDir,
  parseEpubReadingManifest,
  parseEpubReadingPackagePaths,
  resolvePackagePath,
} from "../epub/inspect";
import { getPathExtension } from "./local-book-paths";

export const DAV_BODY_PREFIX_BYTES = 1024;
const DAV_PREFIX_TIMEOUT_MS = 15_000;
const MAX_DAV_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_BUFFERED_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_STREAMED_DAV_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ZIP_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_EPUB_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_EPUB_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EPUB_CONTAINER_BYTES = 64 * 1024;
export const MAX_EPUB_PACKAGE_BYTES = 4 * 1024 * 1024;

export function isDavWriteMethod(method: string): boolean {
  return method === "PUT" || method === "MKCOL" || method === "MOVE" || method === "DELETE";
}

export function isDavWriteSuccess(method: string, status: number): boolean {
  switch (method) {
    case "PUT":
      return status === 200 || status === 201 || status === 204;
    case "MKCOL":
      return status === 200 || status === 201 || status === 204;
    case "MOVE":
      return status === 201 || status === 204;
    case "DELETE":
      return status === 200 || status === 204;
    default:
      return false;
  }
}

export function isHtmlContentType(contentType: string | null): boolean {
  return /^(text\/html|application\/xhtml\+xml)$/i.test(mediaType(contentType));
}

function mediaType(contentType: string | null): string {
  return contentType?.split(";", 1)[0].trim() ?? "";
}

function isJsonContentType(contentType: string | null): boolean {
  return /\/(?:json|[^/]+\+json)$/i.test(mediaType(contentType));
}

export function isDavMissingStatus(status: number): boolean {
  return status === 404 || status === 410;
}

async function withBodyDeadline<T>(read: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("WebDAV response body timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type DavMissingBody = "confirmed-empty" | "plain-missing" | "unknown";

// Expo releases the native fetch/timeout before returning the Response snapshot.
// Keep the original classification rather than inventing a body or changing headers.
const missingBodySnapshots = new WeakMap<Response, DavMissingBody>();

export async function preserveDavMissingBody(
  original: Response,
  snapshot: Response,
): Promise<void> {
  missingBodySnapshots.set(snapshot, await classifyDavMissingBody(original));
}

async function classifyDavMissingBody(response: Response): Promise<DavMissingBody> {
  const contentType = response.headers.get("Content-Type");
  if (isHtmlContentType(contentType) || /\/(?:xml|[^/]+\+xml)$/i.test(mediaType(contentType))) {
    void response.body?.cancel().catch(() => {});
    return "unknown";
  }
  const length = response.headers.get("Content-Length")?.trim();
  const declaredEmpty =
    response.status === 204 || (length === "0" && !response.headers.has("Transfer-Encoding"));
  const prefix = await readAndCancelDavBodyPrefix(response);
  if (!prefix) return declaredEmpty ? "confirmed-empty" : "unknown";
  if (prefix.length === 0 && (length == null || declaredEmpty)) return "confirmed-empty";
  // A short prefix below the read limit is the entire body. Only accept ordinary
  // status text, not a sign-in prompt or an error document mislabeled as plain text.
  if (
    prefix.length > 128 ||
    declaredEmpty ||
    (contentType && !/^text\/plain$/i.test(mediaType(contentType)))
  )
    return "unknown";
  const text = decodeDavBodyPrefix(prefix).trim();
  const statusText =
    response.status === 404 ? /^(?:404(?: Not Found)?|Not Found)$/i : /^(?:410(?: Gone)?|Gone)$/i;
  return statusText.test(text) ? "plain-missing" : "unknown";
}

export async function isDavMissingResponse(response: Response): Promise<boolean> {
  return (await missingResponseBody(response)) === "confirmed-empty";
}

/** Compatibility for non-destructive probes, not for reading sync state. */
export async function isDavMissingCollectionProbe(response: Response): Promise<boolean> {
  const body = await missingResponseBody(response);
  return body === "confirmed-empty" || body === "plain-missing";
}

async function missingResponseBody(response: Response): Promise<DavMissingBody> {
  if (!isDavMissingStatus(response.status)) return "unknown";
  return missingBodySnapshots.get(response) ?? (await classifyDavMissingBody(response));
}

async function readAndCancelDavBodyPrefix(response: Response): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  try {
    return (await withBodyDeadline(() => readDavBodyPrefix(reader), DAV_PREFIX_TIMEOUT_MS)).prefix;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function isUnexpectedMarkup(prefix: string, filePath?: string): boolean {
  const start = prefix.trimStart();
  if (!/^(?:<\s*(?:[!?/\p{L}]|$)|!doctype\b)/iu.test(start)) return false;

  // FB2 books are XML. Require the actual FictionBook root after the prologue.
  if (filePath && /\.fb2$/i.test(filePath)) {
    const root = start.replace(/^(?:\s*(?:<\?xml\s[\s\S]*?\?>|<!--[\s\S]*?-->))*/i, "").trimStart();
    return !/^<(?:[\w.-]+:)?FictionBook(?:\s|>)/.test(root);
  }
  return true;
}

function decodeDavBodyPrefix(bytes: Uint8Array): string {
  const prefix = bytes.subarray(0, DAV_BODY_PREFIX_BYTES);
  const littleEndian = prefix[0] === 0xff && prefix[1] === 0xfe;
  if (littleEndian || (prefix[0] === 0xfe && prefix[1] === 0xff)) {
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    let decoded = "";
    for (let i = 2; i + 1 < prefix.length; i += 2) {
      decoded += String.fromCharCode(view.getUint16(i, littleEndian));
    }
    return decoded;
  }
  return new TextDecoder().decode(prefix).replace(/^\uFEFF/, "");
}

/** Read only the prefix, retaining any bytes already pulled past it. */
export async function readDavBodyPrefix(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{
  prefix: Uint8Array;
  remainder?: Uint8Array;
}> {
  const prefix = new Uint8Array(DAV_BODY_PREFIX_BYTES);
  let length = 0;
  while (length < prefix.length) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value.subarray(0, prefix.length - length);
    prefix.set(chunk, length);
    length += chunk.length;
    if (chunk.length < value.length) return { prefix, remainder: value.subarray(chunk.length) };
  }
  return { prefix: prefix.subarray(0, length) };
}

/** Validates the prefix and releases the rest of a write response. */
export async function hasUnsafeDavWriteBody(response: Response): Promise<boolean> {
  const prefix = await readAndCancelDavBodyPrefix(response);
  return prefix !== undefined && isUnsafeDavFilePrefix(prefix);
}

export function isUnsafeDavFilePrefix(bytes: Uint8Array): boolean {
  const decoded = decodeDavBodyPrefix(bytes);
  return (bytes.length >= DAV_BODY_PREFIX_BYTES && !decoded.trim()) || isUnexpectedMarkup(decoded);
}

export function acceptsDavDownloadType(filePath: string, contentType: string | null): boolean {
  return (
    !isHtmlContentType(contentType) &&
    (!isJsonContentType(contentType) || getPathExtension(filePath) === "json")
  );
}

export function isDavZipDownload(filePath: string): boolean {
  return ["epub", "cbz", "fbz"].includes(getPathExtension(filePath));
}

function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
}

export function acceptsDavDownloadPrefix(filePath: string, bytes: Uint8Array): boolean {
  if (!bytes.length) return false;
  if (isDavZipDownload(filePath)) return hasZipSignature(bytes);
  const decoded = decodeDavBodyPrefix(bytes);
  if (getPathExtension(filePath) === "txt") {
    const start = decoded
      .replace(/^(?:\s*(?:<!--[\s\S]*?-->|<\?xml\s[\s\S]*?\?>))*/, "")
      .trimStart();
    const html =
      /^<\s*(?:!doctype\s+html\b|\/?(?:html|head|body|title|meta|script|form|input|iframe)(?=[\s/>]))/i;
    // Reject binary-looking control bytes, but allow legacy encodings and ordinary '<' text.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional binary control-byte detection
    return !html.test(start) && !/[\x00-\x08\x0b\x0e-\x1f]/.test(decoded);
  }
  return (
    !(bytes.length >= DAV_BODY_PREFIX_BYTES && !decoded.trim()) &&
    !isUnexpectedMarkup(decoded, filePath)
  );
}

export function isDavEpubDownload(path: string): boolean {
  return getPathExtension(path) === "epub";
}

function safeEpubPath(path: string): boolean {
  if (path.includes("\\") || path.includes(":")) return false;
  for (const char of path) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

async function readEpubMetadata(entry: FileEntry, limit: number): Promise<string> {
  if (
    entry.uncompressedSize === 0 ||
    entry.uncompressedSize > limit ||
    entry.compressedSize > limit
  ) {
    throw new Error("Invalid or oversized EPUB metadata");
  }
  const bytes = new Uint8Array(entry.uncompressedSize);
  let length = 0;
  await entry.getData(
    new WritableStream<Uint8Array>({
      write(chunk) {
        if (length + chunk.length > bytes.length)
          throw new Error("Oversized EPUB metadata payload");
        bytes.set(chunk, length);
        length += chunk.length;
      },
    }),
    { checkSignature: true, useWebWorkers: false },
  );
  if (length !== bytes.length) throw new Error("Truncated EPUB metadata");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function resolveEpubManifestHref(packageDir: string, href: string): string | undefined {
  // Foliate resolves the URI relative to the package and decodes each path segment.
  // Do not allow absolute paths, traversal or encoded path separators to be normalized away.
  if (href !== href.trim() || /[\t\r\n?#]|%(?:2f|5c|23)/i.test(href)) return;
  const parts = decodeURIComponent(href).split("/");
  if (parts[parts.length - 1] === ".") return;
  const relative = parts.filter((part) => part !== ".").join("/");
  if (!safeEpubPath(relative)) return;
  return resolvePackagePath(packageDir, relative);
}

async function hasReadableEpubPackage(entries: Map<string, FileEntry>): Promise<boolean> {
  const mime = entries.get("mimetype");
  const container = entries.get("META-INF/container.xml");
  // Historical desktop TXT conversion deflated this entry. Its data must still be
  // exactly the OCF mimetype, and it does not waive any container or package check.
  if (
    !mime ||
    mime.uncompressedSize !== 20 ||
    !container ||
    (await readEpubMetadata(mime, 64)) !== "application/epub+zip"
  )
    return false;
  const paths = parseEpubReadingPackagePaths(
    await readEpubMetadata(container, MAX_EPUB_CONTAINER_BYTES),
  );
  if (
    !paths.length ||
    paths.some((path) => !safeEpubPath(path) || !safeEpubPath(decodeURIComponent(path)))
  )
    return false;
  // Match Foliate: the first rootfile with the package media type is the primary rendition.
  const opf = entries.get(paths[0]);
  if (!opf) return false;
  const packageDir = getPackageDir(opf.filename);
  const manifest = parseEpubReadingManifest(await readEpubMetadata(opf, MAX_EPUB_PACKAGE_BYTES));
  return manifest.every(({ href }) => {
    const path = resolveEpubManifestHref(packageDir, href);
    const entry = path && entries.get(path);
    return !!entry && entry.uncompressedSize > 0 && entry.compressedSize > 0;
  });
}

/** Scan ZIP headers and, for EPUB, read and CRC-check only the bounded OCF metadata. */
export async function isValidDavZip(
  path: string,
  size: number,
  read: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<boolean> {
  if (!Number.isSafeInteger(size) || size < 22) return false;
  const epub = isDavEpubDownload(path);
  let directoryStart = size;
  let enumerating = true;
  class FileReader extends Reader<undefined> {
    size = size;

    async readUint8Array(offset: number, length: number): Promise<Uint8Array> {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > size ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_ZIP_DIRECTORY_BYTES
      )
        throw new Error("Invalid or oversized ZIP directory");
      // zip.js also accesses the backing buffer directly.
      const count = Math.min(length, size - offset);
      const bytes = await read(offset, count);
      if (bytes.length !== count) throw new Error("Truncated ZIP read");
      // zip.js loads the central directory in one range starting at its first header.
      if (enumerating && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 1 && bytes[3] === 2)
        directoryStart = Math.min(directoryStart, offset);
      return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : Uint8Array.from(bytes);
    }
  }
  const zip = new ZipReader(new FileReader(undefined));
  try {
    const entries: Entry[] = [];
    for await (const entry of zip.getEntriesGenerator()) {
      entries.push(entry);
      if (entries.length > MAX_ZIP_ENTRIES) return false;
    }
    enumerating = false;
    if (directoryStart === size) return false;
    entries.sort((a, b) => a.offset - b.offset);
    const files = new Map<string, FileEntry>();
    const names = new Set<string>();
    let expandedSize = 0;
    let hasFile = false;
    for (const [index, entry] of entries.entries()) {
      if (
        !Number.isSafeInteger(entry.offset) ||
        entry.offset < 0 ||
        entry.offset > directoryStart - 30 ||
        !Number.isSafeInteger(entry.compressedSize) ||
        entry.compressedSize < 0
      )
        return false;
      const header = await read(entry.offset, 30);
      if (header.length !== 30 || !hasZipSignature(header)) return false;
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      const nameLength = view.getUint16(26, true);
      const dataOffset = entry.offset + 30 + nameLength + view.getUint16(28, true);
      if (
        dataOffset + entry.compressedSize >
        Math.min(entries[index + 1]?.offset ?? directoryStart, directoryStart)
      )
        return false;
      hasFile ||= !entry.directory && entry.uncompressedSize > 0;
      if (!epub) continue;

      const path = entry.directory ? entry.filename.replace(/\/$/, "") : entry.filename;
      const flags = view.getUint16(6, true);
      expandedSize += entry.uncompressedSize;
      if (
        names.has(path) ||
        !safeEpubPath(path) ||
        entry.encrypted ||
        (flags & 0x2041) !== 0 ||
        ((entry.unixMode ?? 0) & 0xf000) === 0xa000 ||
        ![0, 8].includes(entry.compressionMethod) ||
        view.getUint16(8, true) !== entry.compressionMethod ||
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0 ||
        (entry.compressionMethod === 0 && entry.compressedSize !== entry.uncompressedSize) ||
        entry.uncompressedSize > MAX_EPUB_ENTRY_BYTES ||
        expandedSize > MAX_EPUB_TOTAL_BYTES ||
        entry.uncompressedSize > Math.max(1024 * 1024, entry.compressedSize * 1000) ||
        entry.rawFilename.length !== nameLength
      )
        return false;
      // With no data descriptor the local header must agree with the directory.
      // ZIP64 sizes use the sentinel and are already resolved by zip.js.
      if (
        !(flags & 8) &&
        (view.getUint32(14, true) !== entry.signature ||
          ![entry.compressedSize, 0xffffffff].includes(view.getUint32(18, true)) ||
          ![entry.uncompressedSize, 0xffffffff].includes(view.getUint32(22, true)))
      )
        return false;
      const localName = await read(entry.offset + 30, nameLength);
      if (
        localName.length !== nameLength ||
        localName.some((byte, i) => byte !== entry.rawFilename[i])
      )
        return false;
      names.add(path);
      if (!entry.directory) files.set(path, entry);
    }
    return hasFile && (!epub || (await hasReadableEpubPackage(files)));
  } catch {
    return false;
  } finally {
    await zip.close();
  }
}

export async function readDavDownloadBody(
  response: Response,
  filePath: string,
  invalidResponse: () => Error,
): Promise<Uint8Array<ArrayBuffer>> {
  const checkPrefix = (bytes: Uint8Array) => {
    if (!acceptsDavDownloadPrefix(filePath, bytes)) throw invalidResponse();
  };
  const checkZip = async (bytes: Uint8Array<ArrayBuffer>) => {
    if (
      isDavZipDownload(filePath) &&
      !(await isValidDavZip(filePath, bytes.length, async (offset, length) =>
        bytes.subarray(offset, offset + length),
      ))
    )
      throw invalidResponse();
    return bytes;
  };
  if (!acceptsDavDownloadType(filePath, response.headers.get("Content-Type"))) {
    await response.body?.cancel().catch(() => {});
    throw invalidResponse();
  }
  return checkZip(
    await readBoundedDavBody(
      response,
      MAX_BUFFERED_DOWNLOAD_BYTES,
      120_000,
      invalidResponse,
      checkPrefix,
    ),
  );
}

export async function readDavText(
  response: Response,
  invalidResponse: () => Error,
): Promise<string> {
  return new TextDecoder().decode(
    await readBoundedDavBody(response, MAX_DAV_TEXT_BYTES, 30_000, invalidResponse),
  );
}

async function readBoundedDavBody(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  invalidResponse: () => Error,
  checkPrefix?: (bytes: Uint8Array) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  try {
    return await withBodyDeadline(async () => {
      if (Number(response.headers.get("Content-Length")) > maxBytes) throw invalidResponse();
      let bytes = new Uint8Array(0);
      let length = 0;
      const append = (chunk: Uint8Array) => {
        const end = length + chunk.length;
        if (end > maxBytes) throw invalidResponse();
        if (end > bytes.length) {
          const grown = new Uint8Array(Math.min(maxBytes, Math.max(end, bytes.length * 2, 65536)));
          grown.set(bytes);
          bytes = grown;
        }
        bytes.set(chunk, length);
        length = end;
      };
      if (checkPrefix) {
        const { prefix, remainder } = await readDavBodyPrefix(reader);
        checkPrefix(prefix);
        append(prefix);
        if (remainder) append(remainder);
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        append(value);
      }
      return bytes.length === length ? bytes : bytes.slice(0, length);
    }, timeoutMs);
  } finally {
    void reader.cancel().catch(() => {});
  }
}
