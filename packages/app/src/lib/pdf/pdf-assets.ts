/**
 * Point pdf.js at the app's bundled cmaps/standard fonts.
 *
 * `foliate-js/pdf.js` is also bundled into the mobile reader by esbuild, so it
 * cannot read `import.meta.env`. The desktop host injects an absolute runtime
 * base instead; mobile leaves it unset and keeps the CDN default.
 */
export function configurePdfAssets(): void {
  if (typeof window === "undefined") return;

  try {
    const origin = window.location.origin;
    const baseHref =
      origin && origin !== "null"
        ? `${origin}${import.meta.env.BASE_URL}`
        : document.baseURI || window.location.href;
    globalThis.__READANY_PDF_ASSET_BASE__ = new URL("vendor/pdfjs/", baseHref).href;
  } catch (error) {
    console.warn("[pdf-assets] Failed to resolve bundled pdf.js assets:", error);
    globalThis.__READANY_PDF_ASSET_BASE__ = undefined;
  }
}
