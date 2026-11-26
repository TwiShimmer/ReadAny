package expo.modules.syncfiletransfer

import android.os.SystemClock
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.io.File
import java.net.URI
import java.util.concurrent.TimeUnit

private const val BODY_PREFIX_BYTES = 1024
private const val UPLOAD_CHUNK_BYTES = 64L * 1024

class SyncFileTransferModule : Module() {
  private val client = OkHttpClient.Builder()
    .followRedirects(false)
    .followSslRedirects(false)
    .retryOnConnectionFailure(false)
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(300, TimeUnit.SECONDS)
    .writeTimeout(300, TimeUnit.SECONDS)
    .callTimeout(300, TimeUnit.SECONDS)
    .build()

  override fun definition() = ModuleDefinition {
    Name("SyncFileTransfer")
    Events("uploadProgress")

    AsyncFunction("upload") Coroutine { target: String, fileUri: String, headers: Map<String, String>, id: String ->
      withContext(Dispatchers.IO) { upload(target, fileUri, headers, id) }
    }
  }

  private fun upload(
    target: String,
    fileUri: String,
    headers: Map<String, String>,
    id: String
  ): Map<String, Any> {
    val file = File(URI(fileUri))
    val request = Request.Builder().url(target).apply {
      headers.forEach { (name, value) -> header(name, value) }
    }.put(uploadBody(file, id)).build()

    return client.newCall(request).execute().use { response ->
      val prefix = when (response.code) {
        200, 201, 204 -> response.body?.source()?.let { source ->
          val limit = BODY_PREFIX_BYTES.toLong()
          source.request(limit)
          source.readByteArray(minOf(limit, source.buffer.size))
        }
        else -> null
      }
      mapOf(
        "status" to response.code,
        "url" to response.request.url.toString(),
        "location" to response.header("Location").orEmpty(),
        "contentType" to response.header("Content-Type").orEmpty(),
        "prefix" to (prefix?.map { it.toInt() and 0xff } ?: emptyList<Int>())
      )
    }
  }

  private fun uploadBody(file: File, id: String) = object : RequestBody() {
    private val size = file.length()

    override fun contentType() = null
    override fun contentLength() = size
    override fun isOneShot() = true

    override fun writeTo(sink: BufferedSink) {
      file.source().use { source ->
        var loaded = 0L
        var lastProgressAt = 0L
        while (loaded < size) {
          val count = source.read(sink.buffer, minOf(UPLOAD_CHUNK_BYTES, size - loaded))
          check(count > 0) { "Upload file ended before its reported size" }
          sink.emitCompleteSegments()
          loaded += count
          val now = SystemClock.elapsedRealtime()
          if (loaded == size || now - lastProgressAt >= 100) {
            sendEvent("uploadProgress", mapOf("id" to id, "loaded" to loaded, "total" to size))
            lastProgressAt = now
          }
        }
      }
    }
  }
}
