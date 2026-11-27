package com.pocket.calendar

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat

class AlarmRingingService : Service() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var hardware: AlarmHardwareController
    private var activeAlarmKey: String? = null
    private val timeoutRunnable = Runnable { handleUnansweredTimeout() }

    override fun onCreate() {
        super.onCreate()
        hardware = AlarmHardwareController(this)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int
    ): Int {
        val key = intent?.getStringExtra(ExactAlarmScheduler.EXTRA_ALARM_KEY)
        when (intent?.action) {
            ACTION_START_RINGING -> handleStartCommand(intent, key)
            ACTION_DISMISS_RINGING -> finishAlarmCommand(
                key ?: activeAlarmKey
            ) { persistRingOutcome(it, EVENT_DISMISSED) }
            ACTION_SNOOZE_RINGING -> finishAlarmCommand(
                key ?: activeAlarmKey
            ) { persistSnooze(it) }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopAlertSession()
        super.onDestroy()
    }

    private fun handleStartCommand(intent: Intent, key: String?) {
        if (key == null) {
            ExactAlarmScheduler.releaseHandoffWakeLock()
            stopSelf()
            return
        }
        val prevKey = activeAlarmKey
        if (prevKey != null && prevKey != key) {
            persistRingOutcome(prevKey, EVENT_MISSED)
        }
        val title = intent.getStringExtra(EXTRA_TITLE) ?: "Pocket 闹钟"
        val subtitle = intent.getStringExtra(EXTRA_SUBTITLE) ?: ""
        startRingingSession(key, title, subtitle)
    }

    private fun finishAlarmCommand(
        key: String?,
        persist: (String) -> Unit
    ) {
        if (key == null) {
            stopRingingAndFinish(null)
            return
        }
        persist(key)
        if (activeAlarmKey == null || activeAlarmKey == key) {
            stopRingingAndFinish(key)
        }
    }

    private fun startRingingSession(
        alarmKey: String,
        title: String,
        subtitle: String
    ) {
        stopAlertSession()
        activeAlarmKey = alarmKey
        hardware.acquireSessionWakeLock(RING_TIMEOUT_MS + 30_000L)
        ExactAlarmScheduler.releaseHandoffWakeLock()
        ensureAlarmChannel()
        val notification = buildAlarmNotification(alarmKey, title, subtitle)
        startAlarmForeground(notification)
        scheduleNextIfRecurring(alarmKey)
        hardware.startAudioAndVibration()
        mainHandler.postDelayed(timeoutRunnable, RING_TIMEOUT_MS)
        launchLockscreenActivity(alarmKey, title, subtitle)
    }

    private fun startAlarmForeground(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val started = tryStartForeground(
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED
            ) || tryStartForeground(
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            )
            if (!started) {
                Log.e(TAG, "Unable to enter foreground on API 34+")
            }
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tryStartForeground(
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            )
            return
        }
        try {
            startForeground(NOTIFICATION_ID, notification)
        } catch (err: Exception) {
            Log.e(TAG, "Unable to enter foreground", err)
        }
    }

    private fun tryStartForeground(
        notification: Notification,
        serviceType: Int
    ): Boolean {
        return try {
            startForeground(NOTIFICATION_ID, notification, serviceType)
            true
        } catch (err: Exception) {
            Log.w(TAG, "startForeground failed for type=$serviceType", err)
            false
        }
    }

    private fun scheduleNextIfRecurring(alarmKey: String) {
        val store = DirectBootAlarmStore.getInstance(this)
        val record = store.getAlarm(alarmKey) ?: return
        if (!AlarmTimeCalculator.isOneShot(record)) {
            ExactAlarmScheduler.advanceAfterRing(
                this,
                store,
                record,
                System.currentTimeMillis()
            )
        }
    }

    private fun persistRingOutcome(alarmKey: String, eventKind: String) {
        val nowMs = System.currentTimeMillis()
        val store = DirectBootAlarmStore.getInstance(this)
        val record = store.getAlarm(alarmKey) ?: return
        store.appendRingingEvent(
            entityType = record.entityType,
            entityId = record.entityId,
            eventKind = eventKind,
            occurredAtMs = nowMs
        )
        ExactAlarmScheduler.advanceAfterRing(this, store, record, nowMs)
    }

    private fun persistSnooze(alarmKey: String) {
        val nowMs = System.currentTimeMillis()
        val snoozeMs = AlarmTimeCalculator.computeSnoozeTriggerMillis(nowMs)
        val store = DirectBootAlarmStore.getInstance(this)
        val record = store.getAlarm(alarmKey) ?: return
        val snoozed = record.copy(enabled = true, snoozeUntilMs = snoozeMs)
        val status = ExactAlarmScheduler.scheduleAlarm(this, snoozed, snoozeMs)
        val storedMs = if (status == ArmedStatus.EXECUTED) snoozeMs else null
        store.updateScheduleState(
            alarmKey,
            ScheduleStatePatch(
                activeState = AlarmActiveState.ENABLED,
                snoozeUntilMs = storedMs,
                nextTriggerMs = storedMs
            )
        )
        store.appendRingingEvent(
            entityType = record.entityType,
            entityId = record.entityId,
            eventKind = EVENT_SNOOZED,
            occurredAtMs = nowMs
        )
    }

    private fun handleUnansweredTimeout() {
        finishAlarmCommand(activeAlarmKey) {
            persistRingOutcome(it, EVENT_MISSED)
        }
    }

    private fun stopRingingAndFinish(finishedKey: String?) {
        activeAlarmKey = null
        stopAlertSession()
        RingingActivity.requestFinish(this, finishedKey)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun stopAlertSession() {
        mainHandler.removeCallbacks(timeoutRunnable)
        if (::hardware.isInitialized) {
            hardware.stopAll()
        }
    }

    private fun ensureAlarmChannel() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Pocket 准点响铃",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "锁屏全屏唤醒与系统级闹钟提醒"
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setBypassDnd(true)
            setSound(null, null)
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildAlarmNotification(
        alarmKey: String,
        title: String,
        subtitle: String
    ): Notification {
        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or
            PendingIntent.FLAG_IMMUTABLE
        val fullPending = PendingIntent.getActivity(
            this,
            1001,
            buildRingingActivityIntent(alarmKey, title, subtitle),
            piFlags
        )
        val dismissPending = PendingIntent.getService(
            this,
            1002,
            buildServiceIntent(this, ACTION_DISMISS_RINGING, alarmKey, null),
            piFlags
        )
        val snoozePending = PendingIntent.getService(
            this,
            1003,
            buildServiceIntent(this, ACTION_SNOOZE_RINGING, alarmKey, null),
            piFlags
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(title)
            .setContentText(subtitle.ifBlank { "ALARM RINGING" })
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(fullPending, true)
            .setContentIntent(fullPending)
            .addAction(0, "关闭本次", dismissPending)
            .addAction(0, "10 分钟后再响", snoozePending)
            .build()
    }

    private fun buildRingingActivityIntent(
        alarmKey: String,
        title: String,
        subtitle: String
    ): Intent {
        return Intent(this, RingingActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(ExactAlarmScheduler.EXTRA_ALARM_KEY, alarmKey)
            putExtra(EXTRA_TITLE, title)
            putExtra(EXTRA_SUBTITLE, subtitle)
        }
    }

    private fun launchLockscreenActivity(
        alarmKey: String,
        title: String,
        subtitle: String
    ) {
        try {
            startActivity(buildRingingActivityIntent(alarmKey, title, subtitle))
        } catch (err: Exception) {
            Log.w(TAG, "FullScreenIntent handles lockscreen presentation", err)
        }
    }

    companion object {
        private const val TAG = "PocketAlarmSvc"
        const val CHANNEL_ID = "pocket_alarm_ringing"
        const val ACTION_START_RINGING =
            "com.pocket.calendar.ACTION_START_RINGING"
        const val ACTION_DISMISS_RINGING =
            "com.pocket.calendar.ACTION_DISMISS_RINGING"
        const val ACTION_SNOOZE_RINGING =
            "com.pocket.calendar.ACTION_SNOOZE_RINGING"
        const val EXTRA_TITLE = "alarm_title"
        const val EXTRA_SUBTITLE = "alarm_subtitle"
        const val EVENT_DISMISSED = "DISMISSED"
        const val EVENT_SNOOZED = "SNOOZED"
        const val EVENT_MISSED = "MISSED"
        private const val NOTIFICATION_ID = 4201
        private const val RING_TIMEOUT_MS = 5 * 60_000L

        fun buildServiceIntent(
            context: Context,
            action: String,
            alarmKey: String,
            record: AlarmRecord?
        ): Intent {
            return Intent(context, AlarmRingingService::class.java).apply {
                this.action = action
                putExtra(ExactAlarmScheduler.EXTRA_ALARM_KEY, alarmKey)
                if (record != null) {
                    putExtra(EXTRA_TITLE, record.title)
                    putExtra(EXTRA_SUBTITLE, record.subtitle)
                }
            }
        }
    }
}
