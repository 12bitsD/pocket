package com.pocket.calendar

enum class ArmedStatus {
    EXECUTED,
    FAILED,
    EXPIRED
}

enum class AlarmActiveState {
    ENABLED,
    DISABLED
}

enum class SkipNextPolicy {
    KEEP,
    CLEAR,
    SET
}

data class ScheduleStatePatch(
    val activeState: AlarmActiveState,
    val snoozeUntilMs: Long?,
    val nextTriggerMs: Long?,
    val skipPolicy: SkipNextPolicy = SkipNextPolicy.KEEP,
    val skipTargetMs: Long? = null
)

data class ComputedTrigger(
    val triggerAtMs: Long?,
    val skipTargetMs: Long? = null,
    val skipConsumed: Boolean = false
)

data class AlarmRecord(
    val alarmKey: String,
    val entityType: String,
    val entityId: String,
    val title: String,
    val subtitle: String,
    val scheduleKind: String? = null,
    val timeHhmm: String? = null,
    val onceDate: String? = null,
    val weeklyDow: Int? = null,
    val repeatRule: String? = null,
    val eventDate: String? = null,
    val startHhmm: String? = null,
    val reminderOffsetMinutes: Int = 0,
    val timezone: String = "Asia/Shanghai",
    val skipNext: Boolean = false,
    val skipTargetMs: Long? = null,
    val enabled: Boolean = true,
    val snoozeUntilMs: Long? = null,
    val nextTriggerMs: Long? = null
)

data class RingingEventRecord(
    val id: Long,
    val entityType: String,
    val entityId: String,
    val eventKind: String,
    val occurredAtMs: Long
)
