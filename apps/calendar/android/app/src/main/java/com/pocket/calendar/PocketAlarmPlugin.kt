package com.pocket.calendar

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

@CapacitorPlugin(name = "PocketAlarm")
class PocketAlarmPlugin : Plugin() {

    @PluginMethod
    fun syncAlarms(call: PluginCall) {
        val rawAlarms = call.getArray("alarms") ?: JSArray()
        val store = DirectBootAlarmStore.getInstance(context)
        val existingByKey = store.listAllAlarms().associateBy { it.alarmKey }
        val nowMs = System.currentTimeMillis()
        val incomingKeys = mutableSetOf<String>()
        val results = JSArray()

        for (i in 0 until rawAlarms.length()) {
            val item = rawAlarms.optJSONObject(i) ?: continue
            val parsed = parseIncomingRecord(item, existingByKey, nowMs)
                ?: continue
            incomingKeys.add(parsed.alarmKey)
            val (status, storedTrigger) = ExactAlarmScheduler.reconcileAlarm(
                context,
                store,
                parsed,
                nowMs
            )
            results.put(buildSyncResultJson(parsed, status, storedTrigger))
        }

        val obsoleteKeys = existingByKey.keys - incomingKeys
        for (obsoleteKey in obsoleteKeys) {
            ExactAlarmScheduler.cancelAlarm(context, obsoleteKey)
        }
        store.deleteAlarmsByKeys(obsoleteKeys)
        call.resolve(JSObject().apply { put("results", results) })
    }

    @PluginMethod
    fun drainRingingEvents(call: PluginCall) {
        val store = DirectBootAlarmStore.getInstance(context)
        val events = JSArray()
        for (record in store.drainRingingEvents()) {
            events.put(
                JSObject().apply {
                    put("id", record.id)
                    put("entityType", record.entityType)
                    put("entityId", record.entityId)
                    put("eventKind", record.eventKind)
                    put("occurredAtMs", record.occurredAtMs)
                }
            )
        }
        call.resolve(JSObject().apply { put("events", events) })
    }

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        val perms = PermissionInspector.inspect(context)
        call.resolve(
            JSObject().apply {
                put("exactAlarm", perms.exactAlarm)
                put("notifications", perms.notifications)
                put("fullScreenIntent", perms.fullScreenIntent)
                put("batteryOptimization", perms.batteryOptimization)
            }
        )
    }

    @PluginMethod
    fun openPermissionSettings(call: PluginCall) {
        val target = call.getString("target") ?: ""
        val opened = PermissionInspector.openSettings(context, target)
        call.resolve(
            JSObject().apply {
                put("opened", opened)
                put("target", target)
            }
        )
    }

    private fun buildSyncResultJson(
        parsed: AlarmRecord,
        status: ArmedStatus,
        storedTrigger: Long?
    ): JSObject {
        return JSObject().apply {
            put("alarmKey", parsed.alarmKey)
            put("entityType", parsed.entityType)
            put("entityId", parsed.entityId)
            put("status", status.name)
            if (storedTrigger != null) {
                put("nextTriggerMs", storedTrigger)
            } else {
                put("nextTriggerMs", JSObject.NULL)
            }
        }
    }

    private fun parseIncomingRecord(
        obj: JSONObject,
        existingByKey: Map<String, AlarmRecord>,
        nowMs: Long
    ): AlarmRecord? {
        val entityType = obj.optString("entityType", "").trim()
        val entityId = obj.optString("entityId", "").trim()
        if (entityType.isEmpty() || entityId.isEmpty()) {
            return null
        }
        val fallbackKey = "$entityType:$entityId"
        val alarmKey = obj.optString("alarmKey", fallbackKey).trim()
        val enabled = obj.optBoolean("enabled", true)
        val skipNext = obj.optBoolean("skipNext", false)
        val existing = existingByKey[alarmKey]
        val snoozeMs = existing?.snoozeUntilMs?.takeIf { enabled && it > nowMs }
        val skipTarget = existing?.skipTargetMs?.takeIf { enabled && skipNext }
        return AlarmRecord(
            alarmKey = alarmKey,
            entityType = entityType,
            entityId = entityId,
            title = obj.optString("title", "Pocket 闹钟"),
            subtitle = obj.optString("subtitle", ""),
            scheduleKind = optCleanString(obj, "scheduleKind"),
            timeHhmm = optCleanString(obj, "timeHhmm"),
            onceDate = optCleanString(obj, "onceDate"),
            weeklyDow = optIntOrNull(obj, "weeklyDow", 5),
            repeatRule = optCleanString(obj, "repeatRule"),
            eventDate = optCleanString(obj, "eventDate"),
            startHhmm = optCleanString(obj, "startHhmm"),
            reminderOffsetMinutes = obj.optInt("reminderOffsetMinutes", 0),
            timezone = optCleanString(obj, "timezone") ?: "Asia/Shanghai",
            skipNext = skipNext,
            skipTargetMs = skipTarget,
            enabled = enabled,
            snoozeUntilMs = snoozeMs,
            nextTriggerMs = null
        )
    }

    private fun optIntOrNull(
        obj: JSONObject,
        key: String,
        fallback: Int
    ): Int? {
        if (obj.isNull(key)) {
            return null
        }
        return obj.optInt(key, fallback)
    }

    private fun optCleanString(obj: JSONObject, key: String): String? {
        if (obj.isNull(key)) {
            return null
        }
        val value = obj.optString(key, "").trim()
        return value.ifEmpty { null }
    }
}
