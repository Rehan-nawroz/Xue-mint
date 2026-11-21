package com.xuemint.app

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.IOException

/**
 * Adds hand-picked gallery photos straight into the PC's library: hash each
 * pick, skip what the PC already stores, stream the rest over the shared
 * transfer protocol. One unreadable or refused file does not stop the batch;
 * the PC connection is found exactly like a backup pass finds it.
 */
class ImportRunner(private val context: Context) {

    /** How one import ended, told back to the UI. */
    data class Outcome(
        val imported: Int,
        val duplicates: Int,
        val failed: Int,
        val failures: List<Failure>
    )

    data class Failure(val filename: String, val error: String)

    fun run(
        uris: List<Uri>,
        onProgress: (
            phase: String,
            current: Int,
            count: Int,
            filename: String,
            sent: Long,
            bytes: Long
        ) -> Unit
    ): Outcome {
        val pairing = PairingStore.load(context)
            ?: throw IOException(UNPAIRED_MESSAGE)
        val stored = connectedPairing(pairing)

        var imported = 0
        var duplicates = 0
        var failed = 0
        val failures = mutableListOf<Failure>()

        uris.forEachIndexed { index, uri ->
            val filename = displayName(uri) ?: "photo-${index + 1}"
            val total = fileSize(uri)
            try {
                onProgress("hashing", index + 1, uris.size, filename, 0, total)
                val hash = MediaLibrary.hashPhoto(context, uri)

                onProgress("checking", index + 1, uris.size, filename, 0, total)
                val missing = AssetTransfer.checkMissing(stored, listOf(hash))
                if (hash !in missing) {
                    duplicates += 1
                    return@forEachIndexed
                }

                onProgress("uploading", index + 1, uris.size, filename, 0, total)
                AssetTransfer.upload(
                    stored,
                    context,
                    uri,
                    hash,
                    filename,
                    total,
                    onChunk = { sent, chunkTotal ->
                        onProgress(
                            "uploading",
                            index + 1,
                            uris.size,
                            filename,
                            sent,
                            chunkTotal
                        )
                    }
                )
                imported += 1
            } catch (error: AuthRejected) {
                throw error
            } catch (error: Exception) {
                failed += 1
                failures.add(
                    Failure(filename, error.message ?: "The photo could not be added.")
                )
            }
        }

        return Outcome(imported, duplicates, failed, failures)
    }

    /**
     * Finds a working address for the paired PC, trying mDNS once when the
     * stored addresses do not answer, and puts the working address first so
     * every later request goes straight to it.
     */
    private fun connectedPairing(pairing: StoredPairing): StoredPairing {
        var stored = pairing
        var outcome = PcLink(context, stored).check()
        if (outcome.connection == "unreachable") {
            val found = PcLink(context, stored).rediscover()
            if (found != null) {
                stored = stored.copy(
                    addresses = (listOf(found.address) + stored.addresses).distinct(),
                    port = found.port
                )
                PairingStore.save(context, stored)
                outcome = PcLink(context, stored).check()
            }
        }
        when {
            outcome.authProblem -> throw AuthRejected()
            outcome.connection != "connected" ->
                throw IOException("PC not reachable — try again when you're home")
        }
        val working = outcome.workingAddress
        if (working != null && stored.addresses.firstOrNull() != working) {
            stored = stored.copy(
                addresses = (listOf(working) + stored.addresses).distinct()
            )
            PairingStore.save(context, stored)
        }
        return stored
    }

    /** The friendly file name a picker URI reports, if any. */
    private fun displayName(uri: Uri): String? =
        describe(uri).first

    /** The byte size a picker URI reports, counted by hand when absent. */
    private fun fileSize(uri: Uri): Long {
        describe(uri).second?.let { return it }
        context.contentResolver.openInputStream(uri)?.use { input ->
            var total = 0L
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
            }
            return total
        } ?: throw IOException("The photo could not be opened.")
    }

    private fun describe(uri: Uri): Pair<String?, Long?> {
        var name: String? = null
        var size: Long? = null
        context.contentResolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
            null,
            null,
            null
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                name = cursor.getString(0)
                if (!cursor.isNull(1)) size = cursor.getLong(1)
            }
        }
        return name to size
    }
}
