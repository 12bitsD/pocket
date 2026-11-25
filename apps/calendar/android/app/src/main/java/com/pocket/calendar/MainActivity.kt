package com.pocket.calendar

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.OnBackPressedCallback
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
        onBackPressedDispatcher.addCallback(this, backCallback)
    }

    override fun onStart() {
        super.onStart()
        bridge?.webView?.resumeTimers()
    }

    override fun onStop() {
        if (!isChangingConfigurations) {
            bridge?.webView?.pauseTimers()
        }
        super.onStop()
    }

    override fun onDestroy() {
        uiHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun dispatchSystemBack() {
        backCallback.isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        backCallback.isEnabled = true
    }

    companion object {
        private const val BACK_EVAL_TIMEOUT_MS = 250L
        private const val JS_HANDLE_BACK =
            "(typeof window.__pocketHandleBack==='function'&&" +
                "window.__pocketHandleBack())?'1':'0'"
    }
}
