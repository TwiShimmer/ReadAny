/**
 * Bug-report diagnostics for the "Copy diagnostics" actions.
 *
 * The UI never renders raw exceptions or stacks. This helper builds a short,
 * support-friendly summary (app version + web engine + UA + one-line error)
 * that the user can copy deliberately. Full stacks stay in the console, where
 * they are logged once per distinct error by the error boundary.
 */
import { getWebviewLabel } from "@/lib/webview-info";
import { findMissingMapUpsertApis } from "@readany/core/utils/modern-map";
import { scrubSensitiveText } from "@readany/core/utils/redact";
import { getVersion } from "@tauri-apps/api/app";

const MAX_SUMMARY_LENGTH = 500;

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** One-line error summary; safe to put in a support report. */
export function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    const message = scrubSensitiveText(error.message.replace(/\s+/g, " ").trim());
    return truncate(message ? `${error.name}: ${message}` : error.name, MAX_SUMMARY_LENGTH);
  }
  if (typeof error === "string") {
    return truncate(scrubSensitiveText(error.replace(/\s+/g, " ").trim()), MAX_SUMMARY_LENGTH);
  }
  return "Unknown error";
}

export interface DiagnosticsContext {
  scope?: string;
  /** Optional app-level context such as `bookId=...`; never include file paths. */
  context?: string;
}

export async function buildDiagnostics(
  error: unknown,
  details: DiagnosticsContext = {},
): Promise<string> {
  const [appVersion, webviewLabel] = await Promise.all([
    getVersion().catch(() => ""),
    getWebviewLabel().catch(() => ""),
  ]);

  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const missingMapApis = findMissingMapUpsertApis();

  return [
    "ReadAny diagnostics",
    appVersion ? `App: ${appVersion}` : "",
    webviewLabel ? `WebView: ${webviewLabel}` : "",
    `Map upserts: ${missingMapApis.length ? `missing (${missingMapApis.join(", ")})` : "ok"}`,
    userAgent ? `User-Agent: ${userAgent}` : "",
    details.scope ? `Scope: ${scrubSensitiveText(details.scope)}` : "",
    details.context ? `Context: ${scrubSensitiveText(details.context)}` : "",
    `Error: ${summarizeError(error)}`,
    `Time: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Copies diagnostics to the clipboard; throws when the clipboard is unavailable. */
export async function copyErrorDiagnostics(
  error: unknown,
  details: DiagnosticsContext = {},
): Promise<void> {
  const text = await buildDiagnostics(error, details);
  await navigator.clipboard.writeText(text);
}
