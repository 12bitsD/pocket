package com.pocket.calendar

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager

object ExactAlarmScheduler {
    const val ACTION_ALARM_FIRE = "com.pocket.calendar.ACTION_ALARM_FIRE"
    const val EXTRA_ALARM_KEY = "alarm_key"
    const val EVENT_SKIP_CONSUMED = "SKIP_CONSUMED"
    private const val HANDOFF_LOCK_MS = 10_000L

    @Volatile
    private var handoffLock: PowerManager.WakeLock? = null

    fun canScheduleExact(context: Context): Boolean {
        val am = context.getSystemService(AlarmManager::class.java)
            ?: return false
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            am.canScheduleExactAlarms()
    }

    fun acquireHandoffWakeLock(context: Context) {
        val pm = context.getSystemService(PowerManager::class.java) ?: return
        synchronized(this) {
            val lock = handoffLock ?: pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "pocket:alarmBroadcastHandoff"
            ).apply {
                setReferenceCounted(false)
                handoffLock = this
            }
            lock.acquire(HANDOFF_LOCK_MS)
        }
    }

    fun releaseHandoffWakeLock() {
        synchronized(this) {
            if (handoffLock?.isHeld == true) {
                handoffLock?.release()
            }
        }
    }

    fun scheduleAlarm(
        context: Context,
        record: AlarmRecord,
        triggerAtMillis: Long
    ): ArmedStatus {
        val am = context.getSystemService(AlarmManager::class.java)
            ?: return ArmedStatus.FAILED
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            !am.canScheduleExactAlarms()
        ) {
            return ArmedStatus.FAILED
        }
        val reqCode = requestCodeFor(record.alarmKey)
        val showIntent = Intent(context, MainActivity::class.java).apply {
            data = Uri.parse("pocket://show/${record.alarmKey}")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or
            PendingIntent.FLAG_IMMUTABLE
        val showPending = PendingIntent.getActivity(
            context,
            reqCode,
            showIntent,
            piFlags
        )
        val firePending = buildFirePendingIntent(
            context,
            record.alarmKey,
            piFlags
        ) ?: return ArmedStatus.FAILED

        return try {
            val info = AlarmManager.AlarmClockInfo(triggerAtMillis, showPending)
            am.setAlarmClock(info, firePending)
            ArmedStatus.EXECUTED
        } catch (_: SecurityException) {
            ArmedStatus.FAILED
        }
    }

    fun cancelAlarm(context: Context, alarmKey: String) {
        val am = context.getSystemService(AlarmManager::class.java)
        val flags = PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
        val existing = buildFirePendingIntent(context, alarmKey, flags)
        if (existing != null) {
            am?.cancel(existing)
            existing.cancel()
        }
    }

    private fun armOrCancel(
        context: Context,
        record: AlarmRecord,
        triggerMs: Long?,
        failOnMissingPerm: Boolean
    ): Pair<ArmedStatus, Long?> {
        if (triggerMs == null) {
            cancelAlarm(context, record.alarmKey)
            val status = if (failOnMissingPerm && !canScheduleExact(context)) {
                ArmedStatus.FAILED
            } else {
                ArmedStatus.EXPIRED
            }
            return status to null
        }
        val status = scheduleAlarm(context, record, triggerMs)
        val stored = if (status == ArmedStatus.EXECUTED) triggerMs else null
        return status to stored
    }

    fun reconcileAlarm(
        context: Context,
        store: DirectBootAlarmStore,
        record: AlarmRecord,
        nowMs: Long
    ): Pair<ArmedStatus, Long?> {
        if (!record.enabled) {
            cancelAlarm(context, record.alarmKey)
            store.upsertAlarm(record.copy(nextTriggerMs = null))
            return ArmedStatus.EXPIRED to null
        }
        val computed = AlarmTimeCalculator.computeSchedule(record, nowMs)
        if (computed.skipConsumed) {
            store.appendRingingEvent(
                record.entityType,
                record.entityId,
                EVENT_SKIP_CONSUMED,
                nowMs
            )
        }
        val nextSkip = record.skipNext && !computed.skipConsumed
        val (status, storedTrigger) = armOrCancel(
            context,
            record,
            computed.triggerAtMs,
            failOnMissingPerm = true
        )
        store.upsertAlarm(
            record.copy(
                skipNext = nextSkip,
                skipTargetMs = if (nextSkip) computed.skipTargetMs else null,
                nextTriggerMs = storedTrigger
            )
        )
        return status to storedTrigger
    }

    fun advanceAfterRing(
        context: Context,
        store: DirectBootAlarmStore,
        record: AlarmRecord,
        nowMs: Long
    ) {
        if (AlarmTimeCalculator.isOneShot(record)) {
            cancelAlarm(context, record.alarmKey)
            store.updateScheduleState(
                record.alarmKey,
                ScheduleStatePatch(
                    activeState = AlarmActiveState.DISABLED,
                    snoozeUntilMs = null,
                    nextTriggerMs = null,
                    skipPolicy = SkipNextPolicy.CLEAR
                )
            )
            return
        }
        val clean = record.copy(
            snoozeUntilMs = null,
            skipNext = false,
            skipTargetMs = null
        )
        val nextMs = AlarmTimeCalculator.computeNextTriggerMillis(
            clean,
            nowMs + 1_000L
        )
        val (_, stored) = armOrCancel(
            context,
            clean,
            nextMs,
            failOnMissingPerm = false
        )
        store.updateScheduleState(
            record.alarmKey,
            ScheduleStatePatch(
                activeState = AlarmActiveState.ENABLED,
                snoozeUntilMs = null,
                nextTriggerMs = stored,
                skipPolicy = SkipNextPolicy.CLEAR
            )
        )
    }

    fun rearmAllEnabledAlarms(context: Context, nowMillis: Long) {
        val store = DirectBootAlarmStore.getInstance(context)
        for (alarm in store.listEnabledAlarms()) {
            val activeSnooze = alarm.snoozeUntilMs?.takeIf { it > nowMillis }
            reconcileAlarm(
                context,
                store,
                alarm.copy(snoozeUntilMs = activeSnooze),
                nowMillis
            )
        }
    }

    private fun buildFirePendingIntent(
        context: Context,
        alarmKey: String,
        flags: Int
    ): PendingIntent? {
        val fireIntent = Intent(context, AlarmReceiver::class.java).apply {
            action = ACTION_ALARM_FIRE
            data = Uri.parse("pocket://alarm/$alarmKey")
            putExtra(EXTRA_ALARM_KEY, alarmKey)
        }
        return PendingIntent.getBroadcast(
            context,
            requestCodeFor(alarmKey),
            fireIntent,
            flags
        )
    }

    private fun requestCodeFor(alarmKey: String): Int {
        return alarmKey.hashCode() and 0x7FFFFFFF
    }
}
