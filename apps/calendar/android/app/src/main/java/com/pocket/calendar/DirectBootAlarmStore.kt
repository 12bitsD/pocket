package com.pocket.calendar

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

class DirectBootAlarmStore private constructor(deviceCtx: Context) {
    private val dbHelper = Helper(deviceCtx)

    @Synchronized
    fun listAllAlarms(): List<AlarmRecord> = queryAlarms(null, null)

    @Synchronized
    fun listEnabledAlarms(): List<AlarmRecord> =
        queryAlarms("enabled = 1", null)

    @Synchronized
    fun getAlarm(alarmKey: String): AlarmRecord? =
        queryAlarms("alarm_key = ?", arrayOf(alarmKey)).firstOrNull()

    @Synchronized
    fun upsertAlarm(record: AlarmRecord) {
        dbHelper.writableDatabase.insertWithOnConflict(
            TABLE_ALARMS,
            null,
            toContentValues(record),
            SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    @Synchronized
    fun deleteAlarmsByKeys(keys: Collection<String>) {
        if (keys.isEmpty()) {
            return
        }
        inTransaction { db ->
            for (key in keys) {
                db.delete(TABLE_ALARMS, "alarm_key = ?", arrayOf(key))
            }
        }
    }

    @Synchronized
    fun updateScheduleState(alarmKey: String, patch: ScheduleStatePatch) {
        val enabledVal = if (patch.activeState == AlarmActiveState.ENABLED) {
            1
        } else {
            0
        }
        val values = ContentValues().apply {
            put("enabled", enabledVal)
            putNullableLong("snooze_until_ms", patch.snoozeUntilMs)
            putNullableLong("next_trigger_ms", patch.nextTriggerMs)
            when (patch.skipPolicy) {
                SkipNextPolicy.CLEAR -> {
                    put("skip_next", 0)
                    putNull("skip_target_ms")
                }
                SkipNextPolicy.SET -> {
                    put("skip_next", 1)
                    putNullableLong("skip_target_ms", patch.skipTargetMs)
                }
                SkipNextPolicy.KEEP -> Unit
            }
        }
        dbHelper.writableDatabase.update(
            TABLE_ALARMS,
            values,
            "alarm_key = ?",
            arrayOf(alarmKey)
        )
    }

    @Synchronized
    fun appendRingingEvent(
        entityType: String,
        entityId: String,
        eventKind: String,
        occurredAtMs: Long
    ) {
        val values = ContentValues().apply {
            put("entity_type", entityType)
            put("entity_id", entityId)
            put("event_kind", eventKind)
            put("occurred_at_ms", occurredAtMs)
        }
        dbHelper.writableDatabase.insert(TABLE_RINGING_EVENTS, null, values)
    }

    @Synchronized
    fun drainRingingEvents(): List<RingingEventRecord> {
        return inTransaction { db ->
            val drained = mutableListOf<RingingEventRecord>()
            db.query(
                TABLE_RINGING_EVENTS,
                null,
                null,
                null,
                null,
                null,
                "id ASC"
            ).use { cur ->
                while (cur.moveToNext()) {
                    drained.add(readRingingEvent(cur))
                }
            }
            db.delete(TABLE_RINGING_EVENTS, null, null)
            drained
        }
    }

    private fun <T> inTransaction(block: (SQLiteDatabase) -> T): T {
        val db = dbHelper.writableDatabase
        db.beginTransaction()
        try {
            val result = block(db)
            db.setTransactionSuccessful()
            return result
        } finally {
            db.endTransaction()
        }
    }

    private fun queryAlarms(
        selection: String?,
        args: Array<String>?
    ): List<AlarmRecord> {
        val out = mutableListOf<AlarmRecord>()
        dbHelper.readableDatabase.query(
            TABLE_ALARMS,
            null,
            selection,
            args,
            null,
            null,
            "alarm_key ASC"
        ).use { cur ->
            while (cur.moveToNext()) {
                out.add(readAlarmRow(cur))
            }
        }
        return out
    }

    private fun readRingingEvent(cur: Cursor): RingingEventRecord {
        return RingingEventRecord(
            id = cur.getLong(cur.getColumnIndexOrThrow("id")),
            entityType = cur.reqStr("entity_type"),
            entityId = cur.reqStr("entity_id"),
            eventKind = cur.reqStr("event_kind"),
            occurredAtMs = cur.getLong(
                cur.getColumnIndexOrThrow("occurred_at_ms")
            )
        )
    }

    private fun toContentValues(rec: AlarmRecord): ContentValues {
        return ContentValues().apply {
            put("alarm_key", rec.alarmKey)
            put("entity_type", rec.entityType)
            put("entity_id", rec.entityId)
            put("title", rec.title)
            put("subtitle", rec.subtitle)
            putNullableStr("schedule_kind", rec.scheduleKind)
            putNullableStr("time_hhmm", rec.timeHhmm)
            putNullableStr("once_date", rec.onceDate)
            putNullableInt("weekly_dow", rec.weeklyDow)
            putNullableStr("repeat_rule", rec.repeatRule)
            putNullableStr("event_date", rec.eventDate)
            putNullableStr("start_hhmm", rec.startHhmm)
            put("reminder_offset_minutes", rec.reminderOffsetMinutes)
            put("timezone", rec.timezone)
            put("skip_next", if (rec.skipNext) 1 else 0)
            putNullableLong("skip_target_ms", rec.skipTargetMs)
            put("enabled", if (rec.enabled) 1 else 0)
            putNullableLong("snooze_until_ms", rec.snoozeUntilMs)
            putNullableLong("next_trigger_ms", rec.nextTriggerMs)
        }
    }

    private fun readAlarmRow(cur: Cursor): AlarmRecord {
        val offsetCol = cur.getColumnIndexOrThrow("reminder_offset_minutes")
        val skipCol = cur.getColumnIndexOrThrow("skip_next")
        val enCol = cur.getColumnIndexOrThrow("enabled")
        return AlarmRecord(
            alarmKey = cur.reqStr("alarm_key"),
            entityType = cur.reqStr("entity_type"),
            entityId = cur.reqStr("entity_id"),
            title = cur.reqStr("title"),
            subtitle = cur.reqStr("subtitle"),
            scheduleKind = cur.optStr("schedule_kind"),
            timeHhmm = cur.optStr("time_hhmm"),
            onceDate = cur.optStr("once_date"),
            weeklyDow = cur.optInt("weekly_dow"),
            repeatRule = cur.optStr("repeat_rule"),
            eventDate = cur.optStr("event_date"),
            startHhmm = cur.optStr("start_hhmm"),
            reminderOffsetMinutes = cur.getInt(offsetCol),
            timezone = cur.reqStr("timezone"),
            skipNext = cur.getInt(skipCol) != 0,
            skipTargetMs = cur.optLong("skip_target_ms"),
            enabled = cur.getInt(enCol) != 0,
            snoozeUntilMs = cur.optLong("snooze_until_ms"),
            nextTriggerMs = cur.optLong("next_trigger_ms")
        )
    }

    private fun ContentValues.putNullableStr(key: String, value: String?) {
        if (value != null) {
            put(key, value)
        } else {
            putNull(key)
        }
    }

    private fun ContentValues.putNullableInt(key: String, value: Int?) {
        if (value != null) {
            put(key, value)
        } else {
            putNull(key)
        }
    }

    private fun ContentValues.putNullableLong(key: String, value: Long?) {
        if (value != null) {
            put(key, value)
        } else {
            putNull(key)
        }
    }

    private fun Cursor.reqStr(col: String): String =
        getString(getColumnIndexOrThrow(col))

    private fun <T> Cursor.optCol(col: String, read: (Int) -> T): T? {
        val idx = getColumnIndexOrThrow(col)
        return if (isNull(idx)) {
            null
        } else {
            read(idx)
        }
    }

    private fun Cursor.optStr(col: String): String? = optCol(col, ::getString)

    private fun Cursor.optInt(col: String): Int? = optCol(col, ::getInt)

    private fun Cursor.optLong(col: String): Long? = optCol(col, ::getLong)

    private class Helper(context: Context) :
        SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(SQL_CREATE_ALARMS)
            db.execSQL(SQL_CREATE_EVENTS)
        }

        override fun onUpgrade(
            db: SQLiteDatabase,
            oldVersion: Int,
            newVersion: Int
        ) {
            if (oldVersion < 2) {
                val sql = "ALTER TABLE $TABLE_ALARMS " +
                    "ADD COLUMN skip_target_ms INTEGER"
                db.execSQL(sql)
            }
            onCreate(db)
        }
    }

    companion object {
        const val DB_NAME = "pocket_direct_boot.db"
        private const val DB_VERSION = 2
        private const val TABLE_ALARMS = "scheduled_alarms"
        private const val TABLE_RINGING_EVENTS = "ringing_events"

        private val SQL_CREATE_ALARMS = """
            CREATE TABLE IF NOT EXISTS $TABLE_ALARMS (
                alarm_key TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                title TEXT NOT NULL,
                subtitle TEXT NOT NULL,
                schedule_kind TEXT,
                time_hhmm TEXT,
                once_date TEXT,
                weekly_dow INTEGER,
                repeat_rule TEXT,
                event_date TEXT,
                start_hhmm TEXT,
                reminder_offset_minutes INTEGER NOT NULL DEFAULT 0,
                timezone TEXT NOT NULL,
                skip_next INTEGER NOT NULL DEFAULT 0,
                skip_target_ms INTEGER,
                enabled INTEGER NOT NULL DEFAULT 1,
                snooze_until_ms INTEGER,
                next_trigger_ms INTEGER
            )
        """.trimIndent()

        private val SQL_CREATE_EVENTS = """
            CREATE TABLE IF NOT EXISTS $TABLE_RINGING_EVENTS (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                event_kind TEXT NOT NULL,
                occurred_at_ms INTEGER NOT NULL
            )
        """.trimIndent()

        @Volatile
        private var instance: DirectBootAlarmStore? = null

        fun getInstance(context: Context): DirectBootAlarmStore {
            return instance ?: synchronized(this) {
                instance ?: buildStore(context).also { instance = it }
            }
        }

        private fun buildStore(context: Context): DirectBootAlarmStore {
            val appCtx = context.applicationContext ?: context
            val devCtx = appCtx.createDeviceProtectedStorageContext() ?: appCtx
            return DirectBootAlarmStore(devCtx)
        }
    }
}
