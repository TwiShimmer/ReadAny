//! Native WebDAV file transfer for large book/cover files.
//!
//! Streams directly between disk and the HTTP server inside Rust so
//! multi-megabyte payloads never enter the webview's JS heap — plugin-http
//! serializes request bodies as JS number arrays on the renderer main
//! thread, which froze the whole app during library sync.

use std::collections::HashMap;

use tauri::ipc::Channel;
use tauri_plugin_http::reqwest;
use tokio_util::io::ReaderStream;

const TRANSFER_TIMEOUT_SECS: u64 = 300;
const MAX_ATTEMPTS: u32 = 3;
const BASE_DELAY_MS: u64 = 500;

/// Serialized to the webview as `{ status, message }` so the JS layer can
/// branch on the HTTP status without matching message text.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TransferError {
    status: Option<u16>,
    message: String,
}

impl TransferError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
        }
    }

    fn with_status(status: u16, message: impl Into<String>) -> Self {
        Self {
            status: Some(status),
            message: message.into(),
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
        .timeout(std::time::Duration::from_secs(TRANSFER_TIMEOUT_SECS));
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

/// Same retry policy as the JS layer: retry transient failures (network
/// errors, 429, 5xx) up to 3 times with exponential backoff; 4xx fails fast.
async fn send_with_retry(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    headers: reqwest::header::HeaderMap,
) -> Result<reqwest::Response, TransferError> {
    let mut last_error =
        TransferError::new(format!("WebDAV {method} failed for {url}: no attempt was made"));

    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(retry_delay(attempt)).await;
        }
        let response = match client
            .request(method.clone(), url)
            .headers(headers.clone())
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) => {
                last_error = TransferError::new(format!("WebDAV {method} failed for {url}: {e}"));
                continue;
            }
        };
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let error = TransferError::with_status(
            status.as_u16(),
            format!("WebDAV {method} failed for {url}: {status}"),
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
    let mut last_error = TransferError::new(format!("WebDAV PUT failed for {url}: no attempt was made"));

    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(retry_delay(attempt)).await;
        }

        let file = tokio::fs::File::open(file_path)
            .await
            .map_err(|e| TransferError::new(format!("failed to open {file_path}: {e}")))?;
        let total = file
            .metadata()
            .await
            .map_err(|e| TransferError::new(format!("failed to stat {file_path}: {e}")))?
            .len();

        let response = client
            .put(url)
            .headers(headers.clone())
            .header(reqwest::header::CONTENT_LENGTH, total)
            .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
            .send()
            .await;

        let response = match response {
            Ok(response) => response,
            Err(e) => {
                // The stream is consumed; the next attempt reopens the file.
                last_error = TransferError::new(format!("WebDAV PUT failed for {url}: {e}"));
                continue;
            }
        };

        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let error = TransferError::with_status(
            status.as_u16(),
            format!("WebDAV PUT failed for {url}: {status}"),
        );
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

/// Stream a server file to local disk via GET, reporting progress over the
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
    let mut response = send_with_retry(
        &client,
        reqwest::Method::GET,
        &url,
        to_header_map(&headers),
    )
    .await?;

    let total = response.content_length().unwrap_or(0);
    if let Some(parent) = std::path::Path::new(&file_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| TransferError::new(format!("failed to create {parent:?}: {e}")))?;
    }
    let mut file = tokio::fs::File::create(&file_path)
        .await
        .map_err(|e| TransferError::new(format!("failed to create {file_path}: {e}")))?;

    let mut loaded: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| TransferError::new(format!("download read failed: {e}")))?
    {
        {
            use tokio::io::AsyncWriteExt;
            file.write_all(&chunk)
                .await
                .map_err(|e| TransferError::new(format!("download write failed: {e}")))?;
        }
        loaded += chunk.len() as u64;
        let _ = on_progress.send(TransferProgress { loaded, total });
    }
    {
        use tokio::io::AsyncWriteExt;
        file.flush()
            .await
            .map_err(|e| TransferError::new(format!("download flush failed: {e}")))?;
    }
    Ok(())
}
