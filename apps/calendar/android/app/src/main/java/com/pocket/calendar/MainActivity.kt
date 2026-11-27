package com.pocket.calendar

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.OnBackPressedCallback
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    private val uiHandler = Handler(Looper.getMainLooper())

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            val webView = bridge?.webView
            if (webView == null) {
                dispatchSystemBack()
                return
            }
            var settled = false
            val fallback = Runnable {
                if (!settled) {
                    settled = true
                    dispatchSystemBack()
                }
            }
            uiHandler.postDelayed(fallback, BACK_EVAL_TIMEOUT_MS)
            webView.evaluateJavascript(JS_HANDLE_BACK) { rawResult ->
                if (!settled) {
                    settled = true
                    uiHandler.removeCallbacks(fallback)
                    if (rawResult != "\"1\"") {
                        dispatchSystemBack()
                    }
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(PocketAlarmPlugin::class.java)
        super.onCreate(savedInstanceState)
        applySystemBars(dark = false)
        onBackPressedDispatcher.addCallback(this, backCallback)
        requestNotificationPermissionIfNeeded()
    }

    fun applySystemBars(dark: Boolean) {
        val barColor = getColor(
            if (dark) R.color.paperCarbon else R.color.paperLight
        )
        @Suppress("DEPRECATION")
        window.statusBarColor = barColor
        @Suppress("DEPRECATION")
        window.navigationBarColor = barColor
        val ctrl = WindowCompat.getInsetsController(window, window.decorView)
        ctrl.isAppearanceLightStatusBars = !dark
        ctrl.isAppearanceLightNavigationBars = !dark
    }

    override fun onDestroy() {
        uiHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return
        }
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                REQ_NOTIF_PERMISSION
            )
        }
    }

    private fun dispatchSystemBack() {
        backCallback.isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        backCallback.isEnabled = true
    }

    companion object {
        private const val REQ_NOTIF_PERMISSION = 4210
        private const val BACK_EVAL_TIMEOUT_MS = 250L
        private const val JS_HANDLE_BACK =
            "(typeof window.__pocketHandleBack==='function'&&" +
                "window.__pocketHandleBack())?'1':'0'"
    }
}
