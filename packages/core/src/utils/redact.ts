/**
 * Coarse redaction for copied diagnostics. Keep this conservative: remove
 * credentials and absolute paths while preserving identifiers (book IDs,
 * hashes) that help locate the failing book.
 */

const FILE_EXTENSIONS =
  "pdf|epub|mobi|azw3?|cbz|fb2|txt|json|log|db|sqlite|wasm|mjs|cjs|js|tsx?|css|jpe?g|png|webp";

const WINDOWS_FILE_PATH = new RegExp(
  String.raw`(^|[\s"'(])([A-Za-z]:\\[^\r\n"']*?\.(?:${FILE_EXTENSIONS})\b)`,
  "gi",
);
const POSIX_FILE_PATH = new RegExp(
  String.raw`(^|[\s"'(])(\/(?:[^\r\n"'/]+\/)+[^\r\n"':;,)]*?\.(?:${FILE_EXTENSIONS})\b)`,
  "gi",
);

export function scrubSensitiveText(value: string): string {
  return (
    value
      .replace(/\b(?:file|asset|tauri|https?):\/\/\S+/gi, "<url>")
      .replace(/\b(?:blob|data):\S+/gi, "<url>")
      .replace(WINDOWS_FILE_PATH, "$1<path>")
      .replace(POSIX_FILE_PATH, "$1<path>")
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1<redacted>@")
      .replace(/\b(?:sk|ghp|gho|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{10,}\b/g, "<redacted>")
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted>")
      // JWT-shaped three-part tokens; book IDs are single UUID-ish segments.
      .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted>")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
  );
}
