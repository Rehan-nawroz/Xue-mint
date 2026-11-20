package com.xuemint.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Size
import okhttp3.Request
import okio.buffer
import okio.sink
import okio.source
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

private val ROUTE_PC_THUMB = Regex("^/pc/thumb/([A-Za-z0-9-]+)$")
private val ROUTE_PC_ORIGINAL = Regex("^/pc/original/([A-Za-z0-9-]+)$")
private val ROUTE_PHONE_THUMB = Regex("^/phone/thumb/([0-9]+)$")
private val ROUTE_PHONE_ORIGINAL = Regex("^/phone/original/([0-9]+)$")
private val RANGE_PATTERN = Regex("bytes=(\\d*)-(\\d*)")

/**
 * A tiny HTTP server bound to 127.0.0.1 only. The WebView cannot send the
 * device credential with image and video requests, so the engine serves the
 * PC's thumbnails and originals - and the phone library's - through stable
 * local URLs that the gallery can load directly. PC media is cached on disk
 * keyed by asset id, so scrolling a large timeline never re-downloads a tile.
 */
class LocalMediaServer(
    private val context: Context,
    private val pairingProvider: () -> StoredPairing?
) {

    private val started = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val handlers = Executors.newFixedThreadPool(12)

    /** @Volatile via the port read after start(). */
    var port: Int = 0
        private set

    val baseUrl: String
        get() = "http://127.0.0.1:$port"

    fun start() {
        if (!started.compareAndSet(false, true)) return
        try {
            val socket = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
            serverSocket = socket
            port = socket.localPort
            acceptThread = Thread({
                while (started.get()) {
                    try {
                        val client = socket.accept()
                        handlers.execute { serve(client) }
                    } catch (_: SocketException) {
                        break
                    } catch (_: Exception) {
                        // A failed accept must not stop the loop.
                    }
                }
            }, "xue-mint-media-accept")
            acceptThread?.start()
        } catch (error: Exception) {
            started.set(false)
            throw IOException("Could not start the local media server: ${error.message}")
        }
    }

    fun stop() {
        started.set(false)
        try {
            serverSocket?.close()
        } catch (_: Exception) {
            // Closing twice is harmless.
        }
        handlers.shutdownNow()
    }

    private fun serve(client: Socket) {
        try {
            client.soTimeout = 30_000
            val input = client.getInputStream().buffered()
            val request = readRequest(input) ?: run {
                client.close()
                return
            }
            try {
                respond(request, client)
            } catch (_: SocketException) {
                // The WebView closed the connection mid-transfer; normal.
            } catch (_: SocketTimeoutException) {
                // A stalled reader; drop the connection.
            } finally {
                try {
                    client.close()
                } catch (_: Exception) {
                    // Already closed.
                }
            }
        } catch (_: Exception) {
            try {
                client.close()
            } catch (_: Exception) {
                // Already closed.
            }
        }
    }

    private class HttpRequest(
        val path: String,
        val query: Map<String, String>,
        val rangeHeader: String?
    )

    private fun readRequest(input: java.io.InputStream): HttpRequest? {
        val firstLine = readLine(input) ?: return null
        val parts = firstLine.split(" ")
        if (parts.size < 2) return null
        val target = parts[1]
        var headerLine = readLine(input)
        var range: String? = null
        while (headerLine != null && headerLine.isNotEmpty()) {
            val colon = headerLine.indexOf(':')
            if (colon > 0) {
                val name = headerLine.substring(0, colon).trim().lowercase(Locale.US)
                if (name == "range") range = headerLine.substring(colon + 1).trim()
            }
            headerLine = readLine(input)
        }
        val pathEnd = target.indexOf('?')
        val rawPath = if (pathEnd >= 0) target.substring(0, pathEnd) else target
        val rawQuery = if (pathEnd >= 0) target.substring(pathEnd + 1) else ""
        val query = mutableMapOf<String, String>()
        rawQuery.split('&').forEach { pair ->
            val eq = pair.indexOf('=')
            if (eq > 0) {
                query[pair.substring(0, eq)] = URLDecoder.decode(pair.substring(eq + 1), "UTF-8")
            }
        }
        return HttpRequest(rawPath, query, range)
    }

    private fun readLine(input: java.io.InputStream): String? {
        val bytes = mutableListOf<Byte>()
        while (true) {
            val b = input.read()
            if (b < 0) return if (bytes.isEmpty()) null else String(bytes.toByteArray())
            if (b == '\n'.code) {
                var end = bytes.size
                if (end > 0 && bytes[end - 1] == '\r'.code.toByte()) end -= 1
                return String(bytes.toByteArray(), 0, end)
            }
            bytes.add(b.toByte())
            if (bytes.size > 8192) return null
        }
    }

    private fun respond(request: HttpRequest, client: Socket) {
        val output = client.getOutputStream()
        when {
            request.path == "/health" -> writeResponse(
                output, 200, "OK", "text/plain", "media server".toByteArray()
            )

            ROUTE_PC_THUMB.matches(request.path) ->
                servePcThumb(ROUTE_PC_THUMB.matchEntire(request.path)!!.groupValues[1], request, output)

            ROUTE_PC_ORIGINAL.matches(request.path) ->
                servePcOriginal(ROUTE_PC_ORIGINAL.matchEntire(request.path)!!.groupValues[1], request, output)

            ROUTE_PHONE_THUMB.matches(request.path) ->
                servePhoneThumb(ROUTE_PHONE_THUMB.matchEntire(request.path)!!.groupValues[1], output)

            ROUTE_PHONE_ORIGINAL.matches(request.path) ->
                servePhoneOriginal(ROUTE_PHONE_ORIGINAL.matchEntire(request.path)!!.groupValues[1], request, output)

            else -> writeResponse(output, 404, "Not found", "text/plain", byteArrayOf())
        }
    }

    // ------------------------------------------------------------- PC media

    private fun servePcThumb(assetId: String, request: HttpRequest, output: java.io.OutputStream) {
        val file = cacheFile("pc-thumbs", "$assetId.jpg")
        synchronizedLock(file) {
            if (!file.exists() && !downloadPcAsset(assetId, "thumb", file)) return@synchronizedLock
        }
        if (file.exists()) {
            serveFile(request, output, file, "image/jpeg")
        } else {
            writeResponse(output, 404, "Thumb unavailable", "text/plain", byteArrayOf())
        }
    }

    private fun servePcOriginal(assetId: String, request: HttpRequest, output: java.io.OutputStream) {
        val name = request.query["name"].orEmpty()
        val ext = extensionOf(name)
        val file = cacheFile("pc-originals", "$assetId.$ext")
        synchronizedLock(file) {
            if (!file.exists() && !downloadPcAsset(assetId, "original", file, name)) return@synchronizedLock
        }
        if (file.exists()) {
            serveFile(request, output, file, contentTypeFor(ext))
        } else {
            writeResponse(output, 404, "Original unavailable", "text/plain", byteArrayOf())
        }
    }

    /** Streams one PC asset to disk through the pinned pairing identity. */
    private fun downloadPcAsset(
        assetId: String,
        kind: String,
        destination: File,
        originalName: String? = null
    ): Boolean {
        val pairing = pairingProvider() ?: return false
        val part = File(destination.absolutePath + ".part")
        for (address in pairing.addresses) {
            val trimmed = address.trim()
            try {
                val client = PinnedNet.client(
                    pairing.fingerprint,
                    connectSeconds = 10,
                    readSeconds = 30,
                    callSeconds = 0,
                    writeSeconds = 60
                )
                val request = Request.Builder()
                    .url("https://$trimmed:${pairing.port}/assets/$assetId/$kind")
                    .header("Authorization", "Device ${pairing.credential}")
                    .get()
                    .build()
                client.newCall(request).execute().use { response ->
                    if (response.code != 200) return false
                    val body = response.body ?: return false
                    part.sink().buffer().use { sink ->
                        body.source().use { source ->
                            sink.writeAll(source)
                        }
                    }
                    if (!part.renameTo(destination)) {
                        part.copyTo(destination, overwrite = true)
                        part.delete()
                    }
                    return true
                }
            } catch (_: Exception) {
                // Try the next advertised address.
            }
        }
        part.delete()
        return false
    }

    // ---------------------------------------------------------- phone media

    private fun phoneUri(id: String): Uri =
        android.content.ContentUris.withAppendedId(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            id.toLong()
        )

    private fun servePhoneThumb(id: String, output: java.io.OutputStream) {
        val file = cacheFile("phone-thumbs", "$id.jpg")
        synchronizedLock(file) {
            if (!file.exists()) {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        val bitmap = context.contentResolver.loadThumbnail(
                            phoneUri(id),
                            Size(512, 512),
                            null
                        )
                        file.outputStream().use { stream ->
                            bitmap.compress(Bitmap.CompressFormat.JPEG, 90, stream)
                        }
                        bitmap.recycle()
                    } else {
                        decodeDownscaled(phoneUri(id), file)
                    }
                } catch (_: Exception) {
                    // The tile falls back when the file is missing.
                }
            }
        }
        if (file.exists()) {
            writeResponse(output, 200, "OK", "image/jpeg", file.readBytes())
        } else {
            writeResponse(output, 404, "Thumb unavailable", "text/plain", byteArrayOf())
        }
    }

    private fun servePhoneOriginal(id: String, request: HttpRequest, output: java.io.OutputStream) {
        val ext = extensionOf(request.query["name"].orEmpty())
        val file = cacheFile("phone-originals", "$id.$ext")
        synchronizedLock(file) {
            if (!file.exists()) {
                try {
                    context.contentResolver.openInputStream(phoneUri(id))?.use { input ->
                        file.sink().buffer().use { sink ->
                            sink.writeAll(input.source().buffer())
                        }
                    } ?: return@synchronizedLock
                } catch (_: Exception) {
                    // The tile falls back when the file is missing.
                }
            }
        }
        if (file.exists()) {
            serveFile(request, output, file, contentTypeFor(ext))
        } else {
            writeResponse(output, 404, "Original unavailable", "text/plain", byteArrayOf())
        }
    }

    private fun decodeDownscaled(uri: Uri, destination: File) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use { input ->
            BitmapFactory.decodeStream(input, null, bounds)
        } ?: return
        val sample = maxOf(1, maxOf(bounds.outWidth, bounds.outHeight) / 512)
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        context.contentResolver.openInputStream(uri)?.use { input ->
            BitmapFactory.decodeStream(input, null, options)?.let { bitmap ->
                destination.outputStream().use { stream ->
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 90, stream)
                }
                bitmap.recycle()
            }
        }
    }

    // --------------------------------------------------------------- serving

    private fun serveFile(
        request: HttpRequest,
        output: java.io.OutputStream,
        file: File,
        contentType: String
    ) {
        val total = file.length()
        val range = request.rangeHeader?.let { RANGE_PATTERN.find(it) }
        var start = 0L
        var end = total - 1
        var partial = false
        if (range != null) {
            val rawStart = range.groupValues[1]
            val rawEnd = range.groupValues[2]
            when {
                rawStart.isNotEmpty() -> {
                    start = rawStart.toLong()
                    if (rawEnd.isNotEmpty()) end = rawEnd.toLong().coerceAtMost(total - 1)
                }
                rawEnd.isNotEmpty() -> {
                    // Suffix range: the last N bytes.
                    start = (total - rawEnd.toLong()).coerceAtLeast(0)
                }
            }
            if (start > end || start >= total) {
                val headers = "HTTP/1.1 416 Range not satisfiable\r\n" +
                    "Content-Range: bytes */$total\r\n" +
                    "Content-Length: 0\r\n\r\n"
                output.write(headers.toByteArray())
                output.flush()
                return
            }
            partial = true
        }

        val status = if (partial) 206 else 200
        val headers = buildString {
            append("HTTP/1.1 $status ${if (partial) "Partial content" else "OK"}\r\n")
            append("Content-Type: $contentType\r\n")
            if (partial) append("Content-Range: bytes $start-$end/$total\r\n")
            append("Accept-Ranges: bytes\r\n")
            append("Content-Length: ${end - start + 1}\r\n")
            append("Cache-Control: max-age=3600\r\n")
            append("\r\n")
        }
        output.write(headers.toByteArray())

        file.source().buffer().use { source ->
            source.skip(start)
            val buffer = ByteArray(64 * 1024)
            var remaining = end - start + 1
            while (remaining > 0) {
                val read = source.inputStream().read(
                    buffer,
                    0,
                    remaining.coerceAtMost(buffer.size.toLong()).toInt()
                )
                if (read < 0) break
                output.write(buffer, 0, read)
                remaining -= read
            }
            output.flush()
        }
    }

    private fun writeResponse(
        output: java.io.OutputStream,
        status: Int,
        reason: String,
        contentType: String,
        body: ByteArray
    ) {
        val headers = "HTTP/1.1 $status $reason\r\n" +
            "Content-Type: $contentType\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Cache-Control: no-store\r\n" +
            "\r\n"
        output.write(headers.toByteArray())
        output.write(body)
        output.flush()
    }

    private val locks = java.util.concurrent.ConcurrentHashMap<String, Any>()

    private fun synchronizedLock(file: File, block: () -> Unit) {
        val lock = locks.computeIfAbsent(file.absolutePath) { Any() }
        synchronized(lock) { block() }
        if (locks.size > 512) locks.clear()
    }

    private fun cacheFile(folder: String, name: String): File {
        val dir = File(context.cacheDir, "media/$folder")
        dir.mkdirs()
        return File(dir, name)
    }

    private fun extensionOf(name: String): String {
        val cleaned = name.substringAfterLast('/')
        return cleaned.substringAfterLast('.', "").lowercase(Locale.US).ifEmpty { "jpg" }
    }

    private fun contentTypeFor(ext: String): String = when (ext) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "heic", "heif" -> "image/heic"
        "mp4", "m4v" -> "video/mp4"
        "mov" -> "video/quicktime"
        "webm" -> "video/webm"
        "3gp" -> "video/3gpp"
        else -> "application/octet-stream"
    }
}
