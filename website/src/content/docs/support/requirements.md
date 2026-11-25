---
draft: false
title: System Requirements & Known Limitations
description: Supported platforms, runtime requirements, and current limits of ReadAny.
---

This page describes the current 1.3.x line. Items marked as known limitations are tracked but do not come with a release date.

## Desktop

| Platform | Package | Runtime |
|---|---|---|
| macOS (Apple Silicon) | `.dmg` | System WebKit; keep macOS on a version that still receives security updates |
| macOS (Intel) | `.dmg` | System WebKit; keep macOS on a version that still receives security updates |
| Windows (x64) | `.msi` / `.exe` | Microsoft Edge WebView2 Runtime |
| Linux (x64) | `.AppImage` / `.deb` | WebKitGTK 4.1 (`libwebkit2gtk-4.1`) and GTK 3 |

Windows 10 and Windows 11 include WebView2 on current installs. If ReadAny opens a blank window or the PDF viewer fails, update the [Microsoft Edge WebView2 Runtime](https://learn.microsoft.com/microsoft-edge/webview2/) and try again.

On Linux, the AppImage bundles the application but still uses the system WebKitGTK 4.1 stack. Install the distribution's WebKitGTK 4.1 package if the AppImage does not start.

## Mobile

| Platform | Distribution | Requirement |
|---|---|---|
| Android | `.apk` from the releases page | Side-loaded APK; allow installation from your browser or file manager |
| iOS / iPadOS | TestFlight | Join the current TestFlight build from the README download table |

Android builds are distributed as APKs, not through an app store. To install:

1. Download the APK from the releases page.
2. Allow your browser or file manager to install unknown apps when prompted.
3. Open the APK and confirm installation.
4. If Android reports a signature mismatch, uninstall the previous ReadAny build first. This can remove local app data, so sync or export anything you need before uninstalling.

**Expo Go is not supported.** ReadAny uses native modules and a custom development client. For development, use an Expo development build (`pnpm expo:ios`, `pnpm expo:ios:simulator`, or `pnpm expo:android`); Expo Go cannot load the app.

## Storage and Memory

- Book files dominate disk usage. Leave room for your library plus covers, the local database, and the vector index used by semantic search.
- Semantic search and local embeddings run on your device. Large libraries take longer to index, and vectorization uses CPU and memory while it runs.
- The first local embedding setup may download a model. Allow disk space and network access for that download.
- Keep at least a few hundred MB free for the database and temporary transfer files.

## Sync Requirements

ReadAny does not include a cloud service or a WebDAV server. To sync, you need one of:

- A WebDAV account or self-hosted server, reachable over HTTPS
- An S3-compatible bucket

See [WebDAV Sync](/ReadAny/support/sync/webdav/) for setup, the remote layout, and a minimal wsgidav deployment. Use an app-specific password where your provider supports one.

Network guidance:

- Prefer a stable connection for the first sync and for uploading large books.
- Book file transfers time out after 300 seconds; metadata requests use a shorter timeout.
- On weak NAS or consumer WebDAV gateways, lower **Concurrent transfers** to 1–2.
- The WebDAV server must accept `PROPFIND`, `MKCOL`, `PUT`, `GET`, `MOVE`, and `DELETE`.

## Known Limitations

### Sync and Book Files

- Metadata sync and book-file sync are separate phases. A successful metadata sync can still leave book files failed; the sync details report the failure counts.
- A normal sync does not bulk-download remote book files. Open a remote book to download it, or use **Full Download** to fetch everything.
- A successful `Test Connection` verifies authentication and directory creation, not that every later upload will fit the server's quota or proxy limits.

### Large Files

Book files of 200 MB or more are known to fail on some setups. The desktop upload path reads the file into memory before sending it, and book file transfers time out after 300 seconds. Keep individual books well under 200 MB where possible, and split very large PDFs or comic archives.

This is a known limitation under investigation, not a fixed behavior.

### PDF Rendering

- PDF is a fixed-layout format. ReadAny extracts the text layer, so complex layouts, tables, and scanned pages may not render as expected.
- Older WebView2 runtimes on Windows may fail to display PDFs. Update WebView2.
- Very large or malformed PDFs can be slow to open or fail to parse.

### Security and Privacy

- Synced data is stored as plain files on your WebDAV or S3 provider. ReadAny does not add end-to-end encryption; the provider can read book files and sync JSON.
- **Allow Insecure Connection** weakens transport security. On desktop it disables TLS certificate verification; on mobile it can rewrite `https://` to `http://`. Use it only for a self-signed certificate or plain HTTP on a trusted local network.

### Content

- ReadAny supports DRM-free books only.
- TXT and UMD files are converted to EPUB on import.
- Format conversion between other formats is not part of the current release.

### Platform

- The desktop auto-updater needs access to the release download endpoint. Networks that block GitHub releases may need a manual download.
- Mobile development requires an Expo development build; Expo Go is not supported.
- iOS distribution is through TestFlight and may be limited by tester slots or build availability.

## Related

- [Installation](/ReadAny/support/installation/)
- [WebDAV Sync](/ReadAny/support/sync/webdav/)
- [FAQ](/ReadAny/support/faq/)
