package com.pocket.calendar

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

data class DeviceAlarmPermissions(
    val exactAlarm: Boolean,
    val notifications: Boolean,
    val fullScreenIntent: Boolean,
    val batteryOptimization: Boolean
)

object PermissionInspector {
    fun inspect(context: Context): DeviceAlarmPermissions {
        val appCtx = context.applicationContext ?: context
        val exactReady = ExactAlarmScheduler.canScheduleExact(appCtx)
        val notifReady = isNotificationReady(appCtx)
        val fullScreenReady = isFullScreenReady(appCtx)
        val batteryReady = appCtx.getSystemService(PowerManager::class.java)
            ?.isIgnoringBatteryOptimizations(appCtx.packageName) == true

        return DeviceAlarmPermissions(
            exactAlarm = exactReady,
            notifications = notifReady,
            fullScreenIntent = fullScreenReady,
            batteryOptimization = batteryReady
        )
    }

    fun openSettings(context: Context, target: String): Boolean {
        val pkgUri = Uri.parse("package:${context.packageName}")
        val primaryIntent = buildTargetIntent(context, target, pkgUri)
        if (tryStartActivity(context, primaryIntent)) {
            return true
        }
        if (target == "batteryOptimization") {
            val listIntent = Intent(
                Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS
            )
            if (tryStartActivity(context, listIntent)) {
                return true
            }
        }
        return tryStartActivity(context, appDetailsIntent(pkgUri))
    }

    private fun isNotificationReady(appCtx: Context): Boolean {
        val appEnabled = NotificationManagerCompat.from(appCtx)
            .areNotificationsEnabled()
        val runtimeGranted =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                ContextCompat.checkSelfPermission(
                    appCtx,
                    Manifest.permission.POST_NOTIFICATIONS
                ) == PackageManager.PERMISSION_GRANTED
        val nm = appCtx.getSystemService(NotificationManager::class.java)
        val channel = nm?.getNotificationChannel(AlarmRingingService.CHANNEL_ID)
        val channelReady = channel == null ||
            channel.importance != NotificationManager.IMPORTANCE_NONE
        return appEnabled && runtimeGranted && channelReady
    }

    private fun isFullScreenReady(appCtx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            return true
        }
        return appCtx.getSystemService(NotificationManager::class.java)
            ?.canUseFullScreenIntent() == true
    }

    private fun buildTargetIntent(
        context: Context,
        target: String,
        pkgUri: Uri
    ): Intent {
        return when (target) {
            "exactAlarm" -> if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ) {
                Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkgUri)
            } else {
                appDetailsIntent(pkgUri)
            }
            "notifications" -> Intent(
                Settings.ACTION_APP_NOTIFICATION_SETTINGS
            ).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            }
            "fullScreenIntent" -> if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
            ) {
                Intent(
                    Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                    pkgUri
                )
            } else {
                appDetailsIntent(pkgUri)
            }
            "batteryOptimization" -> Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                pkgUri
            )
            else -> appDetailsIntent(pkgUri)
        }
    }

    private fun appDetailsIntent(pkgUri: Uri): Intent {
        return Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri)
    }

    private fun tryStartActivity(context: Context, intent: Intent): Boolean {
        return try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }
}
