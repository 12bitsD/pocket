package com.pocket.calendar

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.Ringtone
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.UserManager
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log

class AlarmHardwareController(private val serviceContext: Context) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var mediaPlayer: MediaPlayer? = null
    private var ringtone: Ringtone? = null
    private var fallbackTone: ToneGenerator? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var fallbackActive: Boolean = false

    private val fallbackLoop = object : Runnable {
        override fun run() {
            if (!fallbackActive) {
                return
            }
            try {
                fallbackTone?.startTone(
                    ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD,
                    1_200
                )
            } catch (err: Exception) {
                Log.w(TAG, "Fallback tone pulse failed", err)
            }
            mainHandler.postDelayed(this, 1_800L)
        }
    }

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
        requestAlarmAudioFocus()
        if (!tryStartMediaPlayer() && !tryStartSystemRingtone()) {
            startFallbackAlarmTone()
        }
        startAlarmVibration()
    }

    fun stopAll() {
        fallbackActive = false
        mainHandler.removeCallbacks(fallbackLoop)
        runCleanupStep("Failed stopping MediaPlayer") {
            mediaPlayer?.stop()
            mediaPlayer?.release()
        }
        mediaPlayer = null
        runCleanupStep("Failed stopping ringtone") {
            ringtone?.stop()
        }
        ringtone = null
        runCleanupStep("Failed releasing ToneGenerator") {
            fallbackTone?.stopTone()
            fallbackTone?.release()
        }
        fallbackTone = null
        runCleanupStep("Failed abandoning audio focus") {
            abandonAlarmAudioFocus()
        }
        runCleanupStep("Failed canceling vibrator") {
            resolveVibrator()?.cancel()
        }
        runCleanupStep("Failed releasing wakeLock") {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        }
        wakeLock = null
    }

    private fun runCleanupStep(message: String, step: () -> Unit) {
        try {
            step()
        } catch (err: Exception) {
            Log.w(TAG, message, err)
        }
    }

    private fun alarmAudioAttributes(): AudioAttributes {
        return AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
    }

    private fun requestAlarmAudioFocus() {
        runCleanupStep("Audio focus request failed") {
            val am = serviceContext.getSystemService(AudioManager::class.java)
                ?: return@runCleanupStep
            val req = AudioFocusRequest.Builder(
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
            )
                .setAudioAttributes(alarmAudioAttributes())
                .build()
            am.requestAudioFocus(req)
            audioFocusRequest = req
        }
    }

    private fun abandonAlarmAudioFocus() {
        val req = audioFocusRequest ?: return
        audioFocusRequest = null
        val am = serviceContext.getSystemService(AudioManager::class.java)
            ?: return
        am.abandonAudioFocusRequest(req)
    }

    private fun resolveAudioContext(): Context {
        val um = serviceContext.getSystemService(UserManager::class.java)
        if (um != null && !um.isUserUnlocked) {
            return serviceContext.createDeviceProtectedStorageContext()
                ?: serviceContext
        }
        return serviceContext
    }

    private fun candidateAlarmUris(): List<Uri> {
        val types = listOf(
            RingtoneManager.TYPE_ALARM,
            RingtoneManager.TYPE_RINGTONE,
            RingtoneManager.TYPE_NOTIFICATION
        )
        return types.mapNotNull { RingtoneManager.getDefaultUri(it) }.distinct()
    }

    private fun tryStartMediaPlayer(): Boolean {
        val ctx = resolveAudioContext()
        val attrs = alarmAudioAttributes()
        for (uri in candidateAlarmUris()) {
            val mp = MediaPlayer()
            try {
                mp.setAudioAttributes(attrs)
                mp.setDataSource(ctx, uri)
                mp.isLooping = true
                mp.prepare()
                mp.start()
                if (mp.isPlaying) {
                    mediaPlayer = mp
                    return true
                }
                mp.release()
            } catch (err: Exception) {
                Log.w(TAG, "MediaPlayer failed for uri=$uri", err)
                runCleanupStep("MediaPlayer release") { mp.release() }
            }
        }
        return false
    }

    private fun tryStartSystemRingtone(): Boolean {
        val ctx = resolveAudioContext()
        val attrs = alarmAudioAttributes()
        for (uri in candidateAlarmUris()) {
            try {
                val rt = RingtoneManager.getRingtone(ctx, uri) ?: continue
                rt.audioAttributes = attrs
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    rt.isLooping = true
                }
                rt.play()
                ringtone = rt
                return true
            } catch (err: Exception) {
                Log.w(TAG, "Ringtone failed for uri=$uri", err)
            }
        }
        return false
    }

    private fun startFallbackAlarmTone() {
        try {
            fallbackTone = ToneGenerator(AudioManager.STREAM_ALARM, 100)
            fallbackActive = true
            fallbackLoop.run()
        } catch (err: Exception) {
            Log.w(TAG, "Fallback ToneGenerator unavailable", err)
        }
    }

    private fun startAlarmVibration() {
        try {
            val vibrator = resolveVibrator() ?: return
            val pattern = longArrayOf(0L, 600L, 400L)
            val effect = VibrationEffect.createWaveform(pattern, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val vAttrs = VibrationAttributes.Builder()
                    .setUsage(VibrationAttributes.USAGE_ALARM)
                    .build()
                vibrator.vibrate(effect, vAttrs)
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(effect, alarmAudioAttributes())
            }
        } catch (err: Exception) {
            Log.w(TAG, "Vibration unavailable", err)
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
