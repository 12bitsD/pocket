package com.pocket.calendar

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
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
        try {
            ContextCompat.startForegroundService(context, svcIntent)
        } catch (err: Exception) {
            Log.e(TAG, "Foreground service start failed, using fallback", err)
            launchFallbackActivity(context, record)
        }
    }

    private fun launchFallbackActivity(context: Context, record: AlarmRecord) {
        try {
            val actIntent = Intent(context, RingingActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(ExactAlarmScheduler.EXTRA_ALARM_KEY, record.alarmKey)
                putExtra(AlarmRingingService.EXTRA_TITLE, record.title)
                putExtra(AlarmRingingService.EXTRA_SUBTITLE, record.subtitle)
            }
            context.startActivity(actIntent)
        } catch (err: Exception) {
            Log.e(TAG, "Fallback RingingActivity launch failed", err)
        }
    }

    companion object {
        private const val TAG = "PocketAlarmRcv"
    }
}
