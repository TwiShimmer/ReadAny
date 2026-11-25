/**
 * WebDAV client using IPlatformService.fetch() — works on both Tauri and Expo.
 * WebDAV is HTTP with custom methods (PROPFIND, MKCOL, PUT, GET, DELETE).
 */

// React Native/Metro cannot resolve the Node `node:buffer` protocol import.
// biome-ignore lint/style/useNodejsImportProtocol: Expo needs the buffer polyfill package name.
import { Buffer } from "buffer";
import i18n from "../i18n";
import { FileTransferError, getPlatformService } from "../services/platform";
import type { DavResource } from "./sync-types";

function stripControlChars(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return (code >= 0x20 && code !== 0x7f) || code > 0x7f;
    })
    .join("");
}

export function sanitizeWebDavUrl(url: string): string {
  return stripControlChars(url).trim().replace(/\/+$/, "");
}

export function sanitizeWebDavRemoteRoot(remoteRoot: string): string {
  const normalized = stripControlChars(remoteRoot)
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
  return normalized;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 300_000;
const DIRECTORY_PROBE_TIMEOUT_MS = 5_000;

/**
 * Retry policy for transient HTTP failures (401-after-auth, 429, 5xx).
 * `RETRY_MAX_RETRIES = 3` means the initial request plus at most 3 retries
 * (4 attempts total), with 500ms → 1s → 2s backoff. Network/timeout errors are
 * NOT retried — they may have consumed the full timeout already, so retrying
 * would amplify latency. Issue #195 motivated this: Chinese WebDAV providers
 * (Jianguoyun, NAS) reject with 401 under burst load even though credentials
 * are valid.
 */
const RETRY_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
/** Minimum pause between a failed PUT and the single directory/auth retry. */
const UPLOAD_HEAL_DELAY_MS = 200;

type WebDavErrorKind =
  | "auth"
  | "redirect"
  | "unexpected-response"
  | "forbidden"
  | "not-found"
  | "method-not-allowed"
  | "timeout"
  | "network"
  | "tls"
  | "server"
  | "http";

export class WebDavError extends Error {
  readonly kind: WebDavErrorKind;
  readonly status?: number;
  readonly method?: string;
  readonly url?: string;
  readonly cause?: unknown;

  constructor(
    kind: WebDavErrorKind,
    message: string,
    options?: {
      status?: number;
      method?: string;
      url?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "WebDavError";
    this.kind = kind;
    this.status = options?.status;
    this.method = options?.method;
    this.url = options?.url;
    this.cause = options?.cause;
  }
}

function summarizeStatus(status: number, statusText?: string): string {
  return [status, statusText?.trim()].filter(Boolean).join(" ");
}

function redirectError(
  method: string,
  url: string,
  status: number,
  location?: string,
): WebDavError {
  let destination: string | undefined;
  try {
    if (location) {
      const target = new URL(location, url);
      if (target.protocol === "https:" || target.protocol === "http:") {
        destination = `${target.origin}${target.pathname}`;
      }
    }
  } catch {
    // Preserve the HTTP status when the server's Location is malformed.
  }
  return new WebDavError(
    "redirect",
    i18n.t("settings.syncWebdavRedirect", {
      defaultValue: "WebDAV redirect refused (HTTP {{status}}). Check the server URL.",
      status,
    }),
    { status, method, url, cause: destination },
  );
}

function unexpectedResponse(method: string, url: string, status: number): WebDavError {
  return new WebDavError(
    "unexpected-response",
    i18n.t("settings.syncWebdavUnexpectedResponse", {
      defaultValue:
        "The server returned an unexpected WebDAV response (HTTP {{status}}). Check the server URL and sign-in configuration.",
      status,
    }),
    { status, method, url },
  );
}

function toCollectionPath(path: string): string {
  if (path === "/") return "/";
  return path.endsWith("/") ? path : `${path}/`;
}

function getParentCollectionPath(path: string): { parent: string; name: string } | null {
  const collectionPath = toCollectionPath(path);
  if (collectionPath === "/") return null;

  const trimmed = collectionPath.replace(/\/+$/g, "");
  const lastSlash = trimmed.lastIndexOf("/");
  const name = trimmed.slice(lastSlash + 1);
  const parent = lastSlash <= 0 ? "/" : trimmed.slice(0, lastSlash);
  return { parent: toCollectionPath(parent), name };
}

/**
 * Statuses real-world WebDAV servers return when the parent collection of a
 * PUT target is missing (or the probe claiming it exists was wrong). 403 is
 * deliberately excluded: it means permission/read-only/quota/WAF, and running
 * MKCOL over every ancestor would hide that real cause.
 */
function isMissingParentStatus(status: number | undefined): boolean {
  return status === 404 || status === 409;
}

function uploadHealDelay(): Promise<void> {
  const jitter = Math.floor(Math.random() * 100);
  return new Promise((resolve) => setTimeout(resolve, UPLOAD_HEAL_DELAY_MS + jitter));
}

function createHttpWebDavError(
  status: number,
  statusText: string | undefined,
  method: string,
  url: string,
): WebDavError {
  const statusSummary = summarizeStatus(status, statusText);
  switch (status) {
    case 401:
      return new WebDavError(
        "auth",
        i18n.t("settings.syncWebdavAuthFailed", {
          defaultValue: "WebDAV 认证失败，请检查用户名和应用密码是否正确。",
        }),
        { status, method, url },
      );
    case 403:
      return new WebDavError(
        "forbidden",
        i18n.t("settings.syncWebdavForbidden", {
          defaultValue: "WebDAV 访问被拒绝，请检查当前账号是否有这个路径的权限。",
        }),
        { status, method, url },
      );
    case 404:
      return new WebDavError(
        "not-found",
        i18n.t("settings.syncWebdavNotFound", {
          defaultValue: "WebDAV 地址或路径不存在，请检查服务器地址和根路径。",
        }),
        { status, method, url },
      );
    case 405:
      return new WebDavError(
        "method-not-allowed",
        i18n.t("settings.syncWebdavMethodNotAllowed", {
          defaultValue: "服务器没有正确响应 WebDAV 请求，请确认 WebDAV 服务已经开启。",
        }),
        { status, method, url },
      );
    default:
      if (status >= 500) {
        return new WebDavError(
          "server",
          i18n.t("settings.syncWebdavServerError", {
            defaultValue: "WebDAV 服务器异常（{{status}}）。",
            status: statusSummary,
          }),
          { status, method, url },
        );
      }
      return new WebDavError(
        "http",
        i18n.t("settings.syncWebdavHttpError", {
          defaultValue: "WebDAV 请求失败（{{status}}）。",
          status: statusSummary,
        }),
        { status, method, url },
      );
  }
}

function createRequestWebDavError(
  error: unknown,
  method: string,
  url: string,
  timeoutMs: number,
): WebDavError {
  if (error instanceof WebDavError) return error;
  const err = error as { name?: string; message?: string; cause?: { code?: string } };
  const lowerMessage = err.message?.toLowerCase() ?? "";
  const connectionMessage = i18n.t("settings.syncWebdavNetworkError", {
    defaultValue: "无法连接到 WebDAV 服务器，请检查网络、地址、端口或证书配置。",
  });

  if (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("timed out") ||
    lowerMessage.includes("aborted")
  ) {
    return new WebDavError(
      "timeout",
      i18n.t("settings.syncWebdavTimeout", {
        defaultValue: "WebDAV 连接超时（{{seconds}} 秒），请检查服务器地址、端口和网络。",
        seconds: Math.max(1, Math.round(timeoutMs / 1000)),
      }),
      { method, url, cause: error },
    );
  }

  if (
    lowerMessage.includes("certificate") ||
    lowerMessage.includes("ssl") ||
    lowerMessage.includes("tls")
  ) {
    return new WebDavError(
      "tls",
      i18n.t("settings.syncWebdavTlsError", {
        defaultValue: "WebDAV TLS 证书校验失败，请检查证书，或开启允许不安全连接后再试。",
      }),
      { method, url, cause: error },
    );
  }

  if (
    err.cause?.code === "ECONNREFUSED" ||
    err.cause?.code === "EHOSTUNREACH" ||
    err.cause?.code === "ENOTFOUND" ||
    lowerMessage.includes("configured scope") ||
    lowerMessage.includes("url not allowed") ||
    lowerMessage.includes("status 0") ||
    lowerMessage.includes("xhr request failed") ||
    lowerMessage.includes("network request failed") ||
    lowerMessage.includes("failed to fetch") ||
    lowerMessage.includes("connect")
  ) {
    const message =
      lowerMessage.includes("configured scope") || lowerMessage.includes("url not allowed")
        ? i18n.t("settings.syncWebdavDesktopScopeError", {
            defaultValue:
              "桌面端当前没有放行这个 WebDAV 地址，请更新到最新版本后重试，或重新启动应用。",
          })
        : connectionMessage;
    return new WebDavError("network", message, {
      method,
      url,
      cause: error,
    });
  }

  return new WebDavError(
    "network",
    i18n.t("settings.syncWebdavUnknownError", {
      defaultValue: "WebDAV 请求失败：{{message}}",
      message: err.message || connectionMessage,
    }),
    { method, url, cause: error },
  );
}

/**
 * Keep the original PUT failure as the surfaced error; the directory-heal
 * failure is diagnostic context, not the cause of the upload failure.
 */
function withHealCause(error: WebDavError, healError: unknown): WebDavError {
  return new WebDavError(error.kind, error.message, {
    status: error.status,
    method: error.method,
    url: error.url,
    cause: healError,
  });
}

type WebDavRequestOptions = {
  body?: string | Uint8Array | ArrayBuffer;
  headers?: Record<string, string>;
  contentType?: string;
  timeoutMs?: number;
  responseType?: "text" | "arraybuffer";
  onDownloadProgress?: (loaded: number, total: number) => void;
};

export class WebDavClient {
  private baseUrl: string;
  private authHeader: string;
  private allowInsecure: boolean;
  /**
   * Flips to true after a DAV multistatus response or a successful write. A 401 is
   * treated as a server-side throttle (retry-worthy) rather than a credential
   * failure. Reset per WebDavClient instance.
   */
  private hadAuthSuccess = false;
  /**
   * Collections confirmed to exist during this client's lifetime (PROPFIND
   * probe or successful MKCOL). Lets ensureDirectory() skip re-probing paths
   * it created minutes ago and keeps the retry helpers cheap.
   */
  private knownCollections = new Set<string>();

  constructor(url: string, username: string, password: string, allowInsecure?: boolean) {
    // Normalize: remove control chars/whitespace and trailing slash
    this.baseUrl = sanitizeWebDavUrl(url);
    // Basic auth header
    const credentials = `${username}:${password}`;
    // Use UTF-8 safe base64 encoding; btoa is unreliable in React Native/Android.
    const encoded = Buffer.from(credentials, "utf8").toString("base64");
    this.authHeader = `Basic ${encoded}`;
    this.allowInsecure = allowInsecure ?? false;
    if (this.allowInsecure) {
      console.warn(
        "[WebDAV] allowInsecure is enabled: TLS certificate checks are disabled and HTTPS may be downgraded to HTTP for this server. Use only on a trusted network.",
      );
    }
  }

  private getTimeout(method: string, explicitTimeoutMs?: number): number {
    if (explicitTimeoutMs !== undefined) return explicitTimeoutMs;
    const isTransferOperation = method === "PUT" || method === "GET";
    return isTransferOperation ? TRANSFER_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  }

  private buildUrl(path: string): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    // Encode path segments but preserve /
    const encoded = normalizedPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${this.baseUrl}${encoded}`;
  }

  private getAuthHeaders(): Record<string, string> {
    return { Authorization: this.authHeader };
  }

  /** True if the status code indicates a transient, retry-worthy failure. */
  private isTransientStatus(status: number): boolean {
    // 401 BEFORE any successful auth = real credential failure, do not retry.
    // 401 AFTER a successful response = server is throttling / temporarily
    // rejecting valid credentials under burst load (Jianguoyun, some NAS).
    if (status === 401 && this.hadAuthSuccess) return true;
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }

  private async doFetch(
    method: string,
    path: string,
    options: WebDavRequestOptions,
  ): Promise<Response> {
    const platform = getPlatformService();
    const url = this.buildUrl(path);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      ...options.headers,
    };
    if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    }
    const effectiveTimeoutMs = this.getTimeout(method, options.timeoutMs);
    const response = await platform.fetch(url, {
      method,
      redirect: "error",
      headers,
      body: options.body as BodyInit | undefined,
      allowInsecure: this.allowInsecure,
      timeoutMs: effectiveTimeoutMs,
      responseType: options.responseType,
      onDownloadProgress: options.onDownloadProgress,
    });
    const expectedUrl =
      platform.isMobile && this.allowInsecure ? url.replace(/^https:\/\//i, "http://") : url;
    const changedDestination =
      response.url && new URL(response.url).href !== new URL(expectedUrl).href;
    if (
      (response.status >= 300 && response.status < 400) ||
      response.type === "opaqueredirect" ||
      response.redirected ||
      changedDestination
    ) {
      const target = changedDestination ? response.url : undefined;
      throw redirectError(method, url, response.status, response.headers.get("Location") ?? target);
    }
    if (!response.ok) return response;

    const writes =
      method === "PUT" || method === "MKCOL" || method === "MOVE" || method === "DELETE";
    const contentType = response.headers.get("Content-Type") ?? "";
    if (
      (writes || method === "PROPFIND" || method === "HEAD") &&
      /^(text\/html|application\/xhtml\+xml)\b/i.test(contentType)
    ) {
      throw unexpectedResponse(method, url, response.status);
    }
    if (
      writes &&
      response.status === 200 &&
      /^\s*(?:<!doctype\s+html\b|<html\b|<form\b)/i.test(await response.text())
    ) {
      throw unexpectedResponse(method, url, response.status);
    }
    if ((method === "PROPFIND" && response.status !== 207) || (writes && response.status === 207)) {
      throw unexpectedResponse(method, url, response.status);
    }
    if (
      writes ||
      (method === "PROPFIND" && (response.headers.has("DAV") || /\bxml\b/i.test(contentType)))
    ) {
      this.hadAuthSuccess = true;
    }
    return response;
  }

  private async request(
    method: string,
    path: string,
    options: WebDavRequestOptions = {},
    maxRetries = RETRY_MAX_RETRIES,
  ): Promise<Response> {
    const logPath = path.startsWith("/") ? path : `/${path}`;
    console.log(`[WebDAV] ${method} ${logPath}`);

    for (let attempt = 0; ; attempt++) {
      const startTime = Date.now();
      try {
        const response = await this.doFetch(method, path, options);
        const elapsed = Date.now() - startTime;
        console.log(
          `[WebDAV] ${method} ${logPath} completed in ${elapsed}ms (status: ${response.status})`,
        );

        if (attempt < maxRetries && this.isTransientStatus(response.status)) {
          const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
          console.warn(
            `[WebDAV] ${method} ${logPath} got ${response.status}, retrying in ${delay}ms (retry ${attempt + 1}/${maxRetries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        return response;
      } catch (error: unknown) {
        const elapsed = Date.now() - startTime;
        const webDavError = createRequestWebDavError(
          error,
          method,
          this.buildUrl(path),
          this.getTimeout(method, options.timeoutMs),
        );
        console.error(
          `[WebDAV] ${method} ${logPath} failed (${webDavError.kind}) after ${elapsed}ms:`,
          webDavError.status,
          webDavError.kind === "redirect" ? webDavError.cause : undefined,
        );
        throw webDavError;
      }
    }
  }

  /**
   * Test if the server is reachable and credentials are valid. Pass `path` when
   * baseUrl is the bare origin; the default "/" probes the root, which
   * subpath-only servers (e.g. Jianguoyun /dav/) reject.
   */
  async ping(path = "/"): Promise<void> {
    const resp = await this.request("PROPFIND", path, {
      headers: { Depth: "0" },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
      contentType: "application/xml",
      timeoutMs: 10_000,
    });
    if (resp.ok || resp.status === 207) {
      return;
    }
    throw createHttpWebDavError(resp.status, resp.statusText, "PROPFIND", this.buildUrl(path));
  }

  /** Test connection, returns true if successful */
  async testConnection(): Promise<boolean> {
    await this.ping();
    return true;
  }

  /** Create a directory (MKCOL) */
  async mkcol(path: string): Promise<void> {
    const collectionPath = toCollectionPath(path);
    let resp: Response;
    try {
      resp = await this.request("MKCOL", collectionPath);
    } catch (e) {
      if (
        e instanceof WebDavError &&
        e.kind === "network" &&
        (await this.collectionExists(collectionPath))
      ) {
        console.warn(`[WebDAV] MKCOL ${path} failed but directory exists; continuing`);
        this.knownCollections.add(collectionPath);
        return;
      }
      throw e;
    }
    const status = resp.status;
    if (resp.ok || status === 201) {
      this.knownCollections.add(collectionPath);
      return;
    }
    if (status === 409) {
      await this.mkcolChain(collectionPath, true);
      return;
    }
    await this.confirmCollection(collectionPath, resp);
  }

  private async confirmCollection(path: string, response: Response): Promise<void> {
    if (response.ok) {
      this.knownCollections.add(path);
      return;
    }
    if (response.status === 401 || response.status === 403 || response.status === 405) {
      if (await this.collectionExists(path)) this.knownCollections.add(path);
      else if (response.status !== 405) throw this.createStatusError("MKCOL", path, response);
      return;
    }
    throw this.createStatusError("MKCOL", path, response);
  }

  private async mkcolChain(path: string, recheck: boolean): Promise<void> {
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current += `/${segment}`;
      const collectionPath = toCollectionPath(current);
      if (recheck) this.knownCollections.delete(collectionPath);
      if (this.knownCollections.has(collectionPath)) continue;
      const exists = recheck
        ? await this.propfindExistsStrict(collectionPath)
        : await this.propfindExists(collectionPath);
      if (exists) {
        this.knownCollections.add(collectionPath);
        continue;
      }
      if (recheck) {
        const response = await this.request("MKCOL", collectionPath);
        await this.confirmCollection(collectionPath, response);
      } else {
        await this.mkcol(collectionPath);
      }
    }
  }

  /**
   * Recheck the target before creating it. An MKCOL 409 rechecks ancestors.
   */
  private async recreateCollection(path: string): Promise<void> {
    this.knownCollections.delete(toCollectionPath(path));
    if (await this.propfindExistsStrict(path)) {
      this.knownCollections.add(toCollectionPath(path));
      return;
    }
    await this.mkcol(path);
  }

  /** Ensure a full directory path exists (creates each segment) */
  async ensureDirectory(path: string): Promise<void> {
    await this.mkcolChain(path, false);
  }

  /** Upload data to a path (PUT) */
  async put(
    path: string,
    data: string | Uint8Array | ArrayBuffer,
    contentType = "application/octet-stream",
  ): Promise<void> {
    const parent = getParentCollectionPath(path)?.parent;
    let healed = false;
    for (let attempt = 0; ; attempt++) {
      const response = await this.request("PUT", path, { body: data, contentType }, 0);
      if (response.ok) return;
      const error = this.createStatusError("PUT", path, response);
      if (attempt === RETRY_MAX_RETRIES) throw error;

      if (!healed && parent && parent !== "/" && isMissingParentStatus(response.status)) {
        await this.healUploadParent(parent, error);
        healed = true;
        continue;
      }
      if (!this.isTransientStatus(response.status)) throw error;

      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private async healUploadParent(parent: string, error: WebDavError): Promise<void> {
    await uploadHealDelay();
    try {
      await this.recreateCollection(parent);
    } catch (healError) {
      throw withHealCause(error, healError);
    }
  }

  /** Upload a local file with one shared retry for throttled auth or a missing parent. */
  async putFile(
    path: string,
    localFilePath: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<void> {
    const platform = getPlatformService();
    // `.bind(platform)` keeps the adapter's `this`; a bare detached function
    // breaks adapters that read instance state.
    const uploadFile = platform.uploadFile?.bind(platform);
    if (!uploadFile) {
      throw new Error("Platform does not support direct file upload");
    }

    const url = this.buildUrl(path);
    const logPath = path.startsWith("/") ? path : `/${path}`;
    const parent = getParentCollectionPath(path)?.parent;

    // Best effort: some servers reject MKCOL for an existing collection with
    // 401/403/405 but still accept the PUT. Creating the directory must never
    // block an upload that used to work.
    if (parent && parent !== "/") {
      try {
        await this.ensureDirectory(parent);
      } catch (error) {
        if (!(error instanceof WebDavError) || !this.canTryPutAfterPreflight(error)) throw error;
        console.warn(
          `[WebDAV] Directory preflight ${parent} was inconclusive; trying PUT (${error.status ?? error.kind})`,
        );
      }
    }

    const uploadOnce = async (): Promise<void> => {
      const startTime = Date.now();
      console.log(`[WebDAV] PUT ${logPath} (file upload)`);
      try {
        await uploadFile(url, localFilePath, {
          headers: {
            ...this.getAuthHeaders(),
            "Content-Type": "application/octet-stream",
          },
          allowInsecure: this.allowInsecure,
          rejectRedirects: true,
          onProgress,
        });
      } catch (error) {
        throw this.toWebDavTransferError(error, "PUT", url);
      }
      this.hadAuthSuccess = true;
      console.log(`[WebDAV] PUT ${logPath} completed in ${Date.now() - startTime}ms`);
    };

    // At most 2 streamed PUT attempts: one transient-401 retry or one
    // directory heal. Rust may retry transient failures inside each attempt.
    try {
      await uploadOnce();
      return;
    } catch (error) {
      if (!(error instanceof WebDavError) || error.kind === "redirect") throw error;
      if (error.status === 401 && this.hadAuthSuccess) {
        await uploadHealDelay();
      } else if (parent && parent !== "/" && isMissingParentStatus(error.status)) {
        await this.healUploadParent(parent, error);
      } else {
        throw error;
      }
    }
    await uploadOnce();
  }

  private canTryPutAfterPreflight(error: WebDavError): boolean {
    return (
      error.kind === "auth" ||
      error.kind === "forbidden" ||
      error.kind === "method-not-allowed" ||
      error.kind === "network" ||
      error.kind === "timeout"
    );
  }

  private toWebDavTransferError(error: unknown, method: string, url: string): WebDavError {
    if (error instanceof FileTransferError) {
      if (error.redirectLocation || (error.status && error.status >= 300 && error.status < 400)) {
        return redirectError(method, url, error.status ?? 0, error.redirectLocation);
      }
      if (error.status && error.status >= 200 && error.status < 300) {
        return unexpectedResponse(method, url, error.status);
      }
      // A zero/absent status means the request never reached the server.
      if (error.status !== undefined && error.status > 0) {
        return createHttpWebDavError(error.status, undefined, method, url);
      }
    }
    return createRequestWebDavError(error, method, url, TRANSFER_TIMEOUT_MS);
  }

  /** Upload a JSON object */
  async putJSON(path: string, data: unknown): Promise<void> {
    await this.put(path, JSON.stringify(data), "application/json");
  }

  /**
   * Error for a failed HTTP verb response. Message keeps the legacy
   * "WebDAV <METHOD> failed for <path>: <status> ..." format for logs, while
   * `status`/`kind` drive every retry and not-found decision.
   */
  private createStatusError(method: string, path: string, resp: Response): WebDavError {
    const url = this.buildUrl(path);
    if (resp.status === 401 || resp.status === 403 || resp.status === 404 || resp.status === 405) {
      const httpError = createHttpWebDavError(resp.status, resp.statusText, method, url);
      return new WebDavError(httpError.kind, `${httpError.message} (${method} ${path})`, {
        status: resp.status,
        method,
        url,
      });
    }

    const kind: WebDavErrorKind = resp.status >= 500 ? "server" : "http";
    return new WebDavError(
      kind,
      `WebDAV ${method} failed for ${path}: ${resp.status} ${resp.statusText || ""}`,
      { status: resp.status, method, url },
    );
  }

  /** Download data from a path (GET) — returns Uint8Array */
  async get(path: string): Promise<Uint8Array> {
    const resp = await this.request("GET", path, {
      responseType: "arraybuffer",
    });
    if (!resp.ok) {
      throw this.createStatusError("GET", path, resp);
    }
    const buffer = await resp.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /** Download data with progress reporting */
  async getWithProgress(
    path: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<Uint8Array> {
    const logPath = path.startsWith("/") ? path : `/${path}`;
    console.log(`[WebDAV] GET ${logPath} (with progress)`);
    const startTime = Date.now();

    try {
      const resp = await this.doFetch("GET", path, {
        timeoutMs: TRANSFER_TIMEOUT_MS,
        responseType: "arraybuffer",
        onDownloadProgress: onProgress,
      });

      const elapsed = Date.now() - startTime;
      if (!resp.ok) {
        console.error(`[WebDAV] GET ${logPath} failed after ${elapsed}ms: ${resp.status}`);
        throw this.createStatusError("GET", path, resp);
      }
      console.log(`[WebDAV] GET ${logPath} completed in ${elapsed}ms (status: ${resp.status})`);
      const buffer = await resp.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (error: unknown) {
      const msg = (error as { message?: string })?.message ?? "";
      // Tauri/Chromium rejects response headers containing non-ISO-8859-1
      // characters (e.g. Chinese filenames in Content-Disposition). When this
      // happens, fall back to the regular `get()` which goes through
      // `request()` and has retry protection. Progress reporting is lost but
      // the download still succeeds.
      if (
        msg.includes("ISO-8859-1") ||
        msg.includes("non ISO") ||
        msg.includes("Failed to construct 'Headers'")
      ) {
        console.warn(
          `[WebDAV] GET ${logPath} failed due to non-ASCII response headers; falling back to get() without progress`,
        );
        return this.get(path);
      }
      throw error;
    }
  }

  async getFileToPath(
    path: string,
    localFilePath: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<void> {
    const platform = getPlatformService();
    if (!platform.downloadFile) {
      throw new Error("Platform does not support direct file download");
    }

    const url = this.buildUrl(path);
    const logPath = path.startsWith("/") ? path : `/${path}`;
    console.log(`[WebDAV] GET ${logPath} (file download)`);
    const startTime = Date.now();
    try {
      await platform.downloadFile(url, localFilePath, {
        headers: this.getAuthHeaders(),
        allowInsecure: this.allowInsecure,
        onProgress,
      });
    } catch (error) {
      throw this.toWebDavTransferError(error, "GET", url);
    }
    console.log(`[WebDAV] GET ${logPath} completed in ${Date.now() - startTime}ms`);
  }

  /** Download text content from a path (GET) */
  async getText(path: string): Promise<string> {
    const resp = await this.request("GET", path, {
      responseType: "text",
    });
    if (!resp.ok) {
      throw this.createStatusError("GET", path, resp);
    }
    return resp.text();
  }

  /** Download and parse JSON from a path */
  async getJSON<T>(path: string): Promise<T | null> {
    try {
      const text = await this.getText(path);
      return JSON.parse(text) as T;
    } catch (e: unknown) {
      // 404/409 mean "not there yet" for callers like the device snapshot and
      // the remote file manifest. Check the attached status instead of string
      // matching so paths that happen to contain "404" can't fake a miss.
      if (e instanceof WebDavError && e.kind !== "redirect" && isMissingParentStatus(e.status)) {
        return null;
      }
      throw e;
    }
  }

  /** Delete a resource (DELETE) */
  async delete(path: string): Promise<void> {
    const resp = await this.request("DELETE", path);
    // 204 No Content or 404 Not Found — both OK for delete
    if (!resp.ok && resp.status !== 404) {
      throw this.createStatusError("DELETE", path, resp);
    }
  }

  /**
   * Move/rename a resource (MOVE).
   * `Overwrite: F` instructs the server to refuse if `toPath` already exists.
   */
  async move(fromPath: string, toPath: string): Promise<void> {
    const destination = this.buildUrl(toPath);
    const resp = await this.request("MOVE", fromPath, {
      headers: {
        Destination: destination,
        Overwrite: "F",
      },
    });
    // 201 Created (target newly created) and 204 No Content (target overwritten) are success.
    // 207 Multi-Status can also be returned for collection moves with partial errors — treat as failure.
    if (!resp.ok || resp.status === 207) {
      throw new WebDavError(
        resp.status === 404 ? "not-found" : "http",
        `WebDAV MOVE failed for ${fromPath} -> ${toPath}: ${resp.status} ${resp.statusText || ""}`,
        { status: resp.status, method: "MOVE", url: destination },
      );
    }
  }

  /**
   * Check if a resource exists. Returns false only for a confirmed 404/410;
   * auth/permission/network failures propagate so callers never delete or
   * overwrite remote data based on an unknowable state.
   */
  async exists(path: string): Promise<boolean> {
    const resp = await this.request("HEAD", path);
    if (resp.ok) return true;
    if (resp.status === 404 || resp.status === 410) return false;
    if (resp.status === 405) {
      return await this.propfindExistsStrict(path);
    }
    throw this.createStatusError("HEAD", path, resp);
  }

  /** PROPFIND Depth 0 to check if a resource exists */
  private async propfindExists(path: string): Promise<boolean> {
    try {
      const exists = await this.propfindExistsStrict(path);
      if (exists) {
        this.knownCollections.add(toCollectionPath(path));
      }
      return exists;
    } catch (error) {
      if (!(error instanceof WebDavError) || !this.canTryPutAfterPreflight(error)) throw error;
      return false;
    }
  }

  private async propfindExistsStrict(path: string): Promise<boolean> {
    const resp = await this.request("PROPFIND", path, {
      headers: { Depth: "0" },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
      contentType: "application/xml",
      timeoutMs: DIRECTORY_PROBE_TIMEOUT_MS,
    });
    if (resp.ok || resp.status === 207) {
      return true;
    }
    if (resp.status === 404 || resp.status === 409 || resp.status === 410) return false;
    throw this.createStatusError("PROPFIND", path, resp);
  }

  private async parentListingContainsCollection(path: string): Promise<boolean> {
    const parentInfo = getParentCollectionPath(path);
    if (!parentInfo) return true;

    try {
      const resources = await this.propfind(parentInfo.parent);
      return resources.some(
        (resource) => resource.isCollection && resource.name === parentInfo.name,
      );
    } catch {
      return false;
    }
  }

  private async collectionExists(path: string): Promise<boolean> {
    if (await this.propfindExists(path)) {
      return true;
    }
    return this.parentListingContainsCollection(path);
  }

  /** List directory contents (PROPFIND Depth 1) */
  async propfind(path: string): Promise<DavResource[]> {
    const resp = await this.request("PROPFIND", path, {
      headers: { Depth: "1" },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/><D:getlastmodified/><D:getetag/></D:prop></D:propfind>',
      contentType: "application/xml",
    });
    if (!resp.ok && resp.status !== 207) {
      if (resp.status === 404 || resp.status === 409) return [];
      throw this.createStatusError("PROPFIND", path, resp);
    }
    const xml = await resp.text();
    return parsePropfindResponse(xml, path, this.buildUrl(path));
  }

  /** Safely list directory, create if not exists */
  async safeReadDir(path: string): Promise<DavResource[]> {
    const collectionPath = toCollectionPath(path);
    try {
      return await this.propfind(collectionPath);
    } catch (e: unknown) {
      // Branch on the attached status so localized messages (or paths that
      // happen to contain "404") cannot fake a missing collection.
      if (e instanceof WebDavError && e.kind !== "redirect" && isMissingParentStatus(e.status)) {
        await this.ensureDirectory(collectionPath);
        return [];
      }
      throw e;
    }
  }
}

/**
 * Parse a PROPFIND multistatus XML response.
 * Uses regex-based parsing — no DOM parser needed since the XML structure is predictable.
 */
function parsePropfindResponse(xml: string, basePath: string, requestUrl: string): DavResource[] {
  const blocks: string[] = [];

  // Split by WebDAV response boundaries regardless of namespace prefix.
  const responseRegex = /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi;
  let match = responseRegex.exec(xml);
  while (match !== null) {
    blocks.push(match[1]);
    match = responseRegex.exec(xml);
  }

  const strictBasePath = normalizeWebDavPath(new URL(requestUrl).pathname);
  const fallbackBasePath = normalizeWebDavPath(basePath);
  let resources = parsePropfindBlocks(blocks, strictBasePath, requestUrl);

  if (resources.length === 0 && fallbackBasePath !== strictBasePath) {
    resources = parsePropfindBlocks(blocks, fallbackBasePath, requestUrl);
  }

  return resources;
}

function parsePropfindBlocks(
  blocks: string[],
  basePath: string,
  requestUrl: string,
): DavResource[] {
  const resources: DavResource[] = [];

  for (const block of blocks) {
    const href = extractTagContent(block, "href") || "";
    const hrefPath = normalizeWebDavPath(getPathnameFromHref(href, requestUrl));
    if (!isDirectChildPath(basePath, hrefPath)) continue;

    const isCollection = /<(?:(?:\w+):)?collection\b[^>]*\/?>/i.test(block);
    const contentLengthStr = extractTagContent(block, "getcontentlength");
    const lastModified = extractTagContent(block, "getlastmodified");
    const etag = extractTagContent(block, "getetag")?.replace(/"/g, "");

    resources.push({
      href: hrefPath,
      name: filenameFromPath(hrefPath),
      isCollection,
      contentLength: contentLengthStr ? Number.parseInt(contentLengthStr, 10) : undefined,
      lastModified: lastModified || undefined,
      etag: etag || undefined,
    });
  }

  return resources;
}

function safeDecodeWebDavPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function getPathnameFromHref(href: string, requestUrl: string): string {
  try {
    return new URL(href, requestUrl).pathname;
  } catch {
    return href;
  }
}

function normalizeWebDavPath(path: string): string {
  const decoded = safeDecodeWebDavPath(path).replace(/\/{2,}/g, "/");
  const trimmed = decoded.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed || "/" : `/${trimmed}`;
}

function isDirectChildPath(basePath: string, hrefPath: string): boolean {
  if (hrefPath === basePath) return false;
  const prefix = basePath === "/" ? "/" : `${basePath}/`;
  if (!hrefPath.startsWith(prefix)) return false;
  const relative = hrefPath.slice(prefix.length).replace(/\/+$/, "");
  return relative.length > 0 && !relative.includes("/");
}

/** Extract text content of an XML tag (case-insensitive, supports arbitrary namespace prefix) */
function extractTagContent(xml: string, localName: string): string | null {
  const regex = new RegExp(
    `<(?:[\\w-]+:)?${localName}\\b[^>]*>([^<]*)<\\/(?:[\\w-]+:)?${localName}>`,
    "i",
  );
  const match = regex.exec(xml);
  return match ? match[1].trim() : null;
}

/** Extract filename from a normalized WebDAV path */
function filenameFromPath(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || "";
}
