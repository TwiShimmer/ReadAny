//! Native WebDAV file transfer for large book/cover files.
//!
//! Streams directly between disk and the HTTP server inside Rust so
//! multi-megabyte payloads never enter the webview's JS heap — plugin-http
//! serializes request bodies as JS number arrays on the renderer main
//! thread, which froze the whole app during library sync.

use std::collections::HashMap;
use std::io::{BufReader, Read, Seek, SeekFrom};

use tauri::ipc::Channel;
use tauri_plugin_http::reqwest;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

const TRANSFER_TIMEOUT_SECS: u64 = 300;
const CONNECT_TIMEOUT_SECS: u64 = 30;
const DOWNLOAD_MAX_ATTEMPTS: u32 = 3;
/// One retry only: the JS layer already retries a failed streamed upload once
/// (401 or directory heal), so this bounds the combined worst case.
const UPLOAD_MAX_ATTEMPTS: u32 = 2;
const BASE_DELAY_MS: u64 = 500;
const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_EPUB_ZIP_DIRECTORY: u32 = 16 * 1024 * 1024;
const MAX_EPUB_ZIP_ENTRIES: u16 = 10_000;
const BODY_PREFIX_BYTES: usize = 1024;

/// Serialized to the webview as `{ status, message }` so the JS layer can
/// branch on the HTTP status without matching message text.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TransferError {
    status: Option<u16>,
    message: String,
    #[serde(rename = "redirectLocation", skip_serializing_if = "Option::is_none")]
    redirect_location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

impl TransferError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
            redirect_location: None,
            url: None,
        }
    }

    fn with_status(status: u16, message: impl Into<String>) -> Self {
        Self {
            status: Some(status),
            message: message.into(),
            redirect_location: None,
            url: None,
        }
    }
}

impl std::fmt::Display for TransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TransferError {}

fn build_client(allow_insecure: Option<bool>) -> Result<reqwest::Client, TransferError> {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TRANSFER_TIMEOUT_SECS))
        .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .retry(reqwest::retry::never())
        // WebDAV gateways redirect to login pages; following a redirect on PUT
        // can turn a rejected upload into a 200 text/html "success".
        .redirect(reqwest::redirect::Policy::none());
    if allow_insecure.unwrap_or(false) {
        builder = builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }
    builder
        .build()
        .map_err(|e| TransferError::new(format!("failed to build HTTP client: {e}")))
}

fn to_header_map(headers: &HashMap<String, String>) -> reqwest::header::HeaderMap {
    let mut map = reqwest::header::HeaderMap::new();
    for (key, value) in headers {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(key.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            map.insert(name, value);
        }
    }
    map
}

#[derive(Clone, serde::Serialize)]
pub struct TransferProgress {
    loaded: u64,
    total: u64,
}

fn retry_delay(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_millis(BASE_DELAY_MS * 2u64.pow(attempt.saturating_sub(1)))
}

fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 429 || status.is_server_error()
}

fn redirect_error(method: &reqwest::Method, response: &reqwest::Response) -> TransferError {
    let status = response.status();
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| response.url().join(value).ok())
        .filter(|target| matches!(target.scheme(), "https" | "http"))
        .map(|target| format!("{}{}", target.origin().ascii_serialization(), target.path()));
    let mut error = TransferError::with_status(
        status.as_u16(),
        format!("WebDAV {method} redirect refused ({status})"),
    );
    error.redirect_location = location;
    error
}

fn check_response_target(
    method: &reqwest::Method,
    target: &reqwest::Url,
    response: &reqwest::Response,
) -> Result<(), TransferError> {
    if response.status().is_redirection() || response.url() != target {
        return Err(redirect_error(method, response));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    async fn download_fixture(
        suffix: &str,
        status: &str,
        mime: &str,
        body: &[u8],
    ) -> (Result<(), TransferError>, Vec<u8>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response = [
            format!("HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes(),
            body,
        ].concat();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.read(&mut [0; 2048]).unwrap();
            stream.write_all(&response).unwrap();
        });
        let path = std::env::temp_dir().join(format!("readany-test-{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"old book").unwrap();
        let result = webdav_download_file(
            format!("http://{address}/book.{suffix}"),
            path.to_str().unwrap().into(),
            HashMap::new(),
            None,
            Channel::new(|_| Ok(())),
        )
        .await;
        server.join().unwrap();
        let staged_bytes = std::fs::read(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        (result, staged_bytes)
    }

    #[tokio::test]
    async fn rejects_json_before_opening_the_download_destination() {
        let (result, bytes) = download_fixture(
            "epub",
            "200 OK",
            "application/json",
            br#"{"error":"Login"}"#,
        )
        .await;
        assert_eq!(result.unwrap_err().status, Some(200));
        assert_eq!(bytes, b"old book");
    }

    #[tokio::test]
    async fn accepts_plain_text_starting_with_angle_brackets() {
        let (result, bytes) =
            download_fixture("txt", "200 OK", "text/plain", b"<chapter> is the title").await;
        result.unwrap();
        assert_eq!(bytes, b"<chapter> is the title");
    }

    #[tokio::test]
    async fn rejects_non_zip_and_truncated_epub() {
        for body in [b"Not a ZIP".as_slice(), b"PK\x03\x04"] {
            let (result, _) =
                download_fixture("epub", "200 OK", "application/octet-stream", body).await;
            assert_eq!(result.unwrap_err().status, Some(200));
        }
    }

    #[tokio::test]
    async fn rejects_mimetype_only_epub_zip() {
        let zip = epub_fixture(false);
        let (result, _) = download_fixture("epub", "200 OK", "application/epub+zip", &zip).await;
        assert_eq!(result.unwrap_err().status, Some(200));
    }

    fn epub_fixture(with_container: bool) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", options).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();
        if with_container {
            zip.start_file("META-INF/container.xml", options).unwrap();
            zip.write_all(br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>"#).unwrap();
            zip.start_file("OPS/book.opf", options).unwrap();
            zip.write_all(br#"<package xmlns="http://www.idpf.org/2007/opf"/>"#)
                .unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[tokio::test]
    async fn stages_an_epub_with_a_container_and_package() {
        let zip = epub_fixture(true);
        let (result, bytes) =
            download_fixture("epub", "200 OK", "application/epub+zip", &zip).await;
        result.unwrap();
        assert_eq!(bytes, zip);
    }

    #[tokio::test]
    async fn rejects_disguised_markup_without_touching_destination() {
        let (result, bytes) = download_fixture(
            "txt",
            "200 OK",
            "text/plain",
            b"<!-- gateway --><html>Login</html>",
        )
        .await;
        assert_eq!(result.unwrap_err().status, Some(200));
        assert_eq!(bytes, b"old book");
    }

    #[tokio::test]
    async fn rejects_redirect_and_multistatus_without_touching_destination() {
        for (status, code) in [("302 Found", 302), ("207 Multi-Status", 207)] {
            let (result, bytes) =
                download_fixture("epub", status, "text/plain", b"unexpected").await;
            assert_eq!(result.unwrap_err().status, Some(code));
            assert_eq!(bytes, b"old book");
        }
    }
}

fn unexpected_response(response: &reqwest::Response) -> TransferError {
    let mut error =
        TransferError::with_status(response.status().as_u16(), "Unexpected WebDAV response");
    let url = response.url();
    error.url = Some(format!(
        "{}{}",
        url.origin().ascii_serialization(),
        url.path()
    ));
    error
}

fn content_type(response: &reqwest::Response) -> &str {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
}

fn is_html(mime_type: &str) -> bool {
    mime_type.eq_ignore_ascii_case("text/html")
        || mime_type.eq_ignore_ascii_case("application/xhtml+xml")
}

fn decode_prefix(prefix: &[u8]) -> String {
    if prefix.starts_with(&[0xff, 0xfe]) || prefix.starts_with(&[0xfe, 0xff]) {
        let little_endian = prefix[0] == 0xff;
        let utf16: Vec<u16> = prefix[2..]
            .chunks_exact(2)
            .map(|chunk| {
                if little_endian {
                    u16::from_le_bytes([chunk[0], chunk[1]])
                } else {
                    u16::from_be_bytes([chunk[0], chunk[1]])
                }
            })
            .collect();
        String::from_utf16_lossy(&utf16)
    } else {
        String::from_utf8_lossy(prefix).into_owned()
    }
}

fn skip_markup_preamble(mut start: &str) -> &str {
    loop {
        let end = if start.starts_with("<?xml ") {
            start.find("?>").map(|i| i + 2)
        } else if start.starts_with("<!--") {
            start.find("-->").map(|i| i + 3)
        } else {
            None
        };
        let Some(end) = end else { return start };
        start = start[end..].trim_start();
    }
}

fn is_unexpected_markup(prefix: &[u8], allow_fiction_book: bool) -> bool {
    let decoded = decode_prefix(prefix);
    let mut start = decoded.trim_start_matches('\u{feff}').trim_start();
    if prefix.len() >= BODY_PREFIX_BYTES && start.is_empty() {
        return true;
    }
    if start == "<" || start.eq_ignore_ascii_case("!doctype") {
        return true;
    }
    if !start
        .strip_prefix('<')
        .and_then(|s| s.trim_start().chars().next())
        .is_some_and(|c| c.is_alphabetic() || matches!(c, '!' | '?' | '/'))
    {
        return false;
    }
    if allow_fiction_book {
        start = skip_markup_preamble(start);
        if let Some(tag) = start
            .strip_prefix('<')
            .and_then(|s| s.split(|c: char| c.is_whitespace() || c == '>').next())
        {
            return tag.rsplit(':').next() != Some("FictionBook");
        }
    }
    true
}

fn is_zip_download(extension: &str) -> bool {
    matches!(extension, "epub" | "cbz" | "fbz")
}

fn accepts_download_prefix(extension: &str, prefix: &[u8]) -> bool {
    if prefix.is_empty() {
        return false;
    }
    if is_zip_download(extension) {
        return prefix.starts_with(b"PK\x03\x04");
    }
    if extension != "txt" {
        return !is_unexpected_markup(prefix, extension == "fb2");
    }

    let decoded = decode_prefix(prefix);
    if decoded.bytes().any(|b| matches!(b, 0..=8 | 11 | 14..=31)) {
        return false;
    }
    let start = skip_markup_preamble(decoded.trim_start_matches('\u{feff}').trim_start());
    let Some(tag) = start.strip_prefix('<') else {
        return true;
    };
    let tag = tag
        .trim_start()
        .trim_start_matches('/')
        .to_ascii_lowercase();
    if let Some(doctype) = tag.strip_prefix("!doctype") {
        if doctype.starts_with(char::is_whitespace)
            && doctype
                .split(|c: char| c.is_whitespace() || c == '>')
                .find(|s| !s.is_empty())
                == Some("html")
        {
            return false;
        }
    }
    let name = tag.split_once(|c: char| c.is_whitespace() || matches!(c, '/' | '>'));
    !matches!(
        name,
        Some((
            "html" | "head" | "body" | "title" | "meta" | "script" | "form" | "input" | "iframe",
            _
        ))
    )
}

fn has_bounded_epub_directory(file: &mut std::fs::File) -> std::io::Result<bool> {
    const END_RECORD: usize = 22;
    let size = file.seek(SeekFrom::End(0))?;
    let tail_size = size.min((END_RECORD + u16::MAX as usize) as u64) as usize;
    let mut tail = vec![0; tail_size];
    file.seek(SeekFrom::End(-(tail_size as i64)))?;
    file.read_exact(&mut tail)?;
    file.rewind()?;
    // Check allocation-driving fields before handing the file to zip::ZipArchive.
    // Our size and entry limits fit ZIP32; ZIP64 sentinels here are not needed.
    Ok(tail
        .windows(END_RECORD)
        .enumerate()
        .rev()
        .find_map(|(i, end)| {
            let u16_at = |j| u16::from_le_bytes([end[j], end[j + 1]]);
            let u32_at = |j| u32::from_le_bytes([end[j], end[j + 1], end[j + 2], end[j + 3]]);
            if &end[..4] != b"PK\x05\x06" || i + END_RECORD + u16_at(20) as usize != tail_size {
                return None;
            }
            let entries = u16_at(10);
            let directory_size = u32_at(12);
            Some(
                u16_at(4) == 0
                    && u16_at(6) == 0
                    && u16_at(8) == entries
                    && (1..=MAX_EPUB_ZIP_ENTRIES).contains(&entries)
                    && directory_size <= MAX_EPUB_ZIP_DIRECTORY
                    && u64::from(u32_at(16)) + u64::from(directory_size)
                        == size - tail_size as u64 + i as u64,
            )
        })
        .unwrap_or(false))
}

fn is_nonempty_zip(path: &str, epub: bool) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    if epub && !has_bounded_epub_directory(&mut file).unwrap_or(false) {
        return false;
    }
    let Ok(mut zip) = zip::ZipArchive::new(BufReader::new(file)) else {
        return false;
    };
    let mut has_file = false;
    let central_directory = zip.central_directory_start();
    if epub && zip.len() > usize::from(MAX_EPUB_ZIP_ENTRIES) {
        return false;
    }
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index_raw(i) else {
            return false;
        };
        if entry.data_start().saturating_add(entry.compressed_size()) > central_directory {
            return false;
        }
        if epub && (entry.encrypted() || entry.is_symlink() || entry.enclosed_name().is_none()) {
            return false;
        }
        has_file |= entry.is_file() && entry.size() > 0;
    }
    if !epub {
        return has_file;
    }
    // The Tauri platform service runs the shared OCF/OPF validator on this
    // staging file. Do not maintain a separate XML/deflate implementation here.
    let Some(container_index) = zip.index_for_name("META-INF/container.xml") else {
        return false;
    };
    if !zip.by_index_raw(container_index).is_ok_and(|entry| {
        entry.is_file() && (1..=65536).contains(&entry.size()) && entry.compressed_size() <= 65536
    }) {
        return false;
    }
    let Ok(mime) = zip.by_name("mimetype") else {
        return false;
    };
    let mut bytes = Vec::with_capacity(21);
    mime.is_file()
        && mime.size() == 20
        && mime.compression() == zip::CompressionMethod::Stored
        && mime.take(21).read_to_end(&mut bytes).is_ok()
        && bytes == b"application/epub+zip"
}

async fn validate_upload_response(mut response: reqwest::Response) -> Result<(), TransferError> {
    if !matches!(response.status().as_u16(), 200 | 201 | 204) || is_html(content_type(&response)) {
        return Err(unexpected_response(&response));
    }
    let mut prefix = Vec::with_capacity(BODY_PREFIX_BYTES);
    while prefix.len() < BODY_PREFIX_BYTES {
        let chunk = response
            .chunk()
            .await
            .map_err(|_| unexpected_response(&response))?;
        let Some(chunk) = chunk else {
            break;
        };
        prefix.extend_from_slice(&chunk[..chunk.len().min(BODY_PREFIX_BYTES - prefix.len())]);
    }
    if is_unexpected_markup(&prefix, false) {
        return Err(unexpected_response(&response));
    }
    Ok(())
}

/// Same retry policy as the JS layer: retry transient failures (network
/// errors, 429, 5xx) up to 3 times with exponential backoff; 4xx fails fast.
async fn send_with_retry(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    headers: reqwest::header::HeaderMap,
) -> Result<reqwest::Response, TransferError> {
    let target =
        reqwest::Url::parse(url).map_err(|_| TransferError::new("Invalid WebDAV transfer URL"))?;
    let mut last_error = TransferError::new(format!("WebDAV {method}: no attempt was made"));

    for attempt in 0..DOWNLOAD_MAX_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(retry_delay(attempt)).await;
        }
        let response = match client
            .request(method.clone(), target.clone())
            .headers(headers.clone())
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) => {
                last_error =
                    TransferError::new(format!("WebDAV {method} failed: {}", e.without_url()));
                continue;
            }
        };
        check_response_target(&method, &target, &response)?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let error = TransferError::with_status(
            status.as_u16(),
            format!("WebDAV {method} failed: {status}"),
        );
        if is_retryable_status(status) {
            last_error = error;
            continue;
        }
        return Err(error);
    }

    Err(last_error)
}

/// PUT a local file as a stream, reopening it for every retry. `Content-Length`
/// is set from the file metadata so servers that reject chunked PUTs keep
/// working.
async fn upload_file_with_retry(
    client: &reqwest::Client,
    url: &str,
    headers: reqwest::header::HeaderMap,
    file_path: &str,
) -> Result<(), TransferError> {
    let target =
        reqwest::Url::parse(url).map_err(|_| TransferError::new("Invalid WebDAV transfer URL"))?;
    let mut last_error = TransferError::new("WebDAV PUT: no attempt was made");

    for attempt in 0..UPLOAD_MAX_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(retry_delay(attempt)).await;
        }

        let file = tokio::fs::File::open(file_path)
            .await
            .map_err(|e| TransferError::new(format!("Failed to open upload file: {}", e.kind())))?;
        let total = file
            .metadata()
            .await
            .map_err(|e| {
                TransferError::new(format!(
                    "Failed to determine upload file size: {}",
                    e.kind()
                ))
            })?
            .len();
        if total > MAX_UPLOAD_BYTES {
            return Err(TransferError::new(format!(
                "Upload file is {total} bytes, exceeding the 2 GiB streaming limit"
            )));
        }

        let response = client
            .put(target.clone())
            .headers(headers.clone())
            .header(reqwest::header::CONTENT_LENGTH, total)
            .body(reqwest::Body::wrap_stream(ReaderStream::with_capacity(
                file.take(total),
                64 * 1024,
            )))
            .send()
            .await;

        let response = match response {
            Ok(response) => response,
            Err(e) => {
                // The stream is consumed; the next attempt reopens the file.
                last_error = TransferError::new(format!("WebDAV PUT failed: {}", e.without_url()));
                continue;
            }
        };

        check_response_target(&reqwest::Method::PUT, &target, &response)?;
        let status = response.status();
        if status.is_success() {
            return validate_upload_response(response).await;
        }
        let error =
            TransferError::with_status(status.as_u16(), format!("WebDAV PUT failed: {status}"));
        if is_retryable_status(status) {
            last_error = error;
            continue;
        }
        return Err(error);
    }

    Err(last_error)
}

/// Stream a local file to the server via PUT. The file is read on the Rust
/// side chunk by chunk; the webview only receives success/failure.
#[tauri::command(async)]
pub async fn webdav_upload_file(
    url: String,
    file_path: String,
    headers: HashMap<String, String>,
    allow_insecure: Option<bool>,
) -> Result<(), TransferError> {
    let client = build_client(allow_insecure)?;
    upload_file_with_retry(&client, &url, to_header_map(&headers), &file_path).await
}

/// Stream a server file to a staged path via GET, reporting progress over the
/// IPC channel (the JS side throttles UI updates).
#[tauri::command(async)]
pub async fn webdav_download_file(
    url: String,
    file_path: String,
    headers: HashMap<String, String>,
    allow_insecure: Option<bool>,
    on_progress: Channel<TransferProgress>,
) -> Result<(), TransferError> {
    let client = build_client(allow_insecure)?;
    let mut response =
        send_with_retry(&client, reqwest::Method::GET, &url, to_header_map(&headers)).await?;

    let extension = response
        .url()
        .path()
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = content_type(&response).to_ascii_lowercase();
    if response.status().as_u16() != 200
        || is_html(&mime)
        || (extension != "json" && (mime.ends_with("/json") || mime.ends_with("+json")))
    {
        return Err(unexpected_response(&response));
    }

    let total = response.content_length().unwrap_or(0);
    if total > MAX_DOWNLOAD_BYTES {
        return Err(unexpected_response(&response));
    }
    let mut prefix = Vec::with_capacity(BODY_PREFIX_BYTES);
    let mut remainder = None;
    while prefix.len() < BODY_PREFIX_BYTES {
        let Some(chunk) = response.chunk().await.map_err(|e| {
            TransferError::new(format!("download read failed: {}", e.without_url()))
        })?
        else {
            break;
        };
        let size = chunk.len().min(BODY_PREFIX_BYTES - prefix.len());
        prefix.extend_from_slice(&chunk[..size]);
        if size < chunk.len() {
            remainder = Some(chunk.slice(size..));
        }
    }
    if !accepts_download_prefix(&extension, &prefix) {
        return Err(unexpected_response(&response));
    }

    if let Some(parent) = std::path::Path::new(&file_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| TransferError::new(format!("failed to create {parent:?}: {e}")))?;
    }
    let mut file = tokio::fs::File::create(&file_path)
        .await
        .map_err(|e| TransferError::new(format!("failed to create {file_path}: {e}")))?;

    file.write_all(&prefix)
        .await
        .map_err(|e| TransferError::new(format!("download write failed: {e}")))?;
    let mut loaded = prefix.len() as u64;
    if let Some(chunk) = remainder {
        file.write_all(&chunk)
            .await
            .map_err(|e| TransferError::new(format!("download write failed: {e}")))?;
        loaded += chunk.len() as u64;
    }
    let _ = on_progress.send(TransferProgress { loaded, total });
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| TransferError::new(format!("download read failed: {}", e.without_url())))?
    {
        if loaded + chunk.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err(unexpected_response(&response));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| TransferError::new(format!("download write failed: {e}")))?;
        loaded += chunk.len() as u64;
        let _ = on_progress.send(TransferProgress { loaded, total });
    }
    file.flush()
        .await
        .map_err(|e| TransferError::new(format!("download flush failed: {e}")))?;
    drop(file);
    let epub = extension == "epub";
    if is_zip_download(&extension)
        && !tokio::task::spawn_blocking(move || is_nonempty_zip(&file_path, epub))
            .await
            .unwrap_or(false)
    {
        return Err(unexpected_response(&response));
    }
    Ok(())
}
