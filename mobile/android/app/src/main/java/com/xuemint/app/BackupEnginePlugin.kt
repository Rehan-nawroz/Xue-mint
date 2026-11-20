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
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
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
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

private const val SERVICE_TYPE = "_xue-mint._tcp"
private const val DEFAULT_SERVICE_TYPE = "_xue-mint._tcp.local."
private const val PROBE_PATH = "/local/status"
private const val CHECK_PATH = "/assets?limit=1"
private const val PAIR_PATH = "/pair"

private const val PREFS = "xue-mint-pairing"
private const val KEY_PAIRING = "pairing"
private const val STORAGE_KEY_ALIAS = "xue-mint-storage-key"
private const val DEVICE_KEY_ALIAS = "xue-mint-device"
private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"

private const val USED_TOKEN_MESSAGE =
    "This code was already used or has expired. Generate a new one on the PC."
private const val PIN_MISMATCH_MESSAGE =
    "This PC's certificate does not match the code."
private const val UNREACHABLE_MESSAGE =
    "Could not reach the PC. Check that both devices are on the same Wi-Fi and try again."
private const val BLOCKED_NETWORK_MESSAGE =
    "This Wi-Fi blocks phone-to-PC connections. Use your home Wi-Fi or a network that allows local devices to reach each other."
private const val UNPAIRED_MESSAGE =
    "This phone is no longer paired with the PC. Pair again with a fresh code."

private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

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
                val client = pinnedClient(expected)
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

    /**
     * Pinned HTTPS client: the certificate's SHA-256 must equal the value from
     * the pairing code. Hostname verification is skipped because the desktop's
     * self-signed certificate has no public host name; the pin is the identity.
     */
    private fun pinnedClient(
        fingerprint: String,
        connectSeconds: Long = 10,
        readSeconds: Long = 10,
        callSeconds: Long = 15
    ): OkHttpClient {
        val expected = normalizeFingerprint(fingerprint)
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

            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }

        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf<TrustManager>(trustManager), null)
        }

        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .hostnameVerifier { _, _ -> true }
            .connectTimeout(connectSeconds, TimeUnit.SECONDS)
            .readTimeout(readSeconds, TimeUnit.SECONDS)
            .callTimeout(callSeconds, TimeUnit.SECONDS)
            .build()
    }

    private fun normalizeFingerprint(value: String?): String =
        value
            ?.replace(":", "")
            ?.replace(" ", "")
            ?.lowercase(Locale.US)
            .orEmpty()

    private fun formatFingerprint(value: String): String =
        normalizeFingerprint(value)
            .chunked(2)
            .joinToString(":")
            .uppercase(Locale.US)

    // ---------------------------------------------------------------- pairing

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
            normalizeFingerprint(fingerprint).length != 64 || token.isEmpty()
        ) {
            call.reject("That code is missing its address, port, fingerprint or token.")
            return
        }

        executor.execute {
            var pinMismatch = false
            var timedOut = false
            var lastError: Exception? = null

            val publicKey = try {
                Base64.encodeToString(devicePublicKey(), Base64.NO_WRAP)
            } catch (error: Exception) {
                call.reject("Could not prepare this phone's key: ${error.message}")
                return@execute
            }

            for (rawAddress in addresses) {
                val address = rawAddress.trim()
                try {
                    val client = pinnedClient(fingerprint, 5, 8, 12)
                    val payload = JSONObject()
                        .put("token", token)
                        .put("devicePublicKey", publicKey)
                        .put("deviceName", Build.MODEL)
                        .toString()
                    val request = Request.Builder()
                        .url("https://$address:$port$PAIR_PATH")
                        .post(payload.toRequestBody(JSON_MEDIA_TYPE))
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
                                fingerprint = formatFingerprint(fingerprint),
                                deviceId = body.optString("deviceId"),
                                credential = credential,
                                pairedAt = isoNow()
                            )
                            savePairing(stored)
                            call.resolve(JSObject().put("pc", stored.toJsObject()))
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
                        is CertificateException, is SSLHandshakeException -> pinMismatch = true
                        is SocketTimeoutException -> timedOut = true
                    }
                    lastError = error
                }
            }

            when {
                pinMismatch -> call.reject(PIN_MISMATCH_MESSAGE)
                timedOut -> call.reject(UNREACHABLE_MESSAGE)
                else -> call.reject(describeReachability(lastError))
            }
        }
    }

    /**
     * Reports the stored pairing and whether the PC answers right now. When the
     * address has changed, mDNS is used once to find the same PC again by its
     * certificate fingerprint, so a new DHCP lease does not need re-pairing.
     */
    @PluginMethod
    fun pairingState(call: PluginCall) {
        executor.execute {
            val stored = loadPairing()
            if (stored == null) {
                val empty = JSObject()
                empty.put("paired", false)
                empty.put("pc", JSONObject.NULL)
                empty.put("connection", "not_paired")
                empty.put("message", "Pair once with your PC to start backup")
                call.resolve(empty)
                return@execute
            }

            var pairing = stored
            var outcome = checkConnection(pairing)
            if (outcome.connection != "connected") {
                val found = rediscover(pairing.fingerprint)
                if (found != null) {
                    pairing = pairing.copy(
                        addresses = (listOf(found.address) + pairing.addresses)
                            .distinct(),
                        port = found.port
                    )
                    savePairing(pairing)
                    outcome = checkConnection(pairing)
                    // The PC is advertised on this network but its port does
                    // not answer: the network is dropping device-to-device
                    // traffic rather than the PC being off.
                    if (outcome.connection == "unreachable" && outcome.timedOut) {
                        outcome = ConnectionOutcome("blocked", BLOCKED_NETWORK_MESSAGE)
                    }
                }
            }

            val result = JSObject()
            result.put("paired", true)
            result.put("pc", pairing.toJsObject())
            result.put("connection", outcome.connection)
            result.put("message", outcome.message)
            call.resolve(result)
        }
    }

    @PluginMethod
    fun forgetPc(call: PluginCall) {
        clearPairing()
        call.resolve()
    }

    private fun checkConnection(pairing: StoredPairing): ConnectionOutcome {
        var timedOut = false
        for (rawAddress in pairing.addresses) {
            val address = rawAddress.trim()
            try {
                val client = pinnedClient(pairing.fingerprint, 3, 5, 8)
                val request = Request.Builder()
                    .url("https://$address:${pairing.port}$CHECK_PATH")
                    .header("Authorization", "Device ${pairing.credential}")
                    .get()
                    .build()
                client.newCall(request).execute().use { response ->
                    return when (response.code) {
                        200 -> ConnectionOutcome(
                            "connected",
                            "Connected to ${pairing.serverName}"
                        )
                        401, 403 -> ConnectionOutcome("error", UNPAIRED_MESSAGE)
                        else -> ConnectionOutcome(
                            "error",
                            "The PC answered with HTTP ${response.code}."
                        )
                    }
                }
            } catch (error: Exception) {
                if (error is SocketTimeoutException) timedOut = true
            }
        }

        return ConnectionOutcome(
            "unreachable",
            "PC not reachable — will back up when you're home",
            timedOut = timedOut
        )
    }

    /** One short mDNS browse that matches the paired certificate fingerprint. */
    private fun rediscover(fingerprint: String, timeoutMs: Long = 4000): DiscoveredService? {
        val wanted = normalizeFingerprint(fingerprint)
        if (wanted.length != 64) return null

        val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
        val latch = CountDownLatch(1)
        var match: DiscoveredService? = null

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                try {
                    manager.resolveService(
                        serviceInfo,
                        object : NsdManager.ResolveListener {
                            override fun onResolveFailed(
                                serviceInfo: NsdServiceInfo,
                                errorCode: Int
                            ) = Unit

                            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                                val address = serviceInfo.host?.hostAddress ?: return
                                val attributes = serviceInfo.attributes
                                    ?.mapValues { (_, value) -> String(value, Charsets.UTF_8) }
                                    .orEmpty()
                                val found = normalizeFingerprint(attributes["fingerprint"])
                                if (found != wanted) return
                                if (match == null) {
                                    match = DiscoveredService(
                                        name = serviceInfo.serviceName,
                                        address = address,
                                        port = serviceInfo.port,
                                        fingerprint = attributes["fingerprint"],
                                        version = attributes["version"]
                                    )
                                    latch.countDown()
                                }
                            }
                        }
                    )
                } catch (_: Exception) {
                    // A service that cannot be resolved is simply skipped.
                }
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit

            override fun onDiscoveryStopped(serviceType: String) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                latch.countDown()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
        }

        return try {
            manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
            match
        } catch (_: Exception) {
            null
        } finally {
            try {
                manager.stopServiceDiscovery(listener)
            } catch (_: Exception) {
                // The platform may already have stopped the browse.
            }
        }
    }

    private fun describeReachability(error: Exception?): String = when (error) {
        is ConnectException, is UnknownHostException -> UNREACHABLE_MESSAGE
        is SocketTimeoutException -> BLOCKED_NETWORK_MESSAGE
        null -> UNREACHABLE_MESSAGE
        else -> error.message ?: UNREACHABLE_MESSAGE
    }

    private fun isoNow(): String = isoFormat.format(Date())

    // --------------------------------------------------------- pairing storage

    private fun savePairing(pairing: StoredPairing) {
        val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, storageKey())
        val encrypted = cipher.doFinal(pairing.toJson().toString().toByteArray(Charsets.UTF_8))
        val packed = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + "." +
            Base64.encodeToString(encrypted, Base64.NO_WRAP)
        preferences().edit().putString(KEY_PAIRING, packed).apply()
    }

    private fun loadPairing(): StoredPairing? {
        val packed = preferences().getString(KEY_PAIRING, null) ?: return null
        return try {
            val parts = packed.split('.')
            if (parts.size != 2) return null
            val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                storageKey(),
                GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP))
            )
            val json = String(
                cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)),
                Charsets.UTF_8
            )
            StoredPairing.fromJson(JSONObject(json))
        } catch (_: Exception) {
            null
        }
    }

    private fun clearPairing() {
        preferences().edit().remove(KEY_PAIRING).apply()
    }

    private fun preferences() =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply {
        load(null)
    }

    /** AES key held by the Android Keystore; only ciphertext touches disk. */
    private fun storageKey(): SecretKey {
        val store = keyStore()
        if (!store.containsAlias(STORAGE_KEY_ALIAS)) {
            val generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                "AndroidKeyStore"
            )
            generator.init(
                KeyGenParameterSpec.Builder(
                    STORAGE_KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
            generator.generateKey()
        }
        return (store.getEntry(STORAGE_KEY_ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
    }

    /** EC P-256 keypair created once and reused for every pairing. */
    private fun devicePublicKey(): ByteArray {
        val store = keyStore()
        if (!store.containsAlias(DEVICE_KEY_ALIAS)) {
            val generator = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC,
                "AndroidKeyStore"
            )
            generator.initialize(
                KeyGenParameterSpec.Builder(
                    DEVICE_KEY_ALIAS,
                    KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                )
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .build()
            )
            generator.generateKeyPair()
        }
        return store.getCertificate(DEVICE_KEY_ALIAS).publicKey.encoded
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

    private data class StoredPairing(
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

        fun toJsObject(): JSObject {
            val item = JSObject()
            item.put("name", serverName)
            item.put("addresses", JSArray().apply { addresses.forEach { put(it) } })
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

    private data class ConnectionOutcome(
        val connection: String,
        val message: String,
        val timedOut: Boolean = false
    )

    private data class DiscoveredService(
        val name: String,
        val address: String,
        val port: Int,
        val fingerprint: String?,
        val version: String?
    )
}
