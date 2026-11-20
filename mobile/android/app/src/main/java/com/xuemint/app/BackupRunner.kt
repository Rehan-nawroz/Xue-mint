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
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicBoolean

/** Bytes streamed per upload request; smaller chunks resume more precisely. */
private const val CHUNK_BYTES = 1024L * 1024L
private const val CHECK_BATCH = 400
private const val HASH_BATCH = 40
private const val MAX_MISMATCH_RETRIES = 5

private const val KV_PHASE = "phase"
private const val KV_MESSAGE = "status_message"
private const val KV_CURRENT = "current_photo"
private const val KV_SENT = "current_sent"
private const val KV_TOTAL = "current_total"
private const val KV_LAST_BACKUP = "last_backup_at"

/** The PC no longer accepts this phone's credential; pairing must be redone. */
class AuthRejected : Exception(UNPAIRED_MESSAGE)

/** The server's recorded offset differs from the one the phone sent. */
class OffsetMismatch(val serverOffset: Long) : Exception()

/**
 * One backup pass: scan the library, hash photos that were never hashed,
 * ask the PC which hashes it lacks, then stream the missing ones over in
 * chunks. Every step's progress lands in the store, so an app kill, a reboot
 * or a network drop resumes without redoing finished work.
 */
class BackupRunner(
    private val context: Context,
    private val store: EngineStore
) {

    /** Shared across instances so polling and manual kicks cannot double-run. */
    companion object {
        private val running = AtomicBoolean(false)
        val isGloballyRunning: Boolean
            get() = running.get()
    }

    val isRunning: Boolean
        get() = running.get()

    fun run(): BackupOutcome {
        if (!running.compareAndSet(false, true)) return BackupOutcome.ALREADY_RUNNING
        try {
            return runPass()
        } finally {
            running.set(false)
        }
    }

    private fun runPass(): BackupOutcome {
        val pairing = PairingStore.load(context)
        if (pairing == null) {
            setPhase("idle", "Pair once with your PC to start backup")
            return BackupOutcome.NOT_PAIRED
        }

        store.setKv("last_run_at", System.currentTimeMillis().toString())
        println("BackupRunner: pass starting")
        BackupNotifier.progress(context, "Looking through your photo library…")

        val link = PcLink(context, pairing)
        var stored = pairing

        try {
            store.resetQueueForRun()

            // ---- scan the library ------------------------------------------
            setPhase("scanning", "Looking through your photo library…")
            println("BackupRunner: scanning")
            val library = MediaLibrary.queryPhotos(context)
            store.applyLibrarySnapshot(library)
            println("BackupRunner: scanned ${library.size} photos")

            // ---- hash photos that have no remembered digest -----------------
            setPhase("hashing", "Checking your photos…")
            while (true) {
                val batch = store.photosNeedingHash(HASH_BATCH)
                if (batch.isEmpty()) break
                for (photo in batch) {
                    setCurrent(photo.filename, photo.size, photo.size)
                    setMessage("Checking ${photo.filename}…")
                    val hash = try {
                        MediaLibrary.hashPhoto(context, Uri.parse(photo.uri))
                    } catch (error: Exception) {
                        store.setFailed(
                            photo.mediaId,
                            "Could not read the photo: ${error.message ?: "unknown error"}"
                        )
                        continue
                    }
                    store.recordHash(photo.mediaId, hash)
                    setMessage("Checking your photos… ${photo.filename} done")
                }
            }

            // ---- is the PC there? -------------------------------------------
            setPhase("checking", "Looking for your PC…")
            println("BackupRunner: checking connection")
            var outcome = link.check()
            if (outcome.connection == "unreachable") {
                println("BackupRunner: stored addresses unreachable, browsing mDNS")
                val found = link.rediscover()
                if (found != null) {
                    stored = pairing.copy(
                        addresses = (listOf(found.address) + pairing.addresses).distinct(),
                        port = found.port
                    )
                    PairingStore.save(context, stored)
                    outcome = PcLink(context, stored).check()
                }
            }
            // The working address goes first so later checks answer quickly.
            val workingAddress = when (outcome.connection) {
                "connected" -> outcome.workingAddress
                else -> null
            }
            if (workingAddress != null && stored.addresses.firstOrNull() != workingAddress) {
                stored = stored.copy(
                    addresses =
                        (listOf(workingAddress) + stored.addresses).distinct()
                )
                PairingStore.save(context, stored)
            }
            when {
                outcome.authProblem -> {
                    println("BackupRunner: auth rejected")
                    setPhase("error", UNPAIRED_MESSAGE)
                    BackupNotifier.summary(context, "Pairing is broken — pair again in Settings")
                    return BackupOutcome.AUTH_ERROR
                }
                outcome.connection != "connected" -> {
                    println("BackupRunner: PC unreachable, pausing")
                    val advertisedButFiltered = outcome.timedOut && link.rediscover() != null
                    setPhase(
                        "paused",
                        if (advertisedButFiltered) BLOCKED_NETWORK_MESSAGE
                        else "PC not reachable — will back up when you're home"
                    )
                    BackupNotifier.summary(context, "PC not reachable — backup waits until you're home")
                    return BackupOutcome.PAUSED_UNREACHABLE
                }
            }

            // ---- which hashes is the PC missing? -----------------------------
            setMessage("Asking your PC what it already has…")
            while (true) {
                val batch = store.hashesToCheck(CHECK_BATCH)
                if (batch.isEmpty()) break
                val hashes = batch.map { it.second }
                val missingFromPc = try {
                    checkMissing(stored, hashes)
                } catch (error: IOException) {
                    setPhase("paused", "PC not reachable — will back up when you're home")
                    BackupNotifier.summary(context, "PC not reachable — backup waits until you're home")
                    return BackupOutcome.PAUSED_UNREACHABLE
                }
                store.applyCheckResults(hashes.subtract(missingFromPc).toSet())
                store.markMissing(
                    batch.filter { it.second in missingFromPc }.map { it.first }.toSet()
                )
            }

            // ---- upload the queue --------------------------------------------
            setPhase("uploading", "Backing up…")
            while (true) {
                if (!running.get()) break
                val queue = store.missingPhotos(1)
                if (queue.isEmpty()) break
                val photo = queue.first()
                val remaining = store.counts().missing

                store.setUploading(photo.mediaId)
                setCurrent(photo.filename, photo.size, photo.uploadOffset)
                setMessage(
                    "Backing up ${photo.filename} · " +
                        "${remaining - 1} ${if (remaining - 1 == 1) "photo" else "photos"} left"
                )

                try {
                    uploadPhoto(stored, photo)
                    store.setPresent(photo.mediaId)
                    setCurrent(null, 0, 0)
                    BackupNotifier.progress(context, "${remaining - 1} photos still going…")
                } catch (error: OffsetMismatch) {
                    // Adopt the server's offset and keep going from there.
                    store.setUploadProgress(photo.mediaId, error.serverOffset)
                    continue
                } catch (error: AuthRejected) {
                    setPhase("error", UNPAIRED_MESSAGE)
                    return BackupOutcome.AUTH_ERROR
                } catch (error: IOException) {
                    // Network problem mid-transfer: the photo rejoins the
                    // queue with its offset kept, and a later pass resumes.
                    store.backToQueue(photo.mediaId)
                    setCurrent(null, 0, 0)
                    setPhase(
                        "paused",
                        "PC not reachable — will back up when you're home"
                    )
                    BackupNotifier.summary(context, "PC not reachable — backup waits until you're home")
                    return BackupOutcome.PAUSED_UNREACHABLE
                } catch (error: Exception) {
                    store.setFailed(
                        photo.mediaId,
                        error.message ?: "The upload failed."
                    )
                    setCurrent(null, 0, 0)
                }
            }

            // ---- wrap up ------------------------------------------------------
            val counts = store.counts()
            return if (counts.failed > 0) {
                val message =
                    "${counts.failed} ${if (counts.failed == 1) "photo" else "photos"} " +
                        "couldn't upload. They retry on the next backup."
                setPhase("paused", message)
                BackupNotifier.summary(context, message)
                BackupOutcome.COMPLETED
            } else {
                store.setKv(KV_LAST_BACKUP, isoNow())
                setPhase("idle", "All photos are on your PC")
                BackupNotifier.cancelProgress(context)
                BackupNotifier.summary(context, "All photos are on your PC")
                BackupOutcome.COMPLETED
            }
        } catch (error: Exception) {
            setPhase("error", error.message ?: "The backup run into a problem.")
            BackupNotifier.summary(
                context,
                error.message ?: "The backup ran into a problem."
            )
            return BackupOutcome.PAUSED_UNREACHABLE
        }
    }

    // ------------------------------------------------------------- uploads

    private fun uploadPhoto(pairing: StoredPairing, photo: StoredPhoto) {
        val client = PinnedNet.client(
            pairing.fingerprint,
            connectSeconds = 10,
            readSeconds = 30,
            callSeconds = 0,
            writeSeconds = 120
        )
        var offset = photo.uploadOffset
        var mismatchRetries = 0

        while (true) {
            if (photo.size == 0L) {
                // An empty file still needs its final request so the server
                // can hash-verify and store it.
                sendChunk(client, pairing, photo, 0, 0, true)
                return
            }
            if (offset >= photo.size) return
            val chunkLength = minOf(CHUNK_BYTES, photo.size - offset)
            val isLast = offset + chunkLength >= photo.size

            val response = try {
                sendChunk(client, pairing, photo, offset, chunkLength, isLast)
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
                    store.setUploadProgress(photo.mediaId, offset)
                    setProgress(photo.size, offset)
                    if (offset >= photo.size && !isLast) {
                        // Defensive: the transfer should be complete only via
                        // a final request.
                        sendChunk(client, pairing, photo, offset, 0, true)
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
        photo: StoredPhoto,
        offset: Long,
        chunkLength: Long,
        isLast: Boolean
    ): JSONObject {
        val uri = Uri.parse(photo.uri)
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
        }:${pairing.port}/assets/upload/${photo.hash}" + if (isLast) "?final=1" else ""

        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Device ${pairing.credential}")
            .header("offset", offset.toString())
            .header("x-total", photo.size.toString())
            .header("x-filename", encodedFilename(photo.filename))
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

    private fun checkMissing(pairing: StoredPairing, hashes: List<String>): Set<String> {
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

    // --------------------------------------------------------------- state

    private fun setPhase(phase: String, message: String) {
        store.setKv(KV_PHASE, phase)
        store.setKv(KV_MESSAGE, message)
    }

    private fun setMessage(message: String) {
        store.setKv(KV_MESSAGE, message)
    }

    private fun setCurrent(filename: String?, sent: Long, total: Long) {
        if (filename == null) {
            store.setKv(KV_CURRENT, null)
            store.setKv(KV_SENT, null)
            store.setKv(KV_TOTAL, null)
        } else {
            store.setKv(KV_CURRENT, filename)
            store.setKv(KV_SENT, sent.toString())
            store.setKv(KV_TOTAL, total.toString())
        }
    }

    private fun setProgress(total: Long, sent: Long) {
        store.setKv(KV_TOTAL, total.toString())
        store.setKv(KV_SENT, sent.toString())
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

/** Convenience for the plugin: where the pass stands right now. */
fun EngineStore.backupState(): JSONObject {
    val counts = counts()
    var phase = getKv("phase") ?: "idle"
    // An active phase with no pass alive means the process died mid-pass and
    // the state rows were left behind; recover instead of showing a phantom
    // progress bar forever.
    if (phase in setOf("scanning", "hashing", "checking", "uploading") &&
        !BackupRunner.isGloballyRunning
    ) {
        phase = "idle"
        setKv("phase", "idle")
        setKv("status_message", null)
        setKv("current_photo", null)
        setKv("current_sent", null)
        setKv("current_total", null)
    }
    val state = JSONObject()
    state.put("phase", phase)
    state.put("phonePhotos", counts.total)
    state.put("backedUp", counts.backedUp)
    state.put("pending", counts.pending)
    state.put("failed", counts.failed)
    state.put(
        "uploadedBytes",
        getKv("current_sent")?.toLongOrNull() ?: 0
    )
    state.put(
        "totalBytes",
        getKv("current_total")?.toLongOrNull() ?: 0
    )
    state.put("currentPhoto", getKv("current_photo") ?: JSONObject.NULL)
    state.put("lastBackupAt", getKv("last_backup_at") ?: JSONObject.NULL)
    state.put(
        "message",
        getKv("status_message")
            ?: if (counts.pending > 0) "${counts.pending} photos waiting to back up"
            else "All photos are on your PC"
    )
    return state
}
