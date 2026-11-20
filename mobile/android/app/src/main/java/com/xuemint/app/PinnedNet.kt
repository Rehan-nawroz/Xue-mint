package com.xuemint.app

import android.os.Build
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

const val USED_TOKEN_MESSAGE =
    "This code was already used or has expired. Generate a new one on the PC."
const val PIN_MISMATCH_MESSAGE =
    "This PC's certificate does not match the code."
const val UNREACHABLE_MESSAGE =
    "Could not reach the PC. Check that both devices are on the same Wi-Fi and try again."
const val BLOCKED_NETWORK_MESSAGE =
    "This Wi-Fi blocks phone-to-PC connections. Use your home Wi-Fi or a network that allows local devices to reach each other."
const val UNPAIRED_MESSAGE =
    "This phone is no longer paired with the PC. Pair again with a fresh code."
const val WIFI_ONLY_MESSAGE =
    "Wi-Fi only is on, so backup waits for your home Wi-Fi. Turn it off in Settings to back up over mobile data."

val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
val OCTET_STREAM_MEDIA_TYPE = "application/octet-stream".toMediaType()

/** Shared UTC clock formatting used across the engine. */
val ISO_FORMAT: SimpleDateFormat =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
        timeZone = java.util.TimeZone.getTimeZone("UTC")
    }

fun isoNow(): String = ISO_FORMAT.format(Date())

/**
 * Pinned HTTPS client shared by pairing, status checks and backup uploads.
 * The certificate's SHA-256 must equal the value from the pairing code.
 * Hostname verification is skipped because the desktop's self-signed
 * certificate has no public host name; the pin is the identity.
 */
object PinnedNet {

    fun client(
        fingerprint: String,
        connectSeconds: Long = 10,
        readSeconds: Long = 10,
        callSeconds: Long = 15,
        writeSeconds: Long = 60,
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
            .writeTimeout(writeSeconds, TimeUnit.SECONDS)
            .callTimeout(callSeconds, TimeUnit.SECONDS)
            .build()
    }

    fun normalizeFingerprint(value: String?): String =
        value
            ?.replace(":", "")
            ?.replace(" ", "")
            ?.lowercase(Locale.US)
            .orEmpty()

    fun formatFingerprint(value: String): String =
        normalizeFingerprint(value)
            .chunked(2)
            .joinToString(":")
            .uppercase(Locale.US)

    fun sha256(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { String.format(Locale.US, "%02x", it) }
    }

    /** Turns a transport failure into the sentence the UI shows the user. */
    fun describeReachability(error: Exception?): String = when (error) {
        is ConnectException, is UnknownHostException -> UNREACHABLE_MESSAGE
        is SocketTimeoutException -> BLOCKED_NETWORK_MESSAGE
        is SSLHandshakeException, is CertificateException -> PIN_MISMATCH_MESSAGE
        null -> UNREACHABLE_MESSAGE
        else -> error.message ?: UNREACHABLE_MESSAGE
    }

    fun deviceName(): String = Build.MODEL

    fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply {
        load(null)
    }

    /** Parses an error response body into its code and sentence. */
    fun parseError(body: String?): Pair<String, String> =
        try {
            val json = JSONObject(body.orEmpty())
            json.optString("code") to json.optString("message")
        } catch (_: Exception) {
            "" to ""
        }
}
