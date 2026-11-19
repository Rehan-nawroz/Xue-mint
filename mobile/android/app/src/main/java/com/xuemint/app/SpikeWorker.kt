package com.xuemint.app

import android.content.Context
import androidx.work.Data
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * Minimal background job for the native spike: it records that WorkManager ran
 * while the network constraint was satisfied, without touching photo content.
 */
class SpikeWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val preferences = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        preferences
            .edit()
            .putLong("lastRunAt", System.currentTimeMillis())
            .apply()

        val message = "Worker ran in the background after the network became available."
        return Result.success(Data.Builder().putString("message", message).build())
    }

    companion object {
        const val PREFS = "xue-mint-native-spike"
        const val UNIQUE_WORK = "xue-mint-native-spike-work"
    }
}
