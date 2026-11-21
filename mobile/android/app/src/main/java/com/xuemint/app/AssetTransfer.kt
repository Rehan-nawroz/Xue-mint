package com.xuemint.app

import android.content.Context
import android.net.Uri
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okhttp3.Request
import okio.BufferedSink
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.URLEncoder

/** Bytes streamed per upload request; smaller chunks resume more precisely. */
private const val CHUNK_BYTES = 1024L * 1024L
private const val MAX_MISMATCH_RETRIES = 5

/**
 * The photo-transfer protocol every uploader shares: ask the PC which hashes
 * it lacks, then stream one file over in resumable chunks straight from a
 * content URI. The backup pass and the manual gallery import both go through
 * here, so offset handling, dedupe and the final-request rule stay identical.
 */
object AssetTransfer {

    /** The subset of [hashes] the paired PC does not store yet. */
    fun checkMissing(pairing: StoredPairing, hashes: List<String>): Set<String> {
        val client = PinnedNet.client(pairing.fingerprint, 5, 10, 15)
        val payload = JSONObject().put("hashes", org.json.JSONArray(hashes))
        val request = Request.Builder()
            .url(
                "https://${pairing.addresses.firstOrNull()?.trim().orEmpty()}:${pairing.port}" +
                    "/assets/check"
            )
            .header("Authorization", "Device ${pairing.credential}")
            .post(okhttp3.RequestBody.create(JSON_MEDIA_TYPE, payload.toString()))
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            when {
                response.code == 200 -> {
                    val json = JSONObject(text)
                    val array = json.optJSONArray("missing") ?: org.json.JSONArray()
                    val set = mutableSetOf<String>()
                    for (i in 0 until array.length()) set.add(array.optString(i))
                    return set
                }
                response.code == 401 || response.code == 403 -> throw AuthRejected()
                else -> throw IOException(
                    "The PC answered with HTTP ${response.code} during the check."
                )
            }
        }
    }

    /**
     * Streams one file from [uri] to the PC in resumable chunks. Nothing is
     * buffered whole in memory. [onOffset] reports each server-confirmed
     * offset so a caller can remember resume state; [onChunk] reports
     * per-chunk progress. An empty file still gets its final request so the
     * server can hash-verify and store it.
     */
    fun upload(
        pairing: StoredPairing,
        context: Context,
        uri: Uri,
        hash: String,
        filename: String,
        size: Long,
        startOffset: Long = 0,
        onOffset: (Long) -> Unit = {},
        onChunk: (sent: Long, total: Long) -> Unit = { _, _ -> }
    ) {
        val client = PinnedNet.client(
            pairing.fingerprint,
            connectSeconds = 10,
            readSeconds = 30,
            callSeconds = 0,
            writeSeconds = 120
        )
        var offset = startOffset
        var mismatchRetries = 0

        while (true) {
            if (size == 0L) {
                sendChunk(client, pairing, context, uri, hash, filename, size, 0, 0, true)
                return
            }
            if (offset >= size) return
            val chunkLength = minOf(CHUNK_BYTES, size - offset)
            val isLast = offset + chunkLength >= size

            val response = try {
                sendChunk(client, pairing, context, uri, hash, filename, size, offset, chunkLength, isLast)
            } catch (error: OffsetMismatch) {
                mismatchRetries += 1
                if (mismatchRetries > MAX_MISMATCH_RETRIES) {
                    throw IOException("The PC and the phone could not agree on an offset.")
                }
                offset = error.serverOffset
                continue
            }

            when {
                response.optBoolean("stored") -> return
                response.has("offset") -> {
                    offset = response.getLong("offset")
                    onOffset(offset)
                    onChunk(offset, size)
                    if (offset >= size && !isLast) {
                        // Defensive: the transfer should be complete only via
                        // a final request.
                        sendChunk(client, pairing, context, uri, hash, filename, size, offset, 0, true)
                        return
                    }
                }
                else -> throw IOException("The PC gave an unexpected upload answer.")
            }
        }
    }

    /**
     * Streams one chunk straight from the photo's content resolver to the
     * request body. Nothing is buffered whole in memory.
     */
    private fun sendChunk(
        client: okhttp3.OkHttpClient,
        pairing: StoredPairing,
        context: Context,
        uri: Uri,
        hash: String,
        filename: String,
        size: Long,
        offset: Long,
        chunkLength: Long,
        isLast: Boolean
    ): JSONObject {
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength(): Long = chunkLength
            override fun writeTo(sink: BufferedSink) {
                context.contentResolver.openInputStream(uri)?.use { input ->
                    input.skipFully(offset)
                    val buffer = ByteArray(64 * 1024)
                    var remaining = chunkLength
                    while (remaining > 0) {
                        val read = input.read(
                            buffer,
                            0,
                            minOf(buffer.size.toLong(), remaining).toInt()
                        )
                        if (read < 0) {
                            throw IOException("The photo ended before its full size was sent.")
                        }
                        sink.write(buffer, 0, read)
                        remaining -= read
                    }
                } ?: throw IOException("The photo could not be opened for upload.")
            }
        }

        val url = "https://${
            pairing.addresses.firstOrNull()?.trim().orEmpty()
        }:${pairing.port}/assets/upload/$hash" + if (isLast) "?final=1" else ""

        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Device ${pairing.credential}")
            .header("offset", offset.toString())
            .header("x-total", size.toString())
            .header("x-filename", encodedFilename(filename))
            .put(body)
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            when {
                response.code == 200 -> return JSONObject(text)
                response.code == 401 || response.code == 403 -> throw AuthRejected()
                response.code == 409 -> {
                    val (code, message) = PinnedNet.parseError(text)
                    if (code == "OFFSET_MISMATCH") {
                        val serverOffset = Regex("Server offset: (\\d+)")
                            .find(message)?.groupValues?.get(1)?.toLong()
                        throw OffsetMismatch(serverOffset ?: 0)
                    }
                    throw IOException(message.ifEmpty { "The PC refused the upload." })
                }
                else -> throw IOException(
                    "The PC answered with HTTP ${response.code}."
                )
            }
        }
    }

    private fun InputStream.skipFully(bytes: Long) {
        var remaining = bytes
        while (remaining > 0) {
            val skipped = skip(remaining)
            if (skipped <= 0) {
                // Some streams cannot skip; read-and-discard instead.
                val one = read()
                if (one < 0) throw IOException("The photo is shorter than its recorded size.")
                remaining -= 1
            } else {
                remaining -= skipped
            }
        }
    }

    private fun encodedFilename(filename: String): String =
        URLEncoder.encode(filename, "UTF-8").replace("+", "%20")
}
