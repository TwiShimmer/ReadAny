import Darwin
import ExpoModulesCore
import Foundation

public final class SyncFileTransferModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SyncFileTransfer")
    Events("uploadProgress")

    AsyncFunction("upload") { (target: URL, file: URL, headers: [String: String], id: String, promise: Promise) in
      guard let scheme = target.scheme, ["https", "http"].contains(scheme), file.isFileURL else {
        promise.reject("INVALID_TRANSFER_URL", "Invalid WebDAV upload or file URL")
        return
      }

      var request = URLRequest(url: target)
      request.httpMethod = "PUT"
      request.allHTTPHeaderFields = headers
      let config = URLSessionConfiguration.ephemeral
      config.timeoutIntervalForResource = 300
      config.httpShouldSetCookies = false
      config.urlCredentialStorage = nil
      let delegate = UploadDelegate(promise: promise) { [weak self] loaded, total in
        self?.sendEvent("uploadProgress", ["id": id, "loaded": loaded, "total": total])
      }
      let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
      session.uploadTask(with: request, fromFile: file).resume()
    }

    AsyncFunction("replace") { (source: URL, destination: URL) in
      let source = source.standardizedFileURL
      let destination = destination.standardizedFileURL
      let parent = source.deletingLastPathComponent().resolvingSymlinksInPath()
      let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .resolvingSymlinksInPath().path
      guard source.isFileURL, destination.isFileURL,
        parent == destination.deletingLastPathComponent().resolvingSymlinksInPath(),
        parent.path == documents || parent.path.hasPrefix(documents + "/"),
        source.lastPathComponent.hasPrefix(".readany-transfer-")
      else {
        throw POSIXError(.EINVAL)
      }
      try source.withUnsafeFileSystemRepresentation { from in
        try destination.withUnsafeFileSystemRepresentation { to in
          guard let from, let to else { throw POSIXError(.EINVAL) }
          if Darwin.rename(from, to) != 0 {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
          }
        }
      }
    }
  }
}

// A URLSession's default delegate queue serializes access to the response state.
private final class UploadDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let promise: Promise
  private let progress: (Int64, Int64) -> Void
  private let prefixLimit = 1024
  private var prefix = Data()
  private var settled = false

  init(promise: Promise, progress: @escaping (Int64, Int64) -> Void) {
    self.promise = promise
    self.progress = progress
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    if !settled { resolve(response) }
    completionHandler(nil)
    task.cancel()
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard !settled else {
      completionHandler(.cancel)
      return
    }
    if let http = response as? HTTPURLResponse, ![200, 201, 204].contains(http.statusCode) {
      resolve(http)
      completionHandler(.cancel)
      return
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard !settled else { return }
    prefix.append(contentsOf: data.prefix(prefixLimit - prefix.count))
    if prefix.count == prefixLimit, let response = dataTask.response as? HTTPURLResponse {
      resolve(response)
      dataTask.cancel()
    }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64, totalBytesExpectedToSend: Int64
  ) {
    progress(totalBytesSent, max(0, totalBytesExpectedToSend))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    defer { session.finishTasksAndInvalidate() }
    guard !settled else { return }
    if let error {
      promise.reject("WEBDAV_UPLOAD_FAILED", error.localizedDescription)
    } else if let response = task.response as? HTTPURLResponse {
      resolve(response)
    } else {
      promise.reject("INVALID_WEBDAV_RESPONSE", "Missing HTTP response for WebDAV upload")
    }
  }

  private func resolve(_ response: HTTPURLResponse) {
    settled = true
    promise.resolve([
      "status": response.statusCode,
      "url": response.url?.absoluteString ?? "",
      "location": response.value(forHTTPHeaderField: "Location") ?? "",
      "contentType": response.value(forHTTPHeaderField: "Content-Type") ?? "",
      "prefix": prefix.map(Int.init),
    ])
  }
}
