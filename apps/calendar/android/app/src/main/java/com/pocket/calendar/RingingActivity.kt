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
        root.addView(ttyHeader, linearParams(WRAP, WRAP, 16))
        root.addView(stampBadge, linearParams(WRAP, WRAP, 18))
        root.addView(clockView, linearParams(MATCH, WRAP, 18))
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
        root.addView(ruleTop, linearParams(MATCH, dp(1), 18))
        root.addView(titleView, linearParams(MATCH, WRAP, 6))
        root.addView(subtitleView, linearParams(MATCH, WRAP, 36))
    }

    private data class ButtonStyle(
        val textColorRes: Int,
        val textSizeSp: Float,
        val face: Typeface,
        val bg: GradientDrawable
    )

    private fun appendActionButtons(root: LinearLayout) {
        val dismissStyle = ButtonStyle(
            textColorRes = R.color.paperCarbon,
            textSizeSp = 16f,
            face = Typeface.create("sans-serif-medium", Typeface.NORMAL),
            bg = roundedRectDrawable(R.color.paperInk, strokeColor = null)
        )
        val snoozeStyle = ButtonStyle(
            textColorRes = R.color.paperInk,
            textSizeSp = 14f,
            face = Typeface.MONOSPACE,
            bg = roundedRectDrawable(R.color.cardDark, R.color.paperRule)
        )
        val dismissBtn = buildActionButton(
            "关闭本次",
            dismissStyle,
            AlarmRingingService.ACTION_DISMISS_RINGING
        )
        val snoozeBtn = buildActionButton(
            "10 分钟后再响",
            snoozeStyle,
            AlarmRingingService.ACTION_SNOOZE_RINGING
        ).apply { fontFeatureSettings = "tnum" }
        root.addView(dismissBtn, linearParams(MATCH, dp(50), 12))
        root.addView(snoozeBtn, linearParams(MATCH, dp(50), 0))
    }

    private fun roundedRectDrawable(
        fillRes: Int,
        strokeColor: Int?
    ): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(3).toFloat()
            setColor(getColor(fillRes))
            if (strokeColor != null) {
                setStroke(dp(1), getColor(strokeColor))
            }
        }
    }

    private fun buildActionButton(
        label: String,
        style: ButtonStyle,
        action: String
    ): Button {
        return Button(this).apply {
            text = label
            isAllCaps = false
            stateListAnimator = null
            typeface = style.face
            setTextSize(TypedValue.COMPLEX_UNIT_SP, style.textSizeSp)
            setTextColor(getColor(style.textColorRes))
            background = style.bg
            setOnClickListener { dispatchServiceAction(action) }
        }
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

    private fun linearParams(
        width: Int,
        height: Int,
        bottomDp: Int
    ): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(width, height).apply {
            bottomMargin = dp(bottomDp)
        }
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
        private const val MATCH = LinearLayout.LayoutParams.MATCH_PARENT
        private const val WRAP = LinearLayout.LayoutParams.WRAP_CONTENT
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
