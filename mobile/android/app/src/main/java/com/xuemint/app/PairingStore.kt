package com.xuemint.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val PREFS = "xue-mint-pairing"
private const val KEY_PAIRING = "pairing"
private const val STORAGE_KEY_ALIAS = "xue-mint-storage-key"
private const val DEVICE_KEY_ALIAS = "xue-mint-device"
private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"

/**
 * Encrypted pairing storage. The credential and PC details are AES-256-GCM
 * encrypted with a key held in the Android Keystore, so only ciphertext ever
 * touches disk. The device keypair is an EC P-256 Keystore key reused across
 * pairings so the PC recognizes this phone.
 */
object PairingStore {

    fun save(context: Context, pairing: StoredPairing) {
        val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, storageKey(context))
        val encrypted = cipher.doFinal(pairing.toJson().toString().toByteArray(Charsets.UTF_8))
        val packed = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + "." +
            Base64.encodeToString(encrypted, Base64.NO_WRAP)
        preferences(context).edit().putString(KEY_PAIRING, packed).apply()
    }

    fun load(context: Context): StoredPairing? {
        val packed = preferences(context).getString(KEY_PAIRING, null) ?: return null
        return try {
            val parts = packed.split('.')
            if (parts.size != 2) return null
            val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                storageKey(context),
                GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP))
            )
            val json = String(
                cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)),
                Charsets.UTF_8
            )
            StoredPairing.fromJson(org.json.JSONObject(json))
        } catch (_: Exception) {
            null
        }
    }

    fun clear(context: Context) {
        preferences(context).edit().remove(KEY_PAIRING).apply()
    }

    private fun preferences(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** AES key held by the Android Keystore; only ciphertext touches disk. */
    private fun storageKey(context: Context): SecretKey {
        val store = PinnedNet.keyStore()
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
    fun devicePublicKey(context: Context): ByteArray {
        val store = PinnedNet.keyStore()
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
}
