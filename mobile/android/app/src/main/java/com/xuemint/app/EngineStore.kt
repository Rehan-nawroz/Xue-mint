package com.xuemint.app

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

private const val DB_NAME = "xue-mint-engine.db"
private const val DB_VERSION = 1

private const val TABLE_PHOTOS = "photos"
private const val TABLE_KV = "kv"

/**
 * The engine's persistent memory. Photo digests, per-photo backup state, the
 * upload queue and the backup rules all live here so a killed app, a reboot or
 * a pass that resumes later continues exactly where the last one stopped.
 */
class EngineStore(context: Context) :
    SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE $TABLE_PHOTOS (" +
                "media_id TEXT PRIMARY KEY NOT NULL," +
                "kind TEXT NOT NULL," +
                "uri TEXT NOT NULL," +
                "filename TEXT NOT NULL," +
                "mime TEXT NOT NULL," +
                "size INTEGER NOT NULL," +
                "taken_at INTEGER NOT NULL," +
                "width INTEGER," +
                "height INTEGER," +
                "hash TEXT," +
                "hashed_at INTEGER," +
                "hashed_size INTEGER," +
                "state TEXT NOT NULL DEFAULT 'new'," +
                "upload_offset INTEGER NOT NULL DEFAULT 0," +
                "attempts INTEGER NOT NULL DEFAULT 0," +
                "last_error TEXT," +
                "updated_at INTEGER NOT NULL" +
                ")"
        )
        db.execSQL("CREATE INDEX idx_photos_state ON $TABLE_PHOTOS(state)")
        db.execSQL("CREATE INDEX idx_photos_hash ON $TABLE_PHOTOS(hash)")
        db.execSQL("CREATE TABLE $TABLE_KV (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // First schema; no upgrade path yet.
        onCreate(db)
    }

    // ------------------------------------------------------------- library

    /**
     * Syncs the MediaStore snapshot into the table. Existing rows keep their
     * hash and backup state; rows whose bytes changed are marked for re-hashing
     * and, if the PC already had the old bytes, queued again. Rows for media
     * that left the library are removed.
     */
    fun applyLibrarySnapshot(photos: List<LibraryPhoto>): Int {
        val now = System.currentTimeMillis()
        val db = writableDatabase
        var changed = 0
        db.beginTransaction()
        try {
            val existing = mutableSetOf<String>()
            val sizes = mutableMapOf<String, Long>()
            db.rawQuery("SELECT media_id, size FROM $TABLE_PHOTOS", null).use { cursor ->
                val idColumn = cursor.getColumnIndexOrThrow("media_id")
                val sizeColumn = cursor.getColumnIndexOrThrow("size")
                while (cursor.moveToNext()) {
                    val id = cursor.getString(idColumn)
                    existing.add(id)
                    sizes[id] = cursor.getLong(sizeColumn)
                }
            }

            val seen = mutableSetOf<String>()
            val updateStatement = db.compileStatement(
                "UPDATE $TABLE_PHOTOS SET uri = ?, filename = ?, mime = ?, " +
                    "size = ?, taken_at = ?, width = ?, height = ?, " +
                    "state = ?, upload_offset = ?, updated_at = ? WHERE media_id = ?"
            )
            for (photo in photos) {
                seen.add(photo.mediaId)
                if (existing.contains(photo.mediaId)) {
                    // Content changed (different byte count)? Re-hash and
                    // re-queue; the PC keeps the old copy untouched.
                    var oldState = "new"
                    var oldOffset = 0L
                    db.rawQuery(
                        "SELECT state, upload_offset FROM $TABLE_PHOTOS WHERE media_id = ?",
                        arrayOf(photo.mediaId)
                    ).use { cursor ->
                        if (cursor.moveToFirst()) {
                            oldState = cursor.getString(0)
                            oldOffset = cursor.getLong(1)
                        }
                    }
                    val sameBytes = photo.size == sizes[photo.mediaId]
                    if (!sameBytes) {
                        oldState = if (oldState == "present") "missing" else "new"
                        oldOffset = 0
                    }
                    updateStatement.bindString(1, photo.uri)
                    updateStatement.bindString(2, photo.filename)
                    updateStatement.bindString(3, photo.mime)
                    updateStatement.bindLong(4, photo.size)
                    updateStatement.bindLong(5, photo.takenAt)
                    photo.width?.let { updateStatement.bindLong(6, it.toLong()) }
                        ?: updateStatement.bindNull(6)
                    photo.height?.let { updateStatement.bindLong(7, it.toLong()) }
                        ?: updateStatement.bindNull(7)
                    updateStatement.bindString(8, oldState)
                    updateStatement.bindLong(9, oldOffset)
                    updateStatement.bindLong(10, now)
                    updateStatement.bindString(11, photo.mediaId)
                    updateStatement.executeUpdateDelete()
                } else {
                    db.insert(
                        TABLE_PHOTOS,
                        null,
                        ContentValues().apply {
                            put("media_id", photo.mediaId)
                            put("kind", photo.kind)
                            put("uri", photo.uri)
                            put("filename", photo.filename)
                            put("mime", photo.mime)
                            put("size", photo.size)
                            put("taken_at", photo.takenAt)
                            put("width", photo.width)
                            put("height", photo.height)
                            put("state", "new")
                            put("upload_offset", 0)
                            put("attempts", 0)
                            put("updated_at", now)
                        }
                    )
                    changed += 1
                }
            }

            val gone = existing - seen
            gone.chunked(400).forEach { chunk ->
                val placeholders = chunk.joinToString(",") { "?" }
                db.execSQL(
                    "DELETE FROM $TABLE_PHOTOS WHERE media_id IN ($placeholders)",
                    arrayOf(chunk)
                )
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return changed
    }

    /** Photos that still need a digest: never hashed, or their bytes changed. */
    fun photosNeedingHash(limit: Int): List<StoredPhoto> {
        val photos = mutableListOf<StoredPhoto>()
        readableDatabase.rawQuery(
            "SELECT * FROM $TABLE_PHOTOS WHERE state IN ('new','hashed','missing') AND " +
                "(hash IS NULL OR hashed_size IS NULL OR hashed_size != size) " +
                "ORDER BY taken_at DESC LIMIT ?",
            arrayOf(limit.toString())
        ).use { cursor ->
            while (cursor.moveToNext()) photos.add(photoFromCursor(cursor))
        }
        return photos
    }

    fun recordHash(mediaId: String, hash: String) {
        val now = System.currentTimeMillis()
        writableDatabase.execSQL(
            "UPDATE $TABLE_PHOTOS SET hash = ?, hashed_at = ?, hashed_size = size, " +
                "state = CASE WHEN state = 'new' THEN 'hashed' ELSE state END, " +
                "updated_at = ? WHERE media_id = ?",
            arrayOf(hash, now, now, mediaId)
        )
    }

    /** Applies the PC's answer: which of the checked hashes are already there. */
    fun applyCheckResults(presentHashes: Set<String>) {
        if (presentHashes.isEmpty()) return
        val db = writableDatabase
        db.beginTransaction()
        try {
            presentHashes.chunked(400).forEach { chunk ->
                val placeholders = chunk.joinToString(",") { "?" }
                db.execSQL(
                    "UPDATE $TABLE_PHOTOS SET state = 'present', upload_offset = 0, " +
                        "last_error = NULL, updated_at = ? " +
                        "WHERE hash IN ($placeholders) AND state != 'present'",
                    arrayOf(System.currentTimeMillis(), *chunk.toTypedArray())
                )
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /** Hashes the PC is missing; the upload queue for this pass. */
    fun missingPhotos(limit: Int): List<StoredPhoto> {
        val photos = mutableListOf<StoredPhoto>()
        readableDatabase.rawQuery(
            "SELECT * FROM $TABLE_PHOTOS WHERE state = 'missing' AND hash IS NOT NULL " +
                "ORDER BY taken_at DESC, media_id DESC LIMIT ?",
            arrayOf(limit.toString())
        ).use { cursor ->
            while (cursor.moveToNext()) photos.add(photoFromCursor(cursor))
        }
        return photos
    }

    /** Freshly hashed photos whose presence on the PC is not known yet. */
    fun hashesToCheck(limit: Int): List<Pair<String, String>> {
        val pairs = mutableListOf<Pair<String, String>>()
        readableDatabase.rawQuery(
            "SELECT media_id, hash FROM $TABLE_PHOTOS WHERE hash IS NOT NULL AND " +
                "state = 'hashed' ORDER BY taken_at DESC LIMIT ?",
            arrayOf(limit.toString())
        ).use { cursor ->
            val idColumn = cursor.getColumnIndexOrThrow("media_id")
            val hashColumn = cursor.getColumnIndexOrThrow("hash")
            while (cursor.moveToNext()) {
                pairs.add(cursor.getString(idColumn) to cursor.getString(hashColumn))
            }
        }
        return pairs
    }

    /** Marks photos missing on the PC, and counts what is queued now. */
    fun markMissing(mediaIds: Set<String>): Int {
        if (mediaIds.isEmpty()) return 0
        var queued = 0
        val db = writableDatabase
        db.beginTransaction()
        try {
            mediaIds.chunked(400).forEach { chunk ->
                val placeholders = chunk.joinToString(",") { "?" }
                db.execSQL(
                    "UPDATE $TABLE_PHOTOS SET state = 'missing', updated_at = ? " +
                        "WHERE media_id IN ($placeholders)",
                    arrayOf(System.currentTimeMillis(), *chunk.toTypedArray())
                )
                db.rawQuery(
                    "SELECT COUNT(*) FROM $TABLE_PHOTOS WHERE state = 'missing' AND " +
                        "media_id IN ($placeholders)",
                    arrayOf(*chunk.toTypedArray())
                ).use { cursor ->
                    if (cursor.moveToFirst()) queued += cursor.getInt(0)
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return queued
    }

    /**
     * Prepares a new pass: interrupted uploads and previously failed photos
     * rejoin the queue, keeping their recorded upload offset for resuming.
     */
    fun resetQueueForRun() {
        writableDatabase.execSQL(
            "UPDATE $TABLE_PHOTOS SET state = 'missing', updated_at = ? " +
                "WHERE state IN ('uploading','failed')",
            arrayOf(System.currentTimeMillis())
        )
    }

    fun setUploading(mediaId: String) {
        writableDatabase.execSQL(
            "UPDATE $TABLE_PHOTOS SET state = 'uploading', updated_at = ? WHERE media_id = ?",
            arrayOf(System.currentTimeMillis(), mediaId)
        )
    }

    fun setUploadProgress(mediaId: String, offset: Long) {
        writableDatabase.execSQL(
            "UPDATE $TABLE_PHOTOS SET upload_offset = ?, updated_at = ? WHERE media_id = ?",
            arrayOf(offset, System.currentTimeMillis(), mediaId)
        )
    }

    fun setPresent(mediaId: String) {
        writableDatabase.execSQL(
            "UPDATE $TABLE_PHOTOS SET state = 'present', upload_offset = 0, last_error = NULL, " +
                "updated_at = ? WHERE media_id = ?",
            arrayOf(System.currentTimeMillis(), mediaId)
        )
    }

    /** The photo is back in the queue but keeps its partial upload offset. */
    fun backToQueue(mediaId: String) {
        writableDatabase.execSQL(
            "UPDATE $TABLE_PHOTOS SET state = 'missing', updated_at = ? WHERE media_id = ?",
            arrayOf(System.currentTimeMillis(), mediaId)
        )
    }

    fun setFailed(mediaId: String, error: String) {
        writableDatabase.execSQL(
            "UPDATE $TABLE_PHOTOS SET state = 'failed', attempts = attempts + 1, " +
                "last_error = ?, updated_at = ? WHERE media_id = ?",
            arrayOf(error, System.currentTimeMillis(), mediaId)
        )
    }

    // -------------------------------------------------------------- counts

    fun counts(): BackupCounts {
        val counts = BackupCounts()
        readableDatabase.rawQuery(
            "SELECT state, COUNT(*) FROM $TABLE_PHOTOS GROUP BY state",
            null
        ).use { cursor ->
            val stateColumn = cursor.getColumnIndexOrThrow("state")
            val countColumn = cursor.getColumnIndexOrThrow("COUNT(*)")
            while (cursor.moveToNext()) {
                val n = cursor.getInt(countColumn)
                when (cursor.getString(stateColumn)) {
                    "present" -> counts.backedUp += n
                    "failed" -> counts.failed += n
                    "uploading" -> counts.uploading += n
                    "missing" -> counts.missing += n
                    else -> counts.unhashed += n
                }
                counts.total += n
            }
        }
        return counts
    }

    class BackupCounts {
        var total = 0
        var backedUp = 0
        var failed = 0
        var uploading = 0
        var missing = 0
        var unhashed = 0

        val pending: Int
            get() = unhashed + missing + uploading
    }

    // ------------------------------------------------------------------ kv

    fun getKv(key: String): String? {
        readableDatabase.rawQuery(
            "SELECT value FROM $TABLE_KV WHERE key = ?",
            arrayOf(key)
        ).use { cursor ->
            if (cursor.moveToFirst()) return cursor.getString(0)
        }
        return null
    }

    fun setKv(key: String, value: String?) {
        val db = writableDatabase
        if (value == null) {
            db.execSQL("DELETE FROM $TABLE_KV WHERE key = ?", arrayOf(key))
            return
        }
        db.execSQL(
            "INSERT OR REPLACE INTO $TABLE_KV (key, value) VALUES (?, ?)",
            arrayOf(key, value)
        )
    }

    // ------------------------------------------------------------ settings

    fun settings(): EngineSettingsData {
        return EngineSettingsData(
            wifiOnly = getKv("wifiOnly")?.toBooleanStrictOrNull() ?: true,
            chargingOnly = getKv("chargingOnly")?.toBooleanStrictOrNull() ?: false,
            autoBackup = getKv("autoBackup")?.toBooleanStrictOrNull() ?: true
        )
    }

    fun saveSettings(update: EngineSettingsData) {
        setKv("wifiOnly", update.wifiOnly.toString())
        setKv("chargingOnly", update.chargingOnly.toString())
        setKv("autoBackup", update.autoBackup.toString())
    }

    // --------------------------------------------------------------- debug

    /** Rows for the engine debug surface, newest capture first. */
    fun debugPhotos(limit: Int): List<StoredPhoto> {
        val photos = mutableListOf<StoredPhoto>()
        readableDatabase.rawQuery(
            "SELECT * FROM $TABLE_PHOTOS ORDER BY taken_at DESC, media_id DESC LIMIT ?",
            arrayOf(limit.toString())
        ).use { cursor ->
            while (cursor.moveToNext()) photos.add(photoFromCursor(cursor))
        }
        return photos
    }

    private fun photoFromCursor(cursor: android.database.Cursor): StoredPhoto {
        fun longOr(name: String): Long? =
            if (cursor.isNull(cursor.getColumnIndexOrThrow(name))) null
            else cursor.getLong(cursor.getColumnIndexOrThrow(name))

        fun intOr(name: String): Int? = longOr(name)?.toInt()

        fun textOr(name: String): String? =
            if (cursor.isNull(cursor.getColumnIndexOrThrow(name))) null
            else cursor.getString(cursor.getColumnIndexOrThrow(name))

        return StoredPhoto(
            mediaId = cursor.getString(cursor.getColumnIndexOrThrow("media_id")),
            uri = cursor.getString(cursor.getColumnIndexOrThrow("uri")),
            filename = cursor.getString(cursor.getColumnIndexOrThrow("filename")),
            mime = cursor.getString(cursor.getColumnIndexOrThrow("mime")),
            size = cursor.getLong(cursor.getColumnIndexOrThrow("size")),
            takenAt = cursor.getLong(cursor.getColumnIndexOrThrow("taken_at")),
            width = intOr("width"),
            height = intOr("height"),
            hash = textOr("hash"),
            state = cursor.getString(cursor.getColumnIndexOrThrow("state")),
            uploadOffset = longOr("upload_offset") ?: 0,
            attempts = intOr("attempts") ?: 0,
            lastError = textOr("last_error")
        )
    }
}
