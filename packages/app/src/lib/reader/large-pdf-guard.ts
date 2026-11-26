/**
 * Large-PDF guard: warn before handing a very large file to pdf.js.
 *
 * Parsing a 100+ MB PDF can push the renderer to ~1 GB because pdf.js keeps
 * page objects/operator lists and rendered pages alive. We cannot make pdf.js
 * stream a local File, so the lowest-risk protection is an explicit warning
 * (the user can still continue) plus bounded page caches in foliate-js/pdf.js.
 */
import i18n from "@readany/core/i18n";
import { ask } from "@tauri-apps/plugin-dialog";

export const LARGE_PDF_WARNING_BYTES = 100 * 1024 * 1024;
const WARNING_MB_STORAGE_KEY = "readany-large-pdf-warn-mb";

/** Threshold in bytes; overridable via a local setting (MB) for power users. */
export function getLargePdfWarningBytes(): number {
  try {
    const raw = localStorage.getItem(WARNING_MB_STORAGE_KEY);
    if (!raw) return LARGE_PDF_WARNING_BYTES;
    const megabytes = Number(raw);
    return Number.isFinite(megabytes) && megabytes > 0
      ? megabytes * 1024 * 1024
      : LARGE_PDF_WARNING_BYTES;
  } catch {
    return LARGE_PDF_WARNING_BYTES;
  }
}

function isPdfFileName(fileName: string): boolean {
  return /\.pdf$/i.test(fileName);
}

export function isLargePdf(fileName: string, sizeBytes: number): boolean {
  return (
    isPdfFileName(fileName) && Number.isFinite(sizeBytes) && sizeBytes >= getLargePdfWarningBytes()
  );
}

export function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = sizeBytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Returns true when the book should be opened. Non-PDF and small files return
 * true immediately. If the native dialog is unavailable (plain browser dev),
 * fall back to `window.confirm`; never block opening when no confirmation UI
 * exists at all.
 */
export async function confirmLargePdfOpen(fileName: string, sizeBytes: number): Promise<boolean> {
  if (!isLargePdf(fileName, sizeBytes)) return true;

  const message = i18n.t("reader.largePdf.message", {
    defaultValue:
      "This PDF is {{size}}. Opening it may use a lot of memory and take a while. Open it anyway?",
    size: formatFileSize(sizeBytes),
  });

  try {
    return await ask(message, {
      title: i18n.t("reader.largePdf.title", { defaultValue: "Large PDF" }),
      kind: "warning",
      okLabel: i18n.t("reader.largePdf.openAnyway", { defaultValue: "Open anyway" }),
      cancelLabel: i18n.t("common.cancel", { defaultValue: "Cancel" }),
    });
  } catch {
    if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
    return window.confirm(message);
  }
}
