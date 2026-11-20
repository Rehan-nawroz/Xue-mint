package com.xuemint.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Talks to the paired PC: a reachability check over pinned TLS and one short
 * mDNS browse to find the same PC again by certificate fingerprint after its
 * address changed.
 */
class PcLink(
    private val context: Context,
    private val pairing: StoredPairing
) {

    /**
     * Answers whether the PC is connected right now. Any definitive HTTP
     * response proves the PC is up; 401/403 additionally mean the credential
     * is no longer accepted and the phone must pair again.
     */
    fun check(): ConnectionOutcome {
        var timedOut = false
        for (rawAddress in pairing.addresses) {
            val address = rawAddress.trim()
            try {
                val client = PinnedNet.client(pairing.fingerprint, 3, 5, 8)
                val request = okhttp3.Request.Builder()
                    .url("https://$address:${pairing.port}/assets?limit=1")
                    .header("Authorization", "Device ${pairing.credential}")
                    .get()
                    .build()
                client.newCall(request).execute().use { response ->
                    return when (response.code) {
                        200 -> ConnectionOutcome(
                            "connected",
                            "Connected to ${pairing.serverName}",
                            workingAddress = address
                        )
                        401, 403 -> ConnectionOutcome(
                            "error",
                            UNPAIRED_MESSAGE,
                            authProblem = true,
                            workingAddress = address
                        )
                        else -> ConnectionOutcome(
                            "error",
                            "The PC answered with HTTP ${response.code}.",
                            workingAddress = address
                        )
                    }
                }
            } catch (error: Exception) {
                if (error is java.net.SocketTimeoutException) timedOut = true
            }
        }

        return ConnectionOutcome(
            "unreachable",
            "PC not reachable — will back up when you're home",
            timedOut = timedOut
        )
    }

    /** One short mDNS browse that matches the paired certificate fingerprint. */
    fun rediscover(timeoutMs: Long = 4000): DiscoveredService? {
        val wanted = PinnedNet.normalizeFingerprint(pairing.fingerprint)
        if (wanted.length != 64) return null

        val manager =
            context.getSystemService(Context.NSD_SERVICE) as NsdManager
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
                                val found = PinnedNet.normalizeFingerprint(
                                    attributes["fingerprint"]
                                )
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
            manager.discoverServices(MDNS_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
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
}
