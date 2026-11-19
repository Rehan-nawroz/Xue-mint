package com.xuemint.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import okhttp3.OkHttpClient
import okhttp3.Request
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

private const val SERVICE_TYPE = "_xue-mint._tcp"
private const val DEFAULT_SERVICE_TYPE = "_xue-mint._tcp.local."
private const val PROBE_PATH = "/local/status"

/**
 * Native side of the mobile backup boundary. This stage implements the
 * round-trip health check plus the four risky integration points: MediaStore,
 * mDNS discovery, pinned TLS and a WorkManager job.
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
    private val mainHandler = Handler(Looper.getMainLooper())
    private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    private var nsdManager: NsdManager? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    @Volatile
    private var discoveryCall: PluginCall? = null
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private val resolvedServices = mutableListOf<DiscoveredService>()
    private var resolving = false

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

    private fun mediaPermissionAlias(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) "images" else "storage"

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
        requestPermissionForAlias(mediaPermissionAlias(), call, "mediaPermissionCallback")
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
                val projection = arrayOf(
                    MediaStore.Images.Media._ID,
                    MediaStore.Images.Media.DISPLAY_NAME,
                    MediaStore.Images.Media.DATE_TAKEN,
                    MediaStore.Images.Media.SIZE,
                    MediaStore.Images.Media.MIME_TYPE
                )
                val photos = JSArray()
                var total = 0

                context.contentResolver.query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    projection,
                    null,
                    null,
                    "${MediaStore.Images.Media.DATE_TAKEN} DESC"
                )?.use { cursor ->
                    total = cursor.count
                    val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
                    val nameColumn =
                        cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
                    val dateColumn =
                        cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_TAKEN)
                    val sizeColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
                    val mimeColumn =
                        cursor.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)

                    while (cursor.moveToNext() && photos.length() < limit) {
                        val takenAt = cursor.getLong(dateColumn)
                        val photo = JSObject()
                        photo.put("id", cursor.getLong(idColumn).toString())
                        photo.put("filename", cursor.getString(nameColumn) ?: "Untitled")
                        photo.put(
                            "takenAt",
                            isoFormat.format(
                                Date(if (takenAt > 0) takenAt else System.currentTimeMillis())
                            )
                        )
                        photo.put("size", cursor.getLong(sizeColumn))
                        photo.put(
                            "mimeType",
                            cursor.getString(mimeColumn) ?: "image/jpeg"
                        )
                        photos.put(photo)
                    }
                }

                val result = JSObject()
                result.put("count", total)
                result.put("photos", photos)
                result.put("permission", "granted")
                call.resolve(result)
            } catch (error: Exception) {
                call.reject("MediaStore query failed: ${error.message}")
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
            manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
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
            ?.lowercase(Locale.US)
            .orEmpty()

        if (address.isEmpty() || port <= 0 || expected.length != 64) {
            call.reject("Enter an address, a port and the full SHA-256 fingerprint.")
            return
        }

        executor.execute {
            try {
                val trustManager = object : X509TrustManager {
                    override fun checkClientTrusted(
                        chain: Array<out X509Certificate>?,
                        authType: String?
                    ) = Unit

                    override fun checkServerTrusted(
                        chain: Array<out X509Certificate>?,
                        authType: String?
                    ) {
                        val certificate = chain?.firstOrNull()
                            ?: throw CertificateException("The server sent no certificate.")
                        val actual = sha256(certificate.encoded)
                        if (!actual.equals(expected, ignoreCase = true)) {
                            throw CertificateException(
                                "Certificate fingerprint did not match the pairing code."
                            )
                        }
                    }

                    override fun getAcceptedIssuers(): Array<X509Certificate> =
                        emptyArray()
                }

                val sslContext = SSLContext.getInstance("TLS").apply {
                    init(null, arrayOf<TrustManager>(trustManager), null)
                }

                val client = OkHttpClient.Builder()
                    .sslSocketFactory(sslContext.socketFactory, trustManager)
                    // The certificate itself is pinned above; the desktop's
                    // self-signed certificate has no public host name.
                    .hostnameVerifier { _, _ -> true }
                    .connectTimeout(10, TimeUnit.SECONDS)
                    .readTimeout(10, TimeUnit.SECONDS)
                    .callTimeout(15, TimeUnit.SECONDS)
                    .build()

                val request = Request.Builder()
                    .url("https://$address:$port$PROBE_PATH")
                    .get()
                    .build()

                client.newCall(request).execute().use { response ->
                    val certificate =
                        response.handshake?.peerCertificates?.firstOrNull() as? X509Certificate
                    val result = JSObject()
                    val reachable = response.code in setOf(200, 403)
                    result.put("ok", reachable)
                    result.put("httpStatus", response.code)
                    result.put(
                        "certificateFingerprint",
                        certificate?.let { sha256(it.encoded).uppercase(Locale.US) }
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

    private fun sha256(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { String.format(Locale.US, "%02x", it) }
    }

    // ---------------------------------------------------------- WorkManager

    @PluginMethod
    fun scheduleWorkProbe(call: PluginCall) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val request = OneTimeWorkRequestBuilder<SpikeWorker>()
            .setConstraints(constraints)
            .build()

        WorkManager.getInstance(context).enqueueUniqueWork(
            SpikeWorker.UNIQUE_WORK,
            ExistingWorkPolicy.REPLACE,
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

    private data class DiscoveredService(
        val name: String,
        val address: String,
        val port: Int,
        val fingerprint: String?,
        val version: String?
    )
}
