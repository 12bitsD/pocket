package com.pocket.calendar

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.os.Build
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log

class AlarmHardwareController(private val serviceContext: Context) {
    private var ringtone: Ringtone? = null
    private var fallbackTone: ToneGenerator? = null
    private var wakeLock: PowerManager.WakeLock? = null

    fun acquireSessionWakeLock(timeoutMs: Long) {
        val pm = serviceContext.getSystemService(PowerManager::class.java)
            ?: return
        val lock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "pocket:alarmRingingWakeLock"
        )
        lock.setReferenceCounted(false)
        lock.acquire(timeoutMs)
        wakeLock = lock
    }

    fun startAudioAndVibration() {
        if (!tryStartSystemRingtone()) {
            startFallbackAlarmTone()
        }
        try {
            val vibrator = resolveVibrator()
            val pattern = longArrayOf(0L, 600L, 400L)
            vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
        } catch (err: Exception) {
            Log.w(TAG, "Vibration unavailable", err)
        }
    }

    fun stopAll() {
        try {
            ringtone?.stop()
        } catch (err: Exception) {
            Log.w(TAG, "Failed stopping ringtone", err)
        }
        ringtone = null
        try {
            fallbackTone?.stopTone()
            fallbackTone?.release()
        } catch (err: Exception) {
            Log.w(TAG, "Failed releasing ToneGenerator", err)
        }
        fallbackTone = null
        try {
            resolveVibrator()?.cancel()
        } catch (err: Exception) {
            Log.w(TAG, "Failed canceling vibrator", err)
        }
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (err: Exception) {
            Log.w(TAG, "Failed releasing wakeLock", err)
        }
        wakeLock = null
    }

    private fun tryStartSystemRingtone(): Boolean {
        return try {
            val devCtx = serviceContext.createDeviceProtectedStorageContext()
                ?: serviceContext
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(
                    RingtoneManager.TYPE_NOTIFICATION
                )
            val rt = RingtoneManager.getRingtone(devCtx, uri) ?: return false
            rt.audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                rt.isLooping = true
            }
            rt.play()
            ringtone = rt
            true
        } catch (err: Exception) {
            Log.w(TAG, "System ringtone unavailable in Direct Boot", err)
            false
        }
    }

    private fun startFallbackAlarmTone() {
        try {
            val tg = ToneGenerator(AudioManager.STREAM_ALARM, 85)
            tg.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 5_000)
            fallbackTone = tg
        } catch (err: Exception) {
            Log.w(TAG, "Fallback ToneGenerator unavailable", err)
        }
    }

    private fun resolveVibrator(): Vibrator? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            serviceContext
                .getSystemService(VibratorManager::class.java)
                ?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            serviceContext.getSystemService(Vibrator::class.java)
        }
    }

    companion object {
        private const val TAG = "PocketAlarmHw"
    }
}
