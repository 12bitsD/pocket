package com.pocket.calendar

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != ExactAlarmScheduler.ACTION_ALARM_FIRE) {
            return
        }
        val alarmKey = intent.getStringExtra(
            ExactAlarmScheduler.EXTRA_ALARM_KEY
        ) ?: return
        val store = DirectBootAlarmStore.getInstance(context)
        val record = store.getAlarm(alarmKey) ?: return
        if (!record.enabled) {
            return
        }
        ExactAlarmScheduler.acquireHandoffWakeLock(context)
        val svcIntent = AlarmRingingService.buildServiceIntent(
            context,
            AlarmRingingService.ACTION_START_RINGING,
            record.alarmKey,
            record
        )
        ContextCompat.startForegroundService(context, svcIntent)
    }
}
