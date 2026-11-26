import { Reader, ZipReader } from "@zip.js/zip.js";
import { getPathExtension } from "./local-book-paths";

export const DAV_BODY_PREFIX_BYTES = 1024;
const MAX_ZIP_DIRECTORY_BYTES = 16 * 1024 * 1024;

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

export async function readAndCancelDavBodyPrefix(
  response: Response,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  try {
    return Uint8Array.from((await readDavBodyPrefix(reader)).prefix);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function isDavMissingResponse(response: Response): Promise<boolean> {
  const contentType = response.headers.get("Content-Type");
  if (
    /\/(?:xml|[^/]+\+xml)$/i.test(mediaType(contentType)) ||
    isHtmlContentType(contentType) ||
    isJsonContentType(contentType)
  ) {
    await response.body?.cancel().catch(() => {});
    return false;
  }
  return !isUnsafeDavFilePrefix(await readAndCancelDavBodyPrefix(response));
}

function isUnexpectedMarkup(prefix: string, filePath?: string): boolean {
  const start = prefix.trimStart();
  if (!/^<\s*[!?/\p{L}]/u.test(start)) return false;

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
  return isUnsafeDavFilePrefix(await readAndCancelDavBodyPrefix(response));
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

/** Read ZIP directory/entry headers without buffering or inflating book payloads. */
export async function isNonemptyDavZip(
  size: number,
  read: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<boolean> {
  if (!Number.isSafeInteger(size) || size < 22) return false;
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
      const bytes = await read(offset, Math.min(length, size - offset));
      return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : Uint8Array.from(bytes);
    }
  }
  const zip = new ZipReader(new FileReader(undefined));
  try {
    const entries = (await zip.getEntries()).sort((a, b) => a.offset - b.offset);
    // Each central directory header needs at least 46 bytes, plus the 22-byte end record.
    const latestPayloadEnd = size - 22 - entries.length * 46;
    let hasFile = false;
    for (const [index, entry] of entries.entries()) {
      if (
        !Number.isSafeInteger(entry.offset) ||
        entry.offset < 0 ||
        !Number.isSafeInteger(entry.compressedSize) ||
        entry.compressedSize < 0
      )
        return false;
      const header = await read(entry.offset, 30);
      if (header.length !== 30 || !hasZipSignature(header)) return false;
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      const dataOffset = entry.offset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
      if (dataOffset + entry.compressedSize > (entries[index + 1]?.offset ?? latestPayloadEnd))
        return false;
      hasFile ||= !entry.directory && entry.uncompressedSize > 0;
    }
    return hasFile;
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
      !(await isNonemptyDavZip(bytes.length, async (offset, length) =>
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
  // React Native's Response snapshots can expose arrayBuffer() but no body stream.
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    checkPrefix(bytes);
    return checkZip(bytes);
  }

  const reader = response.body.getReader();
  try {
    const { prefix, remainder } = await readDavBodyPrefix(reader);
    checkPrefix(prefix);
    const chunks = remainder ? [prefix, remainder] : [prefix];
    let length = prefix.length + (remainder?.length ?? 0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return await checkZip(bytes);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
