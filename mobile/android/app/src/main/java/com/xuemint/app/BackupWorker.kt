package com.xuemint.app

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Runs one backup pass outside the app's UI process. The constraints come
 * from the user's backup rules: Wi-Fi only keeps the work on unmetered
 * networks, and charging-only waits for a plugged-in phone. WorkManager holds
 * the work in the queue until the rules are satisfied.
 */
class BackupWorker(context: Context, parameters: WorkerParameters) :
    Worker(context, parameters) {

    override fun doWork(): Result {
        val store = EngineStore(applicationContext)
        val runner = BackupRunner(applicationContext, store)
        return when (val outcome = runner.run()) {
            BackupOutcome.COMPLETED,
            BackupOutcome.PAUSED_UNREACHABLE,
            BackupOutcome.NOT_PAIRED,
            BackupOutcome.ALREADY_RUNNING -> Result.success(
                workDataOf("outcome" to outcome.name)
            )
            // Pairing is broken: fail loudly so the status surface asks the
            // user to pair again instead of retrying forever.
            BackupOutcome.AUTH_ERROR -> Result.failure(
                workDataOf("outcome" to outcome.name)
            )
        }
    }

    companion object {
        const val UNIQUE_WORK = "xue-mint-backup"
        const val PERIODIC_WORK = "xue-mint-backup-periodic"

        /** How often the safety-net pass runs with the app closed. */
        private const val PERIODIC_HOURS = 3L
        private const val FLEX_HOURS = 1L

        fun constraintsFor(settings: EngineSettingsData): Constraints {
            val builder = Constraints.Builder()
            builder.setRequiredNetworkType(
                if (settings.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED
            )
            if (settings.chargingOnly) builder.setRequiresCharging(true)
            return builder.build()
        }

        /** Re-queues background backup under the current rules, if there is work. */
        @JvmStatic
        fun schedule(context: Context, store: EngineStore, replace: Boolean): Boolean {
            val settings = store.settings()
            if (!settings.autoBackup) return false
            val counts = store.counts()
            if (counts.pending == 0 && counts.failed == 0) return false

            val manager = WorkManager.getInstance(context)
            if (replace) manager.cancelUniqueWork(UNIQUE_WORK)
            manager.enqueueUniqueWork(
                UNIQUE_WORK,
                if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<BackupWorker>()
                    .setConstraints(constraintsFor(settings))
                    .build()
            )
            return true
        }

        /**
         * Keeps the safety-net periodic pass in step with the backup rules.
         * Called when the app opens and whenever the rules change; WorkManager
         * re-runs periodic work after a reboot on its own.
         */
        @JvmStatic
        fun schedulePeriodic(context: Context) {
            thread {
                try {
                    val store = EngineStore(context)
                    val settings = store.settings()
                    val manager = WorkManager.getInstance(context)
                    if (!settings.autoBackup) {
                        manager.cancelUniqueWork(PERIODIC_WORK)
                        manager.cancelUniqueWork(UNIQUE_WORK)
                        return@thread
                    }
                    val request = PeriodicWorkRequestBuilder<BackupWorker>(
                        PERIODIC_HOURS, TimeUnit.HOURS,
                        FLEX_HOURS, TimeUnit.HOURS
                    )
                        .setConstraints(constraintsFor(settings))
                        .build()
                    manager.enqueueUniquePeriodicWork(
                        PERIODIC_WORK,
                        ExistingPeriodicWorkPolicy.UPDATE,
                        request
                    )
                } catch (error: Exception) {
                    println("BackupWorker: periodic scheduling failed: ${error.message}")
                }
            }
        }
    }
}
