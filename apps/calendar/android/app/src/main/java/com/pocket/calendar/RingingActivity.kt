package com.pocket.calendar

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.time.LocalTime
import java.time.format.DateTimeFormatter

class RingingActivity : Activity() {
    private val clockHandler = Handler(Looper.getMainLooper())
    private var alarmKey: String = ""
    private var active: Boolean = false
    private lateinit var clockView: TextView
    private lateinit var titleView: TextView
    private lateinit var subtitleView: TextView

    private val clockTicker = object : Runnable {
        override fun run() {
            val now = LocalTime.now()
            clockView.text = now.format(HH_MM_FMT)
            clockHandler.postDelayed(this, millisUntilNextMinute(now))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (shouldFinishForIntent(intent)) {
            finish()
            return
        }
        active = true
        configureLockscreenWindow()
        setContentView(buildPaperTeletypeRoot())
        applyIntentPayload(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (shouldFinishForIntent(intent)) {
            finish()
            return
        }
        setIntent(intent)
        applyIntentPayload(intent)
    }

    override fun onStart() {
        super.onStart()
        if (active) {
            clockHandler.removeCallbacks(clockTicker)
            clockTicker.run()
        }
    }

    override fun onStop() {
        clockHandler.removeCallbacks(clockTicker)
        super.onStop()
    }

    override fun onDestroy() {
        active = false
        clockHandler.removeCallbacks(clockTicker)
        super.onDestroy()
    }

    private fun shouldFinishForIntent(source: Intent?): Boolean {
        if (source?.action != ACTION_FINISH_RINGING) {
            return false
        }
        val target = source.getStringExtra(ExactAlarmScheduler.EXTRA_ALARM_KEY)
        return target.isNullOrEmpty() ||
            alarmKey.isEmpty() ||
            target == alarmKey
    }

    private fun configureLockscreenWindow() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val carbon = getColor(R.color.paperCarbon)
        window.statusBarColor = carbon
        window.navigationBarColor = carbon
    }

    private fun applyIntentPayload(source: Intent?) {
        alarmKey = source?.getStringExtra(
            ExactAlarmScheduler.EXTRA_ALARM_KEY
        ) ?: ""
        val rawTitle = source?.getStringExtra(AlarmRingingService.EXTRA_TITLE)
        val rawSub = source?.getStringExtra(AlarmRingingService.EXTRA_SUBTITLE)
        titleView.text = rawTitle?.takeIf { it.isNotBlank() }
            ?: "Pocket 准点闹钟"
        subtitleView.text = rawSub?.takeIf { it.isNotBlank() }
            ?: "SYSTEM ALARMCLOCK · DIRECT BOOT"
    }

    private fun buildPaperTeletypeRoot(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(getColor(R.color.paperCarbon))
            setPadding(dp(26), dp(36), dp(26), dp(34))
            gravity = Gravity.CENTER_VERTICAL
        }
        appendHeaderAndClock(root)
        appendRuleAndMetadata(root)
        appendActionButtons(root)
        return root
    }

    private fun appendHeaderAndClock(root: LinearLayout) {
        val ttyHeader = TextView(this).apply {
            text = "$ pocket/clock --ring"
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(getColor(R.color.paperMuted))
            fontFeatureSettings = "tnum"
        }
        val stampBadge = TextView(this).apply {
            text = "ALARM RINGING"
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f)
            setTextColor(getColor(R.color.vermilionTextDark))
            fontFeatureSettings = "tnum"
            background = buildVermilionStampBackground()
            setPadding(dp(10), dp(4), dp(10), dp(4))
        }
        clockView = TextView(this).apply {
            text = LocalTime.now().format(HH_MM_FMT)
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 68f)
            setTextColor(getColor(R.color.paperInk))
            fontFeatureSettings = "tnum"
            letterSpacing = -0.04f
        }
        root.addView(ttyHeader, lpWrap(16))
        root.addView(stampBadge, lpWrap(18))
        root.addView(clockView, lpMatch(18))
    }

    private fun appendRuleAndMetadata(root: LinearLayout) {
        val ruleTop = View(this).apply {
            setBackgroundColor(getColor(R.color.paperRule))
        }
        titleView = TextView(this).apply {
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            setTextColor(getColor(R.color.paperInk))
            setLineSpacing(0f, 1.35f)
        }
        subtitleView = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(getColor(R.color.paperMuted))
            fontFeatureSettings = "tnum"
        }
        val ruleLp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(1)
        ).apply { bottomMargin = dp(18) }
        root.addView(ruleTop, ruleLp)
        root.addView(titleView, lpMatch(6))
        root.addView(subtitleView, lpMatch(36))
    }

    private fun appendActionButtons(root: LinearLayout) {
        val dismissBtn = Button(this).apply {
            text = "关闭本次"
            isAllCaps = false
            stateListAnimator = null
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setTextColor(getColor(R.color.paperCarbon))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(3).toFloat()
                setColor(getColor(R.color.paperInk))
            }
            setOnClickListener {
                dispatchServiceAction(
                    AlarmRingingService.ACTION_DISMISS_RINGING
                )
            }
        }
        val snoozeBtn = Button(this).apply {
            text = "10 分钟后再响"
            isAllCaps = false
            stateListAnimator = null
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(getColor(R.color.paperInk))
            fontFeatureSettings = "tnum"
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(3).toFloat()
                setColor(getColor(R.color.cardDark))
                setStroke(dp(1), getColor(R.color.paperRule))
            }
            setOnClickListener {
                dispatchServiceAction(AlarmRingingService.ACTION_SNOOZE_RINGING)
            }
        }
        root.addView(dismissBtn, lpButton(12))
        root.addView(snoozeBtn, lpButton(0))
    }

    private fun buildVermilionStampBackground(): LayerDrawable {
        val wash = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(2).toFloat()
            setColor(COLOR_VERMILION_WASH)
        }
        val leftBar = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(getColor(R.color.vermilionDark))
        }
        return LayerDrawable(arrayOf(wash, leftBar)).apply {
            setLayerWidth(1, dp(2))
            setLayerGravity(1, Gravity.START or Gravity.FILL_VERTICAL)
        }
    }

    private fun dispatchServiceAction(action: String) {
        val svcIntent = AlarmRingingService.buildServiceIntent(
            this,
            action,
            alarmKey,
            null
        )
        startService(svcIntent)
        finish()
    }

    private fun lpWrap(bottomDp: Int): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(bottomDp) }
    }

    private fun lpMatch(bottomDp: Int): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(bottomDp) }
    }

    private fun lpButton(bottomDp: Int): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(50)
        ).apply { bottomMargin = dp(bottomDp) }
    }

    private fun dp(value: Int): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value.toFloat(),
            resources.displayMetrics
        ).toInt()
    }

    companion object {
        private const val TAG = "PocketRingingUi"
        private const val ACTION_FINISH_RINGING =
            "com.pocket.calendar.ACTION_FINISH_RINGING"
        private val HH_MM_FMT: DateTimeFormatter =
            DateTimeFormatter.ofPattern("HH:mm")
        private const val COLOR_VERMILION_WASH = 0x2AE05A3F

        internal fun millisUntilNextMinute(now: LocalTime): Long {
            val elapsedMs = now.second * 1_000L + now.nano / 1_000_000L
            return (60_000L - elapsedMs).coerceIn(250L, 60_000L)
        }

        fun requestFinish(context: Context, expectedKey: String?) {
            try {
                val closeIntent = Intent(
                    context,
                    RingingActivity::class.java
                ).apply {
                    action = ACTION_FINISH_RINGING
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP
                    if (expectedKey != null) {
                        putExtra(
                            ExactAlarmScheduler.EXTRA_ALARM_KEY,
                            expectedKey
                        )
                    }
                }
                context.startActivity(closeIntent)
            } catch (err: Exception) {
                Log.d(TAG, "RingingActivity not active on finish request", err)
            }
        }
    }
}
