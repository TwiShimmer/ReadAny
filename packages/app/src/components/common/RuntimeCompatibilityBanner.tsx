/**
 * Shows only when the runtime is missing the Map upsert APIs AND the polyfill
 * could not install them (for example, a frozen prototype). This is the last
 * line of defence for "minimum runtime" support: point the user at the
 * official WebView2 runtime instead of letting PDFs fail with a TypeError.
 */
import { findMissingMapUpsertApis } from "@readany/core/utils/modern-map";
import { AlertTriangle, ExternalLink, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

const WEBVIEW2_DOWNLOAD_URL = "https://developer.microsoft.com/microsoft-edge/webview2/";

export function RuntimeCompatibilityBanner() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const missingApis = findMissingMapUpsertApis();

  if (dismissed || missingApis.length === 0) return null;

  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-[200] flex w-[min(92vw,560px)] -translate-x-1/2 items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-50 px-4 py-3 text-amber-950 shadow-lg dark:bg-amber-950 dark:text-amber-50"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{t("runtime.minRuntimeTitle")}</p>
        <p className="mt-1 opacity-90">{t("runtime.minRuntimeDescription")}</p>
        <a
          href={WEBVIEW2_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 font-medium underline underline-offset-2"
        >
          {t("runtime.downloadWebView2")}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={t("common.close", { defaultValue: "Close" })}
        className="rounded p-1 opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
