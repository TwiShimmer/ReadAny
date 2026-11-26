/**
 * Absolute URL (with trailing slash) for bundled pdf.js cmaps and standard
 * fonts. Read at runtime by `packages/foliate-js/pdf.js`; mobile leaves it
 * unset so pdf.js keeps its CDN default.
 */
interface Window {
  __READANY_PDF_ASSET_BASE__?: string;
}
