package com.xuemint.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Backup status notifications: one live progress card while a pass is
 * running and a summary card with the result. Counts and status only —
 * photo content never appears in a notification.
 */
object BackupNotifier {
    private const val CHANNEL_ID = "backup"
    private const val PROGRESS_ID = 41
    private const val SUMMARY_ID = 42

    /** Whether this app may post notifications on this Android version. */
    fun allowed(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun channel(context: Context) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val existing = manager.getNotificationChannel(CHANNEL_ID)
        if (existing == null) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Backup status",
                NotificationManager.IMPORTANCE_LOW
            )
            channel.description = "Shows when photos are being sent to your PC"
            manager.createNotificationChannel(channel)
        }
    }

    private fun openAppIntent(context: Context): PendingIntent =
        PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    private fun post(context: Context, id: Int, notification: android.app.Notification) {
        if (!allowed(context)) return
        channel(context)
        NotificationManagerCompat.from(context).notify(id, notification)
    }

    /** Live card while a pass is running, for example "Backing up 214 photos…". */
    fun progress(context: Context, message: String) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Backing up photos")
            .setContentText(message)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openAppIntent(context))
            .build()
        post(context, PROGRESS_ID, notification)
    }

    /** Result card after a pass ends, for example "All photos are on your PC". */
    fun summary(context: Context, message: String) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("Photo backup")
            .setContentText(message)
            .setContentIntent(openAppIntent(context))
            .setAutoCancel(true)
            .build()
        post(context, SUMMARY_ID, notification)
    }

    /** Removes the live card, for example when the app is closed mid-pass. */
    fun cancelProgress(context: Context) {
        if (!allowed(context)) return
        NotificationManagerCompat.from(context).cancel(PROGRESS_ID)
    }
}
