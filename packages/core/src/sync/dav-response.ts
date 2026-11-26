export const DAV_BODY_PREFIX_BYTES = 1024;

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
  return /^(text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(contentType ?? "");
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
  return new TextDecoder().decode(prefix);
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
  if (!response.body) return false;
  const reader = response.body.getReader();
  try {
    const { prefix } = await readDavBodyPrefix(reader);
    return isUnsafeDavFilePrefix(prefix);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function isUnsafeDavFilePrefix(bytes: Uint8Array, filePath?: string): boolean {
  const decoded = decodeDavBodyPrefix(bytes);
  return (
    (bytes.length >= DAV_BODY_PREFIX_BYTES && !decoded.trim()) ||
    isUnexpectedMarkup(decoded, filePath)
  );
}

export async function readDavDownloadBody(
  response: Response,
  filePath: string,
  invalidResponse: () => Error,
): Promise<Uint8Array<ArrayBuffer>> {
  const check = (bytes: Uint8Array) => {
    if (!bytes.length || isUnsafeDavFilePrefix(bytes, filePath)) throw invalidResponse();
  };
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    check(bytes);
    return bytes;
  }

  const reader = response.body.getReader();
  try {
    const { prefix, remainder } = await readDavBodyPrefix(reader);
    check(prefix);
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
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
