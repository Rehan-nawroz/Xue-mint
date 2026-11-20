package com.xuemint.app

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import org.bouncycastle.crypto.digests.Blake3Digest
import java.io.IOException
import java.util.Date

/**
 * The phone's media library as the engine sees it: a MediaStore query for the
 * photo library, and a streaming digest reader so hashing never loads a whole
 * photo into memory.
 */
object MediaLibrary {

    /** Streamed BLAKE3 digest of the photo bytes behind a content URI. */
    fun hashPhoto(context: Context, uri: Uri): String {
        val hasher = Blake3Digest()
        val buffer = ByteArray(64 * 1024)
        context.contentResolver.openInputStream(uri)?.use { input ->
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (read > 0) hasher.update(buffer, 0, read)
            }
        } ?: throw IOException("The photo could not be opened for hashing.")

        val digest = ByteArray(hasher.digestSize)
        hasher.doFinal(digest, 0)
        return digest.joinToString("") { String.format(java.util.Locale.US, "%02x", it) }
    }

    /**
     * Queries the photo library (images), newest capture first. Live Photo
     * video halves and other library kinds join through later hardening work.
     */
    fun queryPhotos(context: Context): List<LibraryPhoto> {
        val photos = mutableListOf<LibraryPhoto>()
        val collection =
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
            } else {
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            }

        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.DATE_TAKEN,
            MediaStore.Images.Media.DATE_MODIFIED,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.WIDTH,
            MediaStore.Images.Media.HEIGHT
        )

        context.contentResolver.query(
            collection,
            projection,
            null,
            null,
            "${MediaStore.Images.Media.DATE_TAKEN} DESC"
        )?.use { cursor ->
            val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val nameColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
            val dateTakenColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_TAKEN)
            val dateModifiedColumn =
                cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_MODIFIED)
            val sizeColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
            val mimeColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
            val widthColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.WIDTH)
            val heightColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.HEIGHT)

            while (cursor.moveToNext()) {
                val id = cursor.getLong(idColumn)
                val dateTaken = cursor.getLong(dateTakenColumn)
                val dateModified = cursor.getLong(dateModifiedColumn)
                photos.add(
                    LibraryPhoto(
                        mediaId = id.toString(),
                        kind = "image",
                        uri = ContentUris.withAppendedId(collection, id).toString(),
                        filename = cursor.getString(nameColumn) ?: "Untitled",
                        mime = cursor.getString(mimeColumn) ?: "image/jpeg",
                        size = cursor.getLong(sizeColumn),
                        takenAt = when {
                            dateTaken > 0 -> dateTaken
                            dateModified > 0 -> dateModified * 1000
                            else -> System.currentTimeMillis()
                        },
                        width = if (cursor.isNull(widthColumn)) null else cursor.getInt(widthColumn),
                        height = if (cursor.isNull(heightColumn)) null else cursor.getInt(heightColumn)
                    )
                )
            }
        }
        return photos
    }
}

/** ISO timestamp for a MediaStore epoch value, used by the debug surface. */
fun isoFromEpoch(epochMillis: Long): String =
    ISO_FORMAT.format(Date(epochMillis))
