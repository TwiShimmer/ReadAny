import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

const packagePath = "OPS/book.opf";
const defaultChapterPath = "OPS/chapter one.xhtml";

export const epubPackageXml = `<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title><dc:language>en</dc:language><dc:identifier id="uid">test-book</dc:identifier>
  </metadata>
  <manifest>
    <item id="chapter" href="./chapter%20one.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="chapter"/></spine>
</package>`;

export async function epubFixture({
  rootfile = packagePath,
  rootfileMediaType = 'media-type="application/oebps-package+xml"',
  opfPath = packagePath,
  opf = epubPackageXml,
  chapter = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><p>Text</p></body></html>',
  chapterPath = defaultChapterPath,
  chapterLevel = 6,
  extraChapters = [] as Array<[path: string, text: string]>,
  mime = "application/epub+zip",
  mimeLevel = 0,
} = {}) {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await zip.add("mimetype", new TextReader(mime), { level: mimeLevel });
  if (rootfile)
    await zip.add(
      "META-INF/container.xml",
      new TextReader(
        `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="${rootfile}" ${rootfileMediaType}/></rootfiles></container>`,
      ),
    );
  if (opfPath) {
    await zip.add(opfPath, new TextReader(opf));
    await zip.add(chapterPath, new TextReader(chapter), { level: chapterLevel });
    for (const [path, text] of extraChapters) await zip.add(path, new TextReader(text));
    await zip.add(
      "OPS/toc.ncx",
      new TextReader(`<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
        <head><meta name="dtb:uid" content="test-book"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
        <docTitle><text>Test Book</text></docTitle>
        <navMap><navPoint id="chapter" playOrder="1"><navLabel><text>Chapter</text></navLabel><content src="chapter%20one.xhtml"/></navPoint></navMap>
      </ncx>`),
    );
  }
  return zip.close();
}
