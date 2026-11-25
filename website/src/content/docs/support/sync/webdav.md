---
draft: false
title: WebDAV Sync
description: Sync reading data and book files with WebDAV storage you provide.
---

## Overview

ReadAny is a client-side reader. It does **not** host a cloud service or run a WebDAV server for you. Cross-device sync works with storage you already have:

- **WebDAV** — Nextcloud, Nutstore (坚果云 / Jianguoyun), Box, or a self-hosted server such as wsgidav
- **S3-compatible storage** — configured separately under **Settings → Sync**

Every device must connect to the same server, account, and **Remote Folder**. ReadAny does not merge two different remote folders into one library.

## Before You Connect

- [ ] **Server URL**, including the WebDAV base path. For example: `https://dav.example.com/dav/`
- [ ] **Username** and an **app-specific password** (recommended) rather than your main account password
- [ ] **Remote Folder** — defaults to `readany`. Nested paths such as `apps/readany` are supported. ReadAny creates the folder during **Test Connection** or the first sync.
- [ ] **Write permission** for that folder. ReadAny needs to list, create folders, upload, download, move, and delete files.
- [ ] **Enough space** for metadata, book files, and covers
- [ ] **Path check** — the final location is `<Server URL>/<Remote Folder>/sync/...` for sync data and `<Server URL>/<Remote Folder>/data/books/...` for book files

ReadAny does not scan or import books that you placed in the remote folder by hand. Use **Import → Connect another WebDAV** to browse an existing remote library.

## Setup

1. Open **Settings → Sync** and choose **WebDAV**
2. Enter the server URL, username, and password or app password
3. Set the **Remote Folder** (default: `readany`)
4. Click **Test Connection**. This checks authentication and creates the sync folders.
5. Click **Save Configuration**
6. Click **Sync Now** on each device

Do not enable **Allow Insecure Connection** unless you understand the risk. On desktop it skips TLS certificate verification; on mobile it rewrites `https://` to `http://` for the connection. It is intended only for a self-signed certificate or plain HTTP on a trusted local network.

## Remote Layout

With the default Remote Folder (`readany`), ReadAny writes:

```text
<Remote Folder>/
├── sync/
│   ├── index.json                    # membership + per-book change markers
│   ├── books/<bookId>.json           # book row + highlights, notes, bookmarks
│   ├── threads/<threadId>.json       # chat thread metadata
│   ├── chat/<YYYY-MM-DD>.json        # chat messages created that day
│   ├── profile/<table>.json          # tags, groups, skills, ...
│   └── sessions/<YYYY-MM>.json       # reading sessions, monthly
└── data/
    ├── books/
    │   └── <sanitized-title>-<bookId>/
    │       ├── <sanitized-title>.<book-ext>
    │       └── <sanitized-title>.<cover-ext>
    └── file-manifest.json            # lightweight index of remote book files
```

`index.json` is the shared change index. `file-manifest.json` lets ReadAny avoid a full directory scan; if it is missing or stale, ReadAny falls back to scanning the folders.

### Book Folder Names

The folder name is the **display title plus the book ID**:

```text
Three-Body Problem-3f2a9c1e-8b7d-4c2a-9f10-1d2e3f4a5b6c
```

- The title is sanitized: `/ \ : * ? " < > |`, control characters, and repeated whitespace are removed or replaced, and the title is capped at 64 characters.
- A book with no usable title uses the placeholder `未命名` ("Untitled").
- The trailing UUID is the stable book ID. ReadAny uses it to match the folder to the book even if the display title changes.
- Renaming a book changes the folder name. ReadAny moves the files to the new folder on the next sync, so do not rename folders by hand.

Older versions and LAN sync used a per-device snapshot layout:

```text
<Remote Folder>/sync/device-<deviceId>.json
<Remote Folder>/data/file/<bookId>.<ext>
<Remote Folder>/data/cover/<bookId>.<ext>
```

Current cloud sync reads those files for migration and moves book files into the per-book layout. You may still see them after upgrading, or while LAN sync is in use. Do not delete them manually during a migration.

## What Gets Synced

- Reading progress and current position
- Highlights, notes, and bookmarks
- Book metadata, tags, groups, and reading sessions
- Chat threads and messages
- Book files and covers

Book files **are** synced per book. Metadata and book files are separate phases, so a successful metadata sync does not guarantee that every book file transferred.

## New Devices and Bulk Downloads

A normal sync does **not** download every remote book file. ReadAny pulls the metadata first, so remote books appear in the library with a remote/download state, but `downloadRemoteBooks` defaults to `false`.

- **Open a remote book** to download that book file on demand.
- To fetch everything at once, use **Settings → Sync → Advanced → Full Download**. This overwrites this device's database and downloads remote books and covers again, so use it deliberately.
- A normal sync still uploads local books that are missing on the remote.

## When a File Fails

The sync result reports metadata and file transfers separately:

- A sync can finish with metadata applied and some book or cover files failed.
- The sync details show how many files were uploaded/downloaded and how many failed.
- A failed file does not abort the rest of the batch; the status message looks like “Some files didn't sync (N upload failures, M download failures).”
- The next sync retries missing files automatically.

If the same file keeps failing, check the server's write permission, free space, path length, proxy body-size limit, and whether the file is unusually large. Then retry. If the remote copy is wrong, use **Full Upload** from the device that has the correct file.

## Known Limitations

These limits apply to the current 1.3.x line. Fixes are tracked, but this page does not promise a release date.

- **Very large books can fail.** Reports of 200 MB+ book files failing on some setups are known. The desktop upload path reads the file into memory before PUT, and book file transfers time out after 300 seconds. Keep individual books well under 200 MB where possible, and prefer splitting very large PDFs or comic archives.
- **Older WebView2 runtimes may fail to render PDFs.** On Windows, update the Microsoft Edge WebView2 Runtime through Windows Update or the official installer.
- **Weak servers dislike bursts.** Some NAS and consumer WebDAV gateways throttle or return 401/429 under parallel load. Lower **Concurrent transfers** to 1–2 in sync settings.
- **The server stores plain files.** ReadAny does not add end-to-end encryption. Your WebDAV provider can read synced JSON and book files, so choose a provider you trust. **Allow Insecure Connection** weakens this further: desktop skips TLS verification, and mobile can downgrade `https://` to `http://`.
- **Some servers reject long or unusual paths.** The folder name includes a 36-character book ID. If your server has a short path limit, keep the Remote Folder shallow.

See [System Requirements & Known Limitations](/ReadAny/support/requirements/) for platform and runtime details.

## Self-Hosted WebDAV with wsgidav

[wsgidav](https://github.com/mar10/wsgidav) is a small Python WebDAV server suitable for a personal ReadAny library. The commands below are the minimal setup; read the [wsgidav documentation](https://wsgidav.readthedocs.io/en/latest/) before exposing it beyond localhost.

```bash
# Install the server and its recommended WSGI server
python -m pip install wsgidav cheroot

# Create a data directory
mkdir -p /srv/readany-dav

# Bind to loopback only; do not expose this port directly
wsgidav --host=127.0.0.1 --port=8090 --root=/srv/readany-dav
```

By default this gives anonymous access. Keep it bound to `127.0.0.1` and put authentication and HTTPS in front of it, or configure wsgidav's own authentication as described in its documentation.

A minimal nginx reverse proxy:

```nginx
server {
    listen 443 ssl;
    server_name dav.example.com;

    ssl_certificate     /etc/ssl/fullchain.pem;
    ssl_certificate_key /etc/ssl/privkey.pem;

    # ReadAny uploads whole book files; do not impose a proxy body limit
    client_max_body_size 0;

    location /dav/ {
        proxy_pass http://127.0.0.1:8090/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Stream uploads instead of buffering them on the proxy
        proxy_request_buffering off;
        proxy_read_timeout 300s;
    }
}
```

Then configure ReadAny with:

- **Server URL**: `https://dav.example.com/dav/`
- **Remote Folder**: `readany`
- **Username / Password**: the credentials enforced by your proxy or wsgidav

The proxy must pass WebDAV methods such as `PROPFIND`, `MKCOL`, `PUT`, `GET`, `MOVE`, and `DELETE`. nginx does this by default, but some WAFs and CDNs block non-GET/HEAD methods.

## Troubleshooting

| Symptom | Check |
|---|---|
| `401` / authentication failed | Username and app password; some providers require an app password instead of the account password |
| `403` / access denied | Folder permissions; the account must be allowed to create and delete files in the Remote Folder |
| `404` / not found | Server URL path, Remote Folder spelling, and whether the WebDAV endpoint is enabled |
| `405` / method not allowed | WebDAV is disabled on the server, or a proxy/WAF blocks `PROPFIND`, `MKCOL`, or `MOVE` |
| Timeout | Network reachability, port, proxy timeout, and the 300-second book file transfer limit |
| TLS certificate error | Certificate chain/hostname, or use a trusted certificate; only use **Allow Insecure Connection** on a trusted LAN |

## Conflict Resolution

When the same book changes on multiple devices, ReadAny merges at row level using the most recent update, with deletions carrying tombstones. Highlights, notes, and messages merge per item, so edits on two devices are preserved where possible.
