package com.xuemint.app

import org.json.JSONArray
import org.json.JSONObject

/** The paired PC as stored on this phone. */
data class StoredPairing(
    val serverName: String,
    val addresses: List<String>,
    val port: Int,
    val fingerprint: String,
    val deviceId: String,
    val credential: String,
    val pairedAt: String
) {
    fun toJson(): JSONObject {
        val addressesJson = JSONArray()
        addresses.forEach { addressesJson.put(it) }
        return JSONObject()
            .put("serverName", serverName)
            .put("addresses", addressesJson)
            .put("port", port)
            .put("fingerprint", fingerprint)
            .put("deviceId", deviceId)
            .put("credential", credential)
            .put("pairedAt", pairedAt)
    }

    fun toJsObject(): JSONObject {
        val item = JSONObject()
        item.put("name", serverName)
        item.put("addresses", JSONArray().apply { addresses.forEach { put(it) } })
        item.put("port", port)
        item.put("fingerprint", fingerprint)
        item.put("pairedAt", pairedAt)
        return item
    }

    companion object {
        fun fromJson(json: JSONObject): StoredPairing {
            val addressesJson = json.optJSONArray("addresses") ?: JSONArray()
            val addresses = (0 until addressesJson.length())
                .mapNotNull { addressesJson.optString(it) }
            return StoredPairing(
                serverName = json.getString("serverName"),
                addresses = addresses,
                port = json.getInt("port"),
                fingerprint = json.getString("fingerprint"),
                deviceId = json.optString("deviceId"),
                credential = json.getString("credential"),
                pairedAt = json.optString("pairedAt")
            )
        }
    }
}

/** Result of one reachability check against the paired PC. */
data class ConnectionOutcome(
    val connection: String,
    val message: String,
    val timedOut: Boolean = false,
    val authProblem: Boolean = false,
    /** The address that answered, so later checks try it first. */
    val workingAddress: String? = null
)

/** One mDNS result for the desktop service. */
data class DiscoveredService(
    val name: String,
    val address: String,
    val port: Int,
    val fingerprint: String?,
    val version: String?
)

/** Backup rules the user controls in Settings. */
data class EngineSettingsData(
    val wifiOnly: Boolean,
    val chargingOnly: Boolean,
    val autoBackup: Boolean
) {
    fun toJson(): JSONObject =
        JSONObject()
            .put("wifiOnly", wifiOnly)
            .put("chargingOnly", chargingOnly)
            .put("autoBackup", autoBackup)

    companion object {
        val DEFAULT = EngineSettingsData(
            wifiOnly = true,
            chargingOnly = false,
            autoBackup = true
        )

        fun fromJson(json: JSONObject): EngineSettingsData = EngineSettingsData(
            wifiOnly = json.optBoolean("wifiOnly", true),
            chargingOnly = json.optBoolean("chargingOnly", false),
            autoBackup = json.optBoolean("autoBackup", true)
        )
    }
}

/** How a backup pass ended; drives worker retries and status messages. */
enum class BackupOutcome {
    /** Nothing left to send: every photo is on the PC or there was nothing to do. */
    COMPLETED,

    /** The PC is off or the network dropped; the queue stays and waits. */
    PAUSED_UNREACHABLE,

    /** The PC refuses this phone's credential; the user must pair again. */
    AUTH_ERROR,

    /** A pass is already running. */
    ALREADY_RUNNING,

    /** This phone has no stored pairing. */
    NOT_PAIRED
}

/** A photo as the phone's media library reports it. */
data class LibraryPhoto(
    val mediaId: String,
    val kind: String,
    val uri: String,
    val filename: String,
    val mime: String,
    val size: Long,
    val takenAt: Long,
    val width: Int?,
    val height: Int?
)

/**
 * A library photo plus its remembered backup state. `state` is one of:
 * new (found, not hashed), hashed (digest known, presence unchecked),
 * missing (queued for upload), uploading, present (the PC has the content),
 * failed (the last attempt errored).
 */
data class StoredPhoto(
    val mediaId: String,
    val uri: String,
    val filename: String,
    val mime: String,
    val size: Long,
    val takenAt: Long,
    val width: Int?,
    val height: Int?,
    val hash: String?,
    val state: String,
    val uploadOffset: Long,
    val attempts: Int,
    val lastError: String?
)
