package com.xuemint.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import okhttp3.MediaType.Companion.toMediaType
import okio.buffer
import okio.sink
import okio.source
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** The engine's mDNS service type, shared by discovery and rediscovery. */
const val MDNS_SERVICE_TYPE = "_xue-mint._tcp"

private const val PROBE_PATH = "/local/status"
private const val PAIR_PATH = "/pair"

/**
 * Native side of the mobile backup boundary. Pairing, discovery and status
 * run here; a backup pass is orchestrated by [BackupRunner] on its own
 * executor so a long upload never blocks status checks or pairing.
 */
@CapacitorPlugin(
    name = "BackupEngine",
    permissions = [
        Permission(
            alias = "images",
            strings = [Manifest.permission.READ_MEDIA_IMAGES]
        ),
        Permission(
            alias = "storage",
            strings = [Manifest.permission.READ_EXTERNAL_STORAGE]
        )
    ]
)
class BackupEnginePlugin : Plugin() {

    private val executor = Executors.newSingleThreadExecutor()

    /** Serves PC and phone media to the WebView over 127.0.0.1. */
    private var mediaServer: LocalMediaServer? = null

    override fun load() {
        try {
            mediaServer = LocalMediaServer(context) { PairingStore.load(context) }.also {
                it.start()
            }
        } catch (_: Exception) {
            // Timeline and viewer surfaces report the missing server.
        }
    }

    /** Backup passes run one at a time, away from the status/pairing lane. */
    private val backupExecutor = ThreadPoolExecutor(
        1, 1, 30, TimeUnit.SECONDS,
        ArrayBlockingQueue(4)
    )

    private val mainHandler = Handler(Looper.getMainLooper())

    private var nsdManager: NsdManager? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    @Volatile
    private var discoveryCall: PluginCall? = null
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private val resolvedServices = mutableListOf<DiscoveredService>()
    private var resolving = false

    // ------------------------------------------------------------ health/spike

    @PluginMethod
    fun ping(call: PluginCall) {
        val result = JSObject()
        result.put(
            "message",
            "BackupEngine plugin is alive on ${Build.MANUFACTURER} ${Build.MODEL}."
        )
        result.put("sdk", Build.VERSION.SDK_INT)
        call.resolve(result)
    }

    // ---------------------------------------------------------------- media

    private fun hasMediaPermission(): Boolean {
        val permission =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                Manifest.permission.READ_MEDIA_IMAGES
            } else {
                Manifest.permission.READ_EXTERNAL_STORAGE
            }
        return ContextCompat.checkSelfPermission(
            context,
            permission
        ) == PackageManager.PERMISSION_GRANTED
    }

    @PluginMethod
    fun requestMediaPermission(call: PluginCall) {
        if (hasMediaPermission()) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        val alias = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) "images" else "storage"
        requestPermissionForAlias(alias, call, "mediaPermissionCallback")
    }

    @PermissionCallback
    private fun mediaPermissionCallback(call: PluginCall) {
        call.resolve(JSObject().put("granted", hasMediaPermission()))
    }

    @PluginMethod
    fun scanMediaStore(call: PluginCall) {
        val limit = (call.getInt("limit", 25) ?: 25).coerceIn(1, 500)
        executor.execute {
            if (!hasMediaPermission()) {
                call.reject("Photo access has not been granted.")
                return@execute
            }
            try {
                val all = MediaLibrary.queryPhotos(context)
                val photos = JSArray()
                all.take(limit).forEach { photo ->
                    photos.put(
                        JSObject()
                            .put("id", photo.mediaId)
                            .put("filename", photo.filename)
                            .put("takenAt", isoFromEpoch(photo.takenAt))
                            .put("size", photo.size)
                            .put("mimeType", photo.mime)
                    )
                }
                call.resolve(
                    JSObject()
                        .put("count", all.size)
                        .put("photos", photos)
                        .put("permission", "granted")
                )
            } catch (error: Exception) {
                call.reject("MediaStore query failed: ${error.message}")
            }
        }
    }

    // --------------------------------------------------- engine: backup pass

    /**
     * Starts one backup pass now. Manual runs bypass the charging rule, but
     * respect the Wi-Fi-only rule with a clear answer when the phone is on
     * mobile data.
     */
    @PluginMethod
    fun startBackup(call: PluginCall) {
        backupExecutor.execute {
            val store = EngineStore(context)
            if (PairingStore.load(context) == null) {
                call.reject("Pair once with your PC to start backup.")
                return@execute
            }
            val settings = store.settings()
            if (settings.wifiOnly && !isWifiNetwork()) {
                call.reject(WIFI_ONLY_MESSAGE)
                return@execute
            }
            val runner = BackupRunner(context, store)
            if (BackupRunner.isGloballyRunning) {
                call.resolve(
                    JSObject()
                        .put("started", false)
                        .put("message", "A backup is already running.")
                )
                return@execute
            }
            call.resolve(
                JSObject()
                    .put("started", true)
                    .put("message", "Backup started.")
            )
            backupExecutor.execute { runner.run() }
        }
    }

    /** Lightweight backup state from the engine store (no network calls). */
    @PluginMethod
    fun backupState(call: PluginCall) {
        executor.execute {
            try {
                val store = EngineStore(context)
                val state = store.backupState()
                val result = JSObject()
                result.put("phase", state.optString("phase"))
                result.put("phonePhotos", state.optInt("phonePhotos"))
                result.put("backedUp", state.optInt("backedUp"))
                result.put("pending", state.optInt("pending"))
                result.put("failed", state.optInt("failed"))
                result.put("uploadedBytes", state.optLong("uploadedBytes"))
                result.put("totalBytes", state.optLong("totalBytes"))
                result.put("currentPhoto", state.opt("currentPhoto"))
                result.put("lastBackupAt", state.opt("lastBackupAt"))
                result.put("message", state.optString("message"))
                call.resolve(result)
            } catch (error: Exception) {
                call.reject("Could not read the backup state: ${error.message}")
            }
        }
    }

    /**
     * The phone library plus each photo's remembered backup state. Used by
     * the engine debug surface to show what the backup actually did.
     */
    @PluginMethod
    fun enginePhotos(call: PluginCall) {
        val limit = (call.getInt("limit", 50) ?: 50).coerceIn(1, 500)
        executor.execute {
            if (!hasMediaPermission()) {
                call.reject("Photo access has not been granted.")
                return@execute
            }
            try {
                val store = EngineStore(context)
                store.applyLibrarySnapshot(MediaLibrary.queryPhotos(context))
                val counts = store.counts()

                val photos = JSArray()
                store.debugPhotos(limit).forEach { photo ->
                    photos.put(
                        JSObject()
                            .put("id", photo.mediaId)
                            .put("uri", photo.uri)
                            .put("filename", photo.filename)
                            .put("mimeType", photo.mime)
                            .put("size", photo.size)
                            .put("takenAt", isoFromEpoch(photo.takenAt))
                            .put("width", photo.width ?: JSONObject.NULL)
                            .put("height", photo.height ?: JSONObject.NULL)
                            .put("state", photo.state)
                            .put("hash", photo.hash ?: JSONObject.NULL)
                            .put("uploadOffset", photo.uploadOffset)
                            .put("lastError", photo.lastError ?: JSONObject.NULL)
                    )
                }

                val summary = JSObject()
                    .put("phonePhotos", counts.total)
                    .put("backedUp", counts.backedUp)
                    .put("pending", counts.pending)
                    .put("failed", counts.failed)

                call.resolve(JSObject().put("photos", photos).put("counts", summary))
            } catch (error: Exception) {
                call.reject("Could not read the engine library: ${error.message}")
            }
        }
    }

    // --------------------------------------------------- engine: settings

    @PluginMethod
    fun engineSettings(call: PluginCall) {
        executor.execute {
            val settings = EngineStore(context).settings()
            call.resolve(JSObject().put("settings", settingsJson(settings)))
        }
    }

    /**
     * Saves the backup rules and re-queues background work so the new
     * constraints apply immediately.
     */
    @PluginMethod
    fun saveEngineSettings(call: PluginCall) {
        val update = call.getObject("settings")
        executor.execute {
            try {
                val store = EngineStore(context)
                val current = store.settings()
                val next = EngineSettingsData(
                    wifiOnly = update.optBoolean("wifiOnly", current.wifiOnly),
                    chargingOnly = update.optBoolean("chargingOnly", current.chargingOnly),
                    autoBackup = update.optBoolean("autoBackup", current.autoBackup)
                )
                store.saveSettings(next)
                BackupWorker.schedule(context, store, replace = true)
                BackupWorker.schedulePeriodic(context)
                call.resolve(JSObject().put("settings", settingsJson(next)))
            } catch (error: Exception) {
                call.reject("Could not save the settings: ${error.message}")
            }
        }
    }

    // --------------------------------------- battery and notification health

    /**
     * Battery-optimization state and the notification permission, so the
     * app can tell the user why background backup might be paused on
     * aggressive OEMs (Samsung, Xiaomi, Oppo, Huawei…).
     */
    @PluginMethod
    fun deviceStatus(call: PluginCall) {
        val power = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        val result = JSObject()
        result.put("batteryOptimized", !power.isIgnoringBatteryOptimizations(context.packageName))
        result.put("manufacturer", Build.MANUFACTURER.lowercase())
        result.put("model", Build.MODEL)
        result.put(
            "notificationsAllowed",
            BackupNotifier.allowed(context)
        )
        call.resolve(result)
    }

    /** Asks Android to exempt the app from battery optimization. */
    @PluginMethod
    fun requestBatteryExemption(call: PluginCall) {
        try {
            val power = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            if (power.isIgnoringBatteryOptimizations(context.packageName)) {
                call.resolve(JSObject().put("granted", true))
                return
            }
            val intent = android.content.Intent(
                android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                android.net.Uri.parse("package:${context.packageName}")
            )
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve(JSObject().put("granted", false))
        } catch (error: Exception) {
            call.reject("Could not open the battery prompt: ${error.message}")
        }
    }

    /** Opens the system battery-optimization list for manual control. */
    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        try {
            val intent = android.content.Intent(
                android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS
            )
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (error: Exception) {
            call.reject("Could not open battery settings: ${error.message}")
        }
    }

    /** Runtime ask for POST_NOTIFICATIONS (Android 13+). */
    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (BackupNotifier.allowed(context)) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        try {
            androidx.core.app.ActivityCompat.requestPermissions(
                activity!!,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                9101
            )
            call.resolve(JSObject().put("granted", false))
        } catch (error: Exception) {
            call.reject("Could not request notifications: ${error.message}")
        }
    }

    // ------------------------------------------- engine: background schedule

    @PluginMethod
    fun scheduleBackupWork(call: PluginCall) {
        executor.execute {
            try {
                val store = EngineStore(context)
                val enqueued = BackupWorker.schedule(context, store, replace = true)
                val counts = store.counts()
                call.resolve(
                    JSObject()
                        .put("enqueued", enqueued)
                        .put("pending", counts.pending)
                )
            } catch (error: Exception) {
                call.reject("Could not queue the background backup: ${error.message}")
            }
        }
    }

    @PluginMethod
    fun backupWorkStatus(call: PluginCall) {
        executor.execute {
            try {
                val infos = WorkManager.getInstance(context)
                    .getWorkInfosForUniqueWork(BackupWorker.UNIQUE_WORK)
                    .get(10, TimeUnit.SECONDS)
                val info = infos.lastOrNull()
                val result = JSObject()
                if (info == null) {
                    result.put("state", "NONE")
                    result.put("message", "No background backup is queued yet.")
                } else {
                    result.put("state", info.state.name)
                    result.put(
                        "message",
                        info.outputData.getString("outcome")
                            ?: "Waiting for the rules to be met."
                    )
                }
                call.resolve(result)
            } catch (error: Exception) {
                call.reject("Could not read the work state: ${error.message}")
            }
        }
    }

    /**
     * True when the phone's active network is Wi-Fi, which is what the
     * Wi-Fi-only rule means: never send photos over mobile data.
     */
    private fun isWifiNetwork(): Boolean {
        val manager =
            context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                ?: return false
        val active = manager.activeNetwork
        val capabilities = active?.let { manager.getNetworkCapabilities(it) }
        if (capabilities != null) {
            return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        }
        // Some devices return no bound network; scan every known one.
        return manager.allNetworks.any { network ->
            val caps = manager.getNetworkCapabilities(network) ?: return@any false
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        }
    }

    private fun isCharging(): Boolean {
        val manager = context.getSystemService(Context.BATTERY_SERVICE) as? android.os.BatteryManager
            ?: return false
        return manager.isCharging
    }

    /**
     * Whether a pass the app itself starts right now obeys the user's
     * rules. The WorkManager job enforces the same rules through its
     * constraints; the status poll needs this check on top.
     */
    private fun rulesAllowNow(settings: EngineSettingsData): Boolean {
        if (settings.wifiOnly && !isWifiNetwork()) return false
        if (settings.chargingOnly && !isCharging()) return false
        return true
    }

    private fun settingsJson(settings: EngineSettingsData): JSONObject =
        JSONObject()
            .put("wifiOnly", settings.wifiOnly)
            .put("chargingOnly", settings.chargingOnly)
            .put("autoBackup", settings.autoBackup)

    // ------------------------------------------------ engine: PC library

    @PluginMethod
    fun mediaServer(call: PluginCall) {
        val server = mediaServer
        if (server == null) {
            call.reject("The local media server is not running.")
            return
        }
        call.resolve(JSObject().put("url", server.baseUrl))
    }

    /**
     * Reads a page of the PC library timeline over pinned TLS, newest first.
     * Media URLs are built by the caller against the local media server.
     */
    @PluginMethod
    fun timeline(call: PluginCall) {
        val cursor = call.getString("cursor")?.takeIf { it.isNotBlank() }
        val limit = (call.getInt("limit", 120) ?: 120).coerceIn(1, 500)
        executor.execute {
            val pairing = PairingStore.load(context)
            if (pairing == null) {
                call.reject("Pair once with your PC to start backup.")
                return@execute
            }
            var sawAuthProblem = false
            for (rawAddress in pairing.addresses) {
                val address = rawAddress.trim()
                try {
                    val client = PinnedNet.client(pairing.fingerprint, 5, 15, 20)
                    var url = "https://$address:${pairing.port}/assets?limit=$limit"
                    if (cursor != null) url += "&cursor=${java.net.URLEncoder.encode(cursor, "UTF-8")}"
                    val request = Request.Builder()
                        .url(url)
                        .header("Authorization", "Device ${pairing.credential}")
                        .get()
                        .build()
                    client.newCall(request).execute().use { response ->
                        when {
                            response.code == 200 -> {
                                val body = response.body?.string().orEmpty()
                                val json = JSONObject(body)
                                val result = JSObject()
                                result.put("items", json.optJSONArray("items") ?: JSArray())
                                // optString turns a JSON null into the string
                                // "null"; the end of the library must stay null.
                                val next = if (json.isNull("nextCursor")) null
                                else json.optString("nextCursor").ifEmpty { null }
                                result.put("nextCursor", next ?: JSONObject.NULL)
                                result.put("mediaBase", mediaServer?.baseUrl ?: JSONObject.NULL)
                                call.resolve(result)
                                return@execute
                            }
                            response.code == 401 || response.code == 403 -> sawAuthProblem = true
                            else -> {
                                call.reject("The PC answered with HTTP ${response.code}.")
                                return@execute
                            }
                        }
                    }
                } catch (_: Exception) {
                    // Try the next advertised address.
                }
            }
            if (sawAuthProblem) {
                call.reject(UNPAIRED_MESSAGE)
            } else {
                call.reject("PC not reachable — will back up when you're home")
            }
        }
    }

    /**
     * Removes an asset from the PC's library index. What happens to the file
     * itself follows the PC's own delete-behaviour setting; the phone copy is
     * never touched.
     */
    @PluginMethod
    fun deleteAsset(call: PluginCall) {
        val assetId = call.getString("assetId")?.trim().orEmpty()
        if (assetId.isEmpty()) {
            call.reject("No asset was given.")
            return
        }
        executor.execute {
            val pairing = PairingStore.load(context)
            if (pairing == null) {
                call.reject(UNPAIRED_MESSAGE)
                return@execute
            }
            var sawAuthProblem = false
            for (rawAddress in pairing.addresses) {
                val address = rawAddress.trim()
                try {
                    val client = PinnedNet.client(pairing.fingerprint, 5, 10, 15)
                    val request = Request.Builder()
                        .url("https://$address:${pairing.port}/assets/$assetId")
                        .header("Authorization", "Device ${pairing.credential}")
                        .delete()
                        .build()
                    client.newCall(request).execute().use { response ->
                        when {
                            response.code == 204 || response.code == 404 -> {
                                call.resolve()
                                return@execute
                            }
                            response.code == 401 || response.code == 403 -> sawAuthProblem = true
                            else -> {
                                call.reject("The PC answered with HTTP ${response.code}.")
                                return@execute
                            }
                        }
                    }
                } catch (_: Exception) {
                    // Try the next advertised address.
                }
            }
            if (sawAuthProblem) call.reject(UNPAIRED_MESSAGE)
            else call.reject("PC not reachable — try again when you're home")
        }
    }

    // ------------------------------------------------- engine: gallery import

    /**
     * Opens the system photo picker and imports what the user picks straight
     * into the PC's library — hash, dedupe, chunked upload — with progress
     * published on the importProgress event. The picker needs no permission.
     */
    @PluginMethod
    fun importFromGallery(call: PluginCall) {
        val intent = photoPickerIntent() ?: run {
            call.reject("This Android version cannot open the photo picker.")
            return
        }
        try {
            startActivityForResult(call, intent, "pickPhotosResult")
        } catch (error: Exception) {
            call.reject("Could not open the photo picker: ${error.message}")
        }
    }

    /** Multi-select photos and videos, like the desktop's Add photos. */
    private fun photoPickerIntent(): Intent? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val intent = Intent(MediaStore.ACTION_PICK_IMAGES)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                intent.putExtra(
                    MediaStore.EXTRA_PICK_IMAGES_LAUNCH_TAB,
                    MediaStore.PICK_IMAGES_TAB_IMAGES
                )
            }
            intent.putExtra(
                MediaStore.EXTRA_PICK_IMAGES_MAX,
                MediaStore.getPickImagesMaxLimit()
            )
            intent
        } else {
            Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "image/*"
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }
    }

    @ActivityCallback
    private fun pickPhotosResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uris = mutableListOf<Uri>()
        val clip = result.data?.clipData
        if (clip != null) {
            for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
        } else {
            result.data?.data?.let { uris.add(it) }
        }
        if (uris.isEmpty()) {
            // The user closed the picker without choosing anything.
            call.resolve(
                JSObject()
                    .put("imported", 0)
                    .put("duplicates", 0)
                    .put("failed", 0)
                    .put("failures", JSArray())
            )
            return
        }
        executor.execute {
            try {
                val outcome = ImportRunner(context).run(uris) { phase, current, total, filename, sent, totalBytes ->
                    notifyListeners(
                        "importProgress",
                        JSObject()
                            .put("phase", phase)
                            .put("current", current)
                            .put("total", total)
                            .put("filename", filename)
                            .put("sentBytes", sent)
                            .put("totalBytes", totalBytes)
                    )
                }
                val failures = JSArray()
                outcome.failures.forEach { failure ->
                    failures.put(
                        JSObject()
                            .put("filename", failure.filename)
                            .put("error", failure.error)
                    )
                }
                call.resolve(
                    JSObject()
                        .put("imported", outcome.imported)
                        .put("duplicates", outcome.duplicates)
                        .put("failed", outcome.failed)
                        .put("failures", failures)
                )
            } catch (error: AuthRejected) {
                call.reject(UNPAIRED_MESSAGE)
            } catch (error: Exception) {
                call.reject(error.message ?: "The photos could not be added.")
            }
        }
    }

    // ----------------------------------------------------------------- mDNS

    @PluginMethod
    fun discoverPc(call: PluginCall) {
        if (discoveryCall != null) {
            call.reject("A discovery is already running.")
            return
        }
        discoveryCall = call
        synchronized(resolveQueue) {
            resolveQueue.clear()
        }
        synchronized(resolvedServices) {
            resolvedServices.clear()
        }
        resolving = false

        val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
        nsdManager = manager

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                synchronized(resolveQueue) {
                    resolveQueue.addLast(serviceInfo)
                }
                resolveNext()
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit

            override fun onDiscoveryStopped(serviceType: String) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                finishDiscovery(
                    call,
                    error = "mDNS discovery could not start (code $errorCode)."
                )
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                finishDiscovery(call)
            }
        }
        discoveryListener = listener

        try {
            manager.discoverServices(MDNS_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (error: Exception) {
            finishDiscovery(call, error = "mDNS discovery failed: ${error.message}")
            return
        }

        val timeoutMs = (call.getLong("timeoutMs", 6000) ?: 6000).coerceIn(1000, 30000)
        mainHandler.postDelayed({ finishDiscovery(call) }, timeoutMs)
    }

    private fun resolveNext() {
        synchronized(resolveQueue) {
            if (resolving) return
            val next = resolveQueue.removeFirstOrNull() ?: return
            resolving = true

            try {
                nsdManager?.resolveService(
                    next,
                    object : NsdManager.ResolveListener {
                        override fun onResolveFailed(
                            serviceInfo: NsdServiceInfo,
                            errorCode: Int
                        ) {
                            resolving = false
                            resolveNext()
                        }

                        override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                            val address = serviceInfo.host?.hostAddress
                            val attributes = serviceInfo.attributes
                                ?.mapValues { (_, value) ->
                                    String(value, Charsets.UTF_8)
                                }
                                .orEmpty()

                            if (address != null) {
                                synchronized(resolvedServices) {
                                    resolvedServices.add(
                                        DiscoveredService(
                                            name = serviceInfo.serviceName,
                                            address = address,
                                            port = serviceInfo.port,
                                            fingerprint = attributes["fingerprint"],
                                            version = attributes["version"]
                                        )
                                    )
                                }
                            }

                            resolving = false
                            resolveNext()
                        }
                    }
                )
            } catch (error: Exception) {
                resolving = false
                resolveNext()
            }
        }
    }

    private fun finishDiscovery(call: PluginCall, error: String? = null) {
        if (discoveryCall !== call) return
        discoveryCall = null

        try {
            discoveryListener?.let { listener ->
                nsdManager?.stopServiceDiscovery(listener)
            }
        } catch (_: Exception) {
            // The platform may already have stopped the browse.
        }
        discoveryListener = null

        if (error != null) {
            call.reject(error)
            return
        }

        val array = JSArray()
        synchronized(resolvedServices) {
            resolvedServices.forEach { service ->
                val item = JSObject()
                item.put("name", service.name)
                item.put("addresses", JSArray().put(service.address))
                item.put("port", service.port)
                service.fingerprint?.let { item.put("fingerprint", it) }
                service.version?.let { item.put("version", it) }
                array.put(item)
            }
        }

        val result = JSObject()
        result.put("services", array)
        call.resolve(result)
    }

    // ------------------------------------------------------------------ TLS

    @PluginMethod
    fun probeTls(call: PluginCall) {
        val address = call.getString("address")?.trim().orEmpty()
        val port = call.getInt("port", 0) ?: 0
        val expected = call.getString("fingerprint")
            ?.replace(":", "")
            ?.replace(" ", "")
            ?.lowercase(java.util.Locale.US)
            .orEmpty()

        if (address.isEmpty() || port <= 0 || expected.length != 64) {
            call.reject("Enter an address, a port and the full SHA-256 fingerprint.")
            return
        }

        executor.execute {
            try {
                val client = PinnedNet.client(expected)
                val request = Request.Builder()
                    .url("https://$address:$port$PROBE_PATH")
                    .get()
                    .build()

                client.newCall(request).execute().use { response ->
                    val certificate =
                        response.handshake?.peerCertificates?.firstOrNull()
                            as? java.security.cert.X509Certificate
                    val result = JSObject()
                    val reachable = response.code in setOf(200, 403)
                    result.put("ok", reachable)
                    result.put("httpStatus", response.code)
                    result.put(
                        "certificateFingerprint",
                        certificate?.let {
                            PinnedNet.sha256(it.encoded)
                                .uppercase(java.util.Locale.US)
                        }
                    )
                    result.put(
                        "message",
                        if (reachable) {
                            "TLS handshake verified and the pinned fingerprint matched."
                        } else {
                            "TLS worked, but the server returned HTTP ${response.code}."
                        }
                    )
                    call.resolve(result)
                }
            } catch (error: Exception) {
                call.reject("Pinned TLS check failed: ${error.message}")
            }
        }
    }

    // ------------------------------------------------------------- pairing

    /**
     * Exchanges the one-time token from the QR code for a device credential
     * over pinned TLS, trying every address the code advertises.
     */
    @PluginMethod
    fun pairPc(call: PluginCall) {
        val addresses = call.getArray("addresses")
            ?.let { array -> (0 until array.length()).mapNotNull { array.optString(it)?.trim() } }
            ?.filter { it.isNotEmpty() }
            .orEmpty()
        val port = call.getInt("port", 0) ?: 0
        val fingerprint = call.getString("fingerprint").orEmpty()
        val token = call.getString("token")?.trim().orEmpty()
        val serverName = call.getString("serverName")?.trim().orEmpty()

        if (addresses.isEmpty() || port <= 0 ||
            PinnedNet.normalizeFingerprint(fingerprint).length != 64 || token.isEmpty()
        ) {
            call.reject("That code is missing its address, port, fingerprint or token.")
            return
        }

        executor.execute {
            var pinMismatch = false
            var timedOut = false
            var lastError: Exception? = null

            val publicKey = try {
                android.util.Base64.encodeToString(
                    PairingStore.devicePublicKey(context),
                    android.util.Base64.NO_WRAP
                )
            } catch (error: Exception) {
                call.reject("Could not prepare this phone's key: ${error.message}")
                return@execute
            }

            for (rawAddress in addresses) {
                val address = rawAddress.trim()
                try {
                    val client = PinnedNet.client(fingerprint, 5, 8, 12)
                    val payload = JSONObject()
                        .put("token", token)
                        .put("devicePublicKey", publicKey)
                        .put("deviceName", PinnedNet.deviceName())
                        .toString()
                    val request = Request.Builder()
                        .url("https://$address:$port$PAIR_PATH")
                        .post(
                            payload.toRequestBody(
                                "application/json; charset=utf-8".toMediaType()
                            )
                        )
                        .build()

                    client.newCall(request).execute().use { response ->
                        if (response.code == 200) {
                            val body = JSONObject(response.body?.string().orEmpty())
                            val credential = body.optString("credential")
                            if (credential.isEmpty()) {
                                call.reject("The PC did not return a credential.")
                                return@execute
                            }
                            val stored = StoredPairing(
                                serverName = serverName.ifEmpty { address },
                                addresses = addresses,
                                port = port,
                                fingerprint = PinnedNet.formatFingerprint(fingerprint),
                                deviceId = body.optString("deviceId"),
                                credential = credential,
                                pairedAt = isoNow()
                            )
                            PairingStore.save(context, stored)

                            // Fresh pairing: start the first backup pass.
                            call.resolve(JSObject().put("pc", stored.toJsObject()))
                            val store = EngineStore(context)
                            if (!BackupRunner.isGloballyRunning) {
                                backupExecutor.execute { BackupRunner(context, store).run() }
                            }
                            return@execute
                        }
                        if (response.code == 401) {
                            call.reject(USED_TOKEN_MESSAGE)
                            return@execute
                        }
                        // The PC answered, so no other address will do better.
                        call.reject("The PC answered with HTTP ${response.code}.")
                        return@execute
                    }
                } catch (error: Exception) {
                    when (error) {
                        is java.security.cert.CertificateException,
                        is javax.net.ssl.SSLHandshakeException -> pinMismatch = true
                        is java.net.SocketTimeoutException -> timedOut = true
                    }
                    lastError = error
                }
            }

            when {
                pinMismatch -> call.reject(PIN_MISMATCH_MESSAGE)
                timedOut -> call.reject(UNREACHABLE_MESSAGE)
                else -> call.reject(PinnedNet.describeReachability(lastError))
            }
        }
    }

    /**
     * Reports the stored pairing and whether the PC answers right now, plus a
     * snapshot of the backup engine's state. When the address has changed,
     * mDNS is used once to find the same PC again by its certificate
     * fingerprint, so a new DHCP lease does not need re-pairing. A connected
     * PC with pending photos also kicks an in-app backup pass.
     */
    @PluginMethod
    fun pairingState(call: PluginCall) {
        executor.execute {
            val store = EngineStore(context)
            val stored = PairingStore.load(context)
            if (stored == null) {
                val empty = JSObject()
                empty.put("paired", false)
                empty.put("pc", JSONObject.NULL)
                empty.put("connection", "not_paired")
                empty.put("message", "Pair once with your PC to start backup")
                empty.put("backup", backupJsObject(store))
                call.resolve(empty)
                return@execute
            }

            var pairing = stored
            var outcome = PcLink(context, pairing).check()
            if (outcome.connection != "connected") {
                val found = PcLink(context, pairing).rediscover()
                if (found != null) {
                    pairing = pairing.copy(
                        addresses = (listOf(found.address) + pairing.addresses)
                            .distinct(),
                        port = found.port
                    )
                    PairingStore.save(context, pairing)
                    outcome = PcLink(context, pairing).check()
                    // The PC is advertised on this network but its port does
                    // not answer: the network is dropping device-to-device
                    // traffic rather than the PC being off.
                    if (outcome.connection == "unreachable" && outcome.timedOut) {
                        outcome = ConnectionOutcome("blocked", BLOCKED_NETWORK_MESSAGE)
                    }
                }
            }

            val backup = backupJsObject(store)
            val settings = store.settings()
            val lastRun = store.getKv("last_run_at")?.toLongOrNull() ?: 0
            val dueScan = System.currentTimeMillis() - lastRun > 60_000
            if (outcome.connection == "connected" && settings.autoBackup &&
                rulesAllowNow(settings) &&
                (backup.optInt("pending") > 0 || dueScan) &&
                !BackupRunner.isGloballyRunning
            ) {
                backupExecutor.execute { BackupRunner(context, store).run() }
            }

            val result = JSObject()
            result.put("paired", true)
            result.put("pc", pairing.toJsObject())
            result.put("connection", outcome.connection)
            result.put("message", outcome.message)
            result.put("backup", backup)
            call.resolve(result)
        }
    }

    private fun backupJsObject(store: EngineStore): JSObject {
        val state = store.backupState()
        val backup = JSObject()
        backup.put("phase", state.optString("phase"))
        backup.put("phonePhotos", state.optInt("phonePhotos"))
        backup.put("backedUp", state.optInt("backedUp"))
        backup.put("pending", state.optInt("pending"))
        backup.put("failed", state.optInt("failed"))
        backup.put("uploadedBytes", state.optLong("uploadedBytes"))
        backup.put("totalBytes", state.optLong("totalBytes"))
        backup.put("currentPhoto", state.opt("currentPhoto"))
        backup.put("lastBackupAt", state.opt("lastBackupAt"))
        backup.put("message", state.optString("message"))
        return backup
    }

    @PluginMethod
    fun forgetPc(call: PluginCall) {
        PairingStore.clear(context)
        EngineStore(context).setKv("phase", "idle")
        EngineStore(context).setKv("status_message", null)
        call.resolve()
    }

    /**
     * Saves a PC asset into the phone's gallery: the original is fetched
     * over pinned TLS and written through MediaStore into Pictures/Xue-Mint,
     * so it appears in the phone's gallery like any downloaded photo.
     */
    @PluginMethod
    fun downloadAsset(call: PluginCall) {
        val assetId = call.getString("assetId")?.trim().orEmpty()
        if (assetId.isEmpty()) {
            call.reject("No asset was given.")
            return
        }
        val filename = call.getString("filename")?.trim().takeUnless { it.isNullOrEmpty() }
            ?: "$assetId.jpg"
        val mimeType = call.getString("mimeType")?.takeUnless { it.isNullOrEmpty() }
            ?: "image/jpeg"
        executor.execute {
            val pairing = PairingStore.load(context)
            if (pairing == null) {
                call.reject("Pair with your PC first.")
                return@execute
            }
            for (address in pairing.addresses) {
                val trimmed = address.trim()
                try {
                    val client = PinnedNet.client(pairing.fingerprint, 10, 60, 0, 60)
                    val request = Request.Builder()
                        .url("https://$trimmed:${pairing.port}/assets/$assetId/original")
                        .header("Authorization", "Device ${pairing.credential}")
                        .get()
                        .build()
                    client.newCall(request).execute().use { response ->
                        if (response.code == 404) {
                            call.reject("That photo is no longer on your PC.")
                            return@execute
                        }
                        if (response.code != 200) {
                            call.reject("Your PC answered with HTTP ${response.code}.")
                            return@execute
                        }
                        val body = response.body ?: run {
                            call.reject("Your PC sent an empty answer.")
                            return@execute
                        }
                        val resolver = context.contentResolver
                        val collection =
                            android.provider.MediaStore.Images.Media.getContentUri(
                                android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY
                            )
                        val details = android.content.ContentValues().apply {
                            put(
                                android.provider.MediaStore.Images.Media.DISPLAY_NAME,
                                filename
                            )
                            put(android.provider.MediaStore.Images.Media.MIME_TYPE, mimeType)
                            put(
                                android.provider.MediaStore.Images.Media.RELATIVE_PATH,
                                "Pictures/Xue-Mint"
                            )
                            put(
                                android.provider.MediaStore.Images.Media.IS_PENDING,
                                1
                            )
                        }
                        val uri = resolver.insert(collection, details) ?: run {
                            call.reject("Could not create the file in your gallery.")
                            return@execute
                        }
                        try {
                            resolver.openOutputStream(uri)?.sink()?.buffer()?.use { sink ->
                                body.source().use { source ->
                                    sink.writeAll(source)
                                }
                            } ?: throw java.io.IOException("gallery file is gone")
                            details.clear()
                            details.put(android.provider.MediaStore.Images.Media.IS_PENDING, 0)
                            resolver.update(uri, details, null, null)
                        } catch (error: Exception) {
                            resolver.delete(uri, null, null)
                            throw error
                        }
                        call.resolve(
                            JSObject()
                                .put("filename", filename)
                                .put("savedTo", "Pictures/Xue-Mint")
                        )
                        return@execute
                    }
                } catch (error: Exception) {
                    println("BackupEngine: download attempt on $trimmed failed: ${error.message}")
                }
            }
            call.reject("Your PC was not reachable.")
        }
    }
    /**
     * Factory reset: wipes the engine's own data (photo library, digests,
     * queue, progress, rules) and forgets the paired PC, then cancels any
     * background work. The phone's actual gallery is never touched.
     */
    @PluginMethod
    fun factoryReset(call: PluginCall) {
        executor.execute {
            // The reset covers the whole system: first ask the PC to wipe
            // its library, stored photos, thumbnails and pairings, then
            // wipe this phone's engine and pairing. The phone's real
            // gallery is never touched.
            val pcReset = resetPcLibrary()
            try {
                WorkManager.getInstance(context)
                    .cancelUniqueWork(BackupWorker.UNIQUE_WORK)
                WorkManager.getInstance(context)
                    .cancelUniqueWork(BackupWorker.PERIODIC_WORK)
                val store = EngineStore(context)
                store.wipeAll()
                PairingStore.clear(context)
                BackupNotifier.cancelProgress(context)
                context.cacheDir.resolve("media").deleteRecursively()
                println("BackupEngine: factory reset done (pcReset=$pcReset)")
                call.resolve(JSObject().put("pcReset", pcReset))
            } catch (error: Exception) {
                call.reject("Could not reset the app: ${error.message}")
            }
        }
    }

    /** Asks the paired PC to wipe its library; false when unreachable. */
    private fun resetPcLibrary(): Boolean {
        val pairing = PairingStore.load(context) ?: return false
        for (address in pairing.addresses) {
            val trimmed = address.trim()
            try {
                val client = PinnedNet.client(pairing.fingerprint, 10, 30, 60, 30)
                val request = Request.Builder()
                    .url("https://$trimmed:${pairing.port}/reset")
                    .header("Authorization", "Device ${pairing.credential}")
                    .post("{}".toRequestBody("application/json; charset=utf-8".toMediaType()))
                    .build()
                client.newCall(request).execute().use { response ->
                    println("BackupEngine: PC reset answered HTTP ${response.code}")
                    return response.code == 200
                }
            } catch (error: Exception) {
                println("BackupEngine: PC reset attempt on $trimmed failed: ${error.message}")
            }
        }
        return false
    }



    // ---------------------------------------------------------- WorkManager

    @PluginMethod
    fun scheduleWorkProbe(call: PluginCall) {
        val constraints = androidx.work.Constraints.Builder()
            .setRequiredNetworkType(androidx.work.NetworkType.CONNECTED)
            .build()
        val request = androidx.work.OneTimeWorkRequestBuilder<SpikeWorker>()
            .setConstraints(constraints)
            .build()

        WorkManager.getInstance(context).enqueueUniqueWork(
            SpikeWorker.UNIQUE_WORK,
            androidx.work.ExistingWorkPolicy.REPLACE,
            request
        )

        call.resolve(JSObject().put("workId", request.id.toString()))
    }

    @PluginMethod
    fun workProbeStatus(call: PluginCall) {
        executor.execute {
            try {
                val infos = WorkManager.getInstance(context)
                    .getWorkInfosForUniqueWork(SpikeWorker.UNIQUE_WORK)
                    .get(10, TimeUnit.SECONDS)
                val info = infos.lastOrNull()
                val result = JSObject()
                if (info == null) {
                    result.put("state", "NONE")
                    result.put("message", "No background probe has been queued yet.")
                } else {
                    result.put("state", info.state.name)
                    result.put(
                        "message",
                        info.outputData.getString("message")
                            ?: "Waiting for the worker to finish."
                    )
                }
                call.resolve(result)
            } catch (error: Exception) {
                call.reject("Could not read WorkManager state: ${error.message}")
            }
        }
    }
}
