import { DOMParser } from "@xmldom/xmldom";
import { BlobReader, TextWriter, ZipReader, configure } from "@zip.js/zip.js";
import { toArrayBuffer } from "./zip";

const CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container";
const PACKAGE_MEDIA_TYPE = "application/oebps-package+xml";
const OPF_NS = "http://www.idpf.org/2007/opf";
const SPINE_DOCUMENT_MEDIA_TYPES = new Set(["application/xhtml+xml", "text/html", "image/svg+xml"]);

export type EpubInspectManifestItem = {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
};

export type EpubInspectSpineItem = {
  idref: string;
  linear?: string;
  href?: string;
  mediaType?: string;
};

export type EpubInspectTocItem = {
  label: string;
  href: string;
  level: number;
};

export type EpubInspectResult = {
  format: "epub";
  packagePath: string;
  version?: string;
  metadata: {
    title?: string;
    creator?: string;
    language?: string;
    identifier?: string;
    publisher?: string;
    description?: string;
    modified?: string;
    subjects: string[];
  };
  manifest: {
    count: number;
    items: EpubInspectManifestItem[];
  };
  spine: {
    count: number;
    toc?: string;
    items: EpubInspectSpineItem[];
  };
  toc: {
    count: number;
    items: EpubInspectTocItem[];
  };
};

type ZipEntryLike = {
  filename: string;
  directory?: boolean;
  getData?: (writer: TextWriter) => Promise<string>;
};

export type EpubPackageResourceReader = {
  packagePath: string;
  packageDir: string;
  entryPaths: string[];
  readTextEntry: (path: string) => Promise<string | null>;
};

configure({ useWebWorkers: false });

export async function inspectEpubBytes(bytes: Uint8Array): Promise<EpubInspectResult> {
  return withEpubPackageResourceReader(
    bytes,
    async ({ packagePath, entryPaths, readTextEntry }) => {
      const opfXml = await readTextEntry(packagePath);
      if (!opfXml) {
        throw new Error(`EPUB package document was not found: ${packagePath}`);
      }

      return inspectPackageDocument({ opfXml, packagePath, entryPaths, readTextEntry });
    },
  );
}

export async function withEpubPackageResourceReader<T>(
  bytes: Uint8Array,
  callback: (reader: EpubPackageResourceReader) => Promise<T>,
): Promise<T> {
  const buffer = toArrayBuffer(bytes);
  const reader = new ZipReader(new BlobReader(new Blob([buffer])));

  try {
    const entries = (await reader.getEntries()) as ZipEntryLike[];
    const readTextEntry = createEntryReader(entries);
    const containerXml = await readTextEntry("META-INF/container.xml");
    if (!containerXml) {
      throw new Error("EPUB container.xml was not found.");
    }

    const packagePath = parsePackagePath(containerXml);
    const packageDir = getPackageDir(packagePath);
    return callback({
      packagePath,
      packageDir,
      entryPaths: entries.filter((entry) => !entry.directory).map((entry) => entry.filename),
      readTextEntry,
    });
  } finally {
    await reader.close();
  }
}

function createEntryReader(entries: ZipEntryLike[]) {
  const entryMap = new Map(entries.map((entry) => [entry.filename, entry]));
  return async (path: string): Promise<string | null> => {
    let entry = entryMap.get(path);
    if (!entry) {
      const lower = path.toLowerCase();
      entry = entries.find((candidate) => candidate.filename.toLowerCase() === lower);
    }
    if (!entry || entry.directory || !entry.getData) return null;
    return entry.getData(new TextWriter());
  };
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml") as unknown as Document;
}

function elementsByLocalName(root: Document | Element, localName?: string): Element[] {
  const elements = Array.from(root.getElementsByTagName("*"));
  if (!localName || localName === "*") return elements;
  return elements.filter((element) => element.localName === localName);
}

function parsePackagePath(containerXml: string): string {
  const [packagePath] = parseEpubContainerPaths(containerXml);
  if (!packagePath) {
    throw new Error("EPUB container.xml does not declare a package document.");
  }
  return packagePath;
}

/** Parse OCF metadata without resolving external resources. */
function parseEpubContainerPaths(xml: string, requirePackageMediaType = false): string[] {
  const root = parseEpubXmlRoot(xml);
  if (
    root.localName !== "container" ||
    (requirePackageMediaType && root.namespaceURI !== CONTAINER_NS)
  )
    throw new Error("Invalid EPUB container.xml");
  return childElements(root)
    .filter((element) => element.localName === "rootfiles")
    .flatMap(childElements)
    .filter(
      (element) =>
        element.localName === "rootfile" &&
        (!requirePackageMediaType ||
          (element.namespaceURI === CONTAINER_NS &&
            element.getAttribute("media-type") === PACKAGE_MEDIA_TYPE)),
    )
    .map((element) => element.getAttribute("full-path") ?? "");
}

function parseEpubXmlRoot(xml: string): Element {
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error("Unexpected EPUB XML declaration");
  const rejectInvalidXml = () => {
    throw new Error("Invalid EPUB XML");
  };
  const doc = new DOMParser({ errorHandler: rejectInvalidXml }).parseFromString(
    xml,
    "application/xml",
  );
  if (!doc.documentElement) throw new Error("Missing EPUB XML root");
  return doc.documentElement as unknown as Element;
}

export function parseEpubReadingPackagePaths(xml: string): string[] {
  return parseEpubContainerPaths(xml, true);
}

function parseManifestItem(item: Element): EpubInspectManifestItem {
  return {
    id: item.getAttribute("id") ?? "",
    href: item.getAttribute("href") ?? "",
    mediaType: item.getAttribute("media-type") ?? "",
    properties: item.getAttribute("properties") || undefined,
  };
}

/** Inspect the untruncated OPF structure, without loading TOC or book resources. */
export function parseEpubReadingPackage(xml: string): {
  manifestHrefs: string[];
  spineHrefs: string[];
} {
  const root = parseEpubXmlRoot(xml);
  if (root.localName !== "package") throw new Error("Invalid EPUB package root");
  // Foliate uses the OPF namespace when declared, but also handles older unnamespaced packages.
  const usesOpfNamespace = root.namespaceURI === OPF_NS || root.lookupPrefix(OPF_NS);
  const children = (element: Element, name: string) =>
    childElements(element).filter(
      (child) => child.localName === name && (!usesOpfNamespace || child.namespaceURI === OPF_NS),
    );
  const [metadata] = children(root, "metadata");
  const [manifest] = children(root, "manifest");
  const [spine] = children(root, "spine");
  if (!metadata || !manifest || !spine) throw new Error("Incomplete EPUB package");

  const items = children(manifest, "item").map(parseManifestItem);
  const idrefs = children(spine, "itemref");
  if (!items.length || !idrefs.length) throw new Error("Empty EPUB manifest or spine");
  const itemsById = new Map<string, EpubInspectManifestItem>();
  for (const item of items) {
    const { id, href, mediaType } = item;
    if (!id.trim() || !href.trim() || !mediaType.trim() || itemsById.has(id))
      throw new Error("Invalid EPUB manifest item");
    itemsById.set(id, item);
  }
  const spineItems = idrefs.map((itemref) => {
    const item = itemsById.get(itemref.getAttribute("idref") ?? "");
    if (!item) throw new Error("Invalid EPUB spine reference");
    return item;
  });
  if (!spineItems.some(({ mediaType }) => SPINE_DOCUMENT_MEDIA_TYPES.has(mediaType)))
    throw new Error("No renderable EPUB spine document");
  // NCX does not count as a chapter, but every referenced spine member needs an integrity check.
  return {
    manifestHrefs: items.map(({ href }) => href),
    spineHrefs: spineItems.map(({ href }) => href),
  };
}

async function inspectPackageDocument(options: {
  opfXml: string;
  packagePath: string;
  entryPaths: string[];
  readTextEntry: (path: string) => Promise<string | null>;
}): Promise<EpubInspectResult> {
  const doc = parseXml(options.opfXml);
  const packageElement = doc.documentElement;
  const packageDir = getPackageDir(options.packagePath);
  const manifestItems = elementsByLocalName(doc, "item").map(parseManifestItem);
  const manifestById = new Map(manifestItems.map((item) => [item.id, item]));
  const spineElement = elementsByLocalName(doc, "spine")[0];
  const spineItems = elementsByLocalName(spineElement ?? doc, "itemref").map((itemref) => {
    const idref = itemref.getAttribute("idref") ?? "";
    const manifestItem = manifestById.get(idref);
    return {
      idref,
      linear: itemref.getAttribute("linear") || undefined,
      href: manifestItem?.href,
      mediaType: manifestItem?.mediaType,
    };
  });
  const tocItems = await extractTocItems({
    manifestItems,
    packageDir,
    spineTocId: spineElement?.getAttribute("toc") || undefined,
    entryPaths: options.entryPaths,
    readTextEntry: options.readTextEntry,
  });

  return {
    format: "epub",
    packagePath: options.packagePath,
    version: packageElement.getAttribute("version") || undefined,
    metadata: parseMetadata(doc),
    manifest: {
      count: manifestItems.length,
      items: manifestItems.slice(0, 100),
    },
    spine: {
      count: spineItems.length,
      toc: spineElement?.getAttribute("toc") || undefined,
      items: spineItems.slice(0, 100),
    },
    toc: {
      count: tocItems.length,
      items: tocItems.slice(0, 100),
    },
  };
}

function parseMetadata(doc: Document): EpubInspectResult["metadata"] {
  const metadata = elementsByLocalName(doc, "metadata")[0] ?? doc.documentElement;
  const metadataElements = elementsByLocalName(metadata);
  const textByLocalName = (localName: string) =>
    metadataElements.find((element) => element.localName === localName)?.textContent?.trim() ||
    undefined;
  const metaByProperty = (property: string) =>
    metadataElements
      .find(
        (element) => element.localName === "meta" && element.getAttribute("property") === property,
      )
      ?.textContent?.trim() || undefined;

  return {
    title: textByLocalName("title"),
    creator: textByLocalName("creator"),
    language: textByLocalName("language"),
    identifier: textByLocalName("identifier"),
    publisher: textByLocalName("publisher"),
    description: textByLocalName("description"),
    modified: metaByProperty("dcterms:modified"),
    subjects: metadataElements
      .filter((element) => element.localName === "subject")
      .map((element) => element.textContent?.trim() || "")
      .filter(Boolean),
  };
}

async function extractTocItems(options: {
  manifestItems: EpubInspectManifestItem[];
  packageDir: string;
  spineTocId?: string;
  entryPaths: string[];
  readTextEntry: (path: string) => Promise<string | null>;
}): Promise<EpubInspectTocItem[]> {
  const navItem = options.manifestItems.find((item) =>
    item.properties?.split(/\s+/).includes("nav"),
  );
  if (navItem?.href) {
    const navPath = findPackageResourcePath(options.entryPaths, options.packageDir, navItem.href);
    const navXml = navPath ? await options.readTextEntry(navPath) : null;
    if (navXml) return parseNavDocument(navXml);
  }

  const ncxItem = options.spineTocId
    ? options.manifestItems.find((item) => item.id === options.spineTocId)
    : options.manifestItems.find((item) => item.mediaType === "application/x-dtbncx+xml");
  if (ncxItem?.href) {
    const ncxPath = findPackageResourcePath(options.entryPaths, options.packageDir, ncxItem.href);
    const ncxXml = ncxPath ? await options.readTextEntry(ncxPath) : null;
    if (ncxXml) return parseNcxDocument(ncxXml);
  }

  return [];
}

function parseNavDocument(navXml: string): EpubInspectTocItem[] {
  const doc = parseXml(navXml);
  const navs = elementsByLocalName(doc, "nav");
  const tocNav =
    navs.find((nav) => (nav.getAttribute("epub:type") || nav.getAttribute("type")) === "toc") ??
    navs[0];
  if (!tocNav) return [];
  const items: EpubInspectTocItem[] = [];
  collectNavLinks(tocNav, 0, items);
  return items;
}

function collectNavLinks(element: Element, level: number, items: EpubInspectTocItem[]): void {
  for (const child of childElements(element)) {
    if (child.localName === "a") {
      const label = child.textContent?.trim() || "";
      const href = child.getAttribute("href") || "";
      if (label || href) items.push({ label, href, level });
      continue;
    }
    collectNavLinks(child, child.localName === "ol" ? level + 1 : level, items);
  }
}

function parseNcxDocument(ncxXml: string): EpubInspectTocItem[] {
  const doc = parseXml(ncxXml);
  return elementsByLocalName(doc, "navPoint").map((navPoint) => ({
    label:
      elementsByLocalName(navPoint, "text")[0]?.textContent?.trim() ||
      navPoint.getAttribute("id") ||
      "",
    href: elementsByLocalName(navPoint, "content")[0]?.getAttribute("src") || "",
    level: countAncestorNavPoints(navPoint),
  }));
}

function countAncestorNavPoints(element: Element): number {
  let level = 0;
  let parent = element.parentElement;
  while (parent) {
    if (parent.localName === "navPoint") level += 1;
    parent = parent.parentElement;
  }
  return level;
}

function childElements(element: Element): Element[] {
  return Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1);
}

export function resolvePackagePath(packageDir: string, href: string): string {
  if (!packageDir) return href;
  return `${packageDir}${href}`.replace(/\/{2,}/g, "/");
}

export function getPackageDir(packagePath: string): string {
  return packagePath.includes("/") ? packagePath.slice(0, packagePath.lastIndexOf("/") + 1) : "";
}

export function resolvePackagePathCandidates(packageDir: string, href: string): string[] {
  const candidates = [resolvePackagePath(packageDir, href)];
  const decodedHref = safeDecodeURIComponent(href);
  if (decodedHref && decodedHref !== href) {
    candidates.push(resolvePackagePath(packageDir, decodedHref));
  }
  return unique(candidates);
}

export function findPackageResourcePath(
  entryPaths: string[],
  packageDir: string,
  href: string,
): string | undefined {
  const candidates = resolvePackagePathCandidates(packageDir, href);
  const entrySet = new Set(entryPaths);
  const exact = candidates.find((candidate) => entrySet.has(candidate));
  if (exact) return exact;

  const lowerEntries = new Map(entryPaths.map((entryPath) => [entryPath.toLowerCase(), entryPath]));
  return candidates
    .map((candidate) => lowerEntries.get(candidate.toLowerCase()))
    .find((entryPath): entryPath is string => Boolean(entryPath));
}

function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
