package com.pocket.calendar

import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

object AlarmTimeCalculator {
    const val DEFAULT_SNOOZE_MINUTES: Int = 10

    fun computeSnoozeTriggerMillis(
        nowMillis: Long,
        minutes: Int = DEFAULT_SNOOZE_MINUTES
    ): Long {
        val safeMinutes = minutes.coerceAtLeast(1).toLong()
        return nowMillis + safeMinutes * 60_000L
    }

    fun isOneShot(record: AlarmRecord): Boolean {
        return if (record.entityType == "event") {
            (record.repeatRule ?: "none") == "none"
        } else {
            (record.scheduleKind ?: "once") == "once"
        }
    }

    fun computeNextTriggerMillis(record: AlarmRecord, nowMillis: Long): Long? {
        return computeSchedule(record, nowMillis).triggerAtMs
    }

    fun computeSchedule(record: AlarmRecord, nowMillis: Long): ComputedTrigger {
        if (!record.enabled) {
            return ComputedTrigger(null)
        }
        val snooze = record.snoozeUntilMs
        if (snooze != null && snooze > nowMillis) {
            return ComputedTrigger(snooze, record.skipTargetMs, false)
        }
        val zone = resolveZone(record.timezone)
        return when (record.entityType) {
            "todo" -> computeTodoSchedule(record, nowMillis, zone)
            "event" -> ComputedTrigger(
                computeEventNextMillis(record, nowMillis, zone)
            )
            else -> ComputedTrigger(null)
        }
    }

    fun resolveZone(raw: String?): ZoneId {
        if (raw.isNullOrBlank()) {
            return ZoneId.systemDefault()
        }
        return try {
            ZoneId.of(raw.trim())
        } catch (_: Exception) {
            ZoneId.systemDefault()
        }
    }

    fun parseHhmm(raw: String?): LocalTime? {
        val parts = raw?.trim()?.split(":") ?: return null
        if (parts.size != 2) {
            return null
        }
        val hour = parts[0].toIntOrNull() ?: return null
        val minute = parts[1].toIntOrNull() ?: return null
        if (hour !in 0..23 || minute !in 0..59) {
            return null
        }
        return LocalTime.of(hour, minute)
    }

    fun parseIsoDate(raw: String?): LocalDate? {
        if (raw.isNullOrBlank()) {
            return null
        }
        return try {
            LocalDate.parse(raw.trim())
        } catch (_: Exception) {
            null
        }
    }

    private fun computeTodoSchedule(
        record: AlarmRecord,
        nowMillis: Long,
        zone: ZoneId
    ): ComputedTrigger {
        val fireTime = parseHhmm(record.timeHhmm)
            ?: return ComputedTrigger(null)
        val kind = record.scheduleKind ?: return ComputedTrigger(null)
        if (kind == "once") {
            val target = parseIsoDate(record.onceDate)
                ?: return ComputedTrigger(null)
            val epoch = ZonedDateTime.of(target, fireTime, zone)
                .toInstant()
                .toEpochMilli()
            return ComputedTrigger(if (epoch > nowMillis) epoch else null)
        }
        val upcoming = collectUpcomingTodoSlots(
            record,
            fireTime,
            nowMillis,
            zone
        )
        return resolveRecurringTodoTrigger(record, nowMillis, upcoming)
    }

    private fun collectUpcomingTodoSlots(
        record: AlarmRecord,
        fireTime: LocalTime,
        nowMillis: Long,
        zone: ZoneId
    ): List<Long> {
        val startDate = Instant.ofEpochMilli(nowMillis)
            .atZone(zone)
            .toLocalDate()
        val slots = mutableListOf<Long>()
        val kind = record.scheduleKind ?: return slots
        for (offset in 0L..21L) {
            val candidateDate = startDate.plusDays(offset)
            if (!matchesTodoSchedule(kind, candidateDate, record.weeklyDow)) {
                continue
            }
            val triggerMs = ZonedDateTime.of(candidateDate, fireTime, zone)
                .toInstant()
                .toEpochMilli()
            if (triggerMs > nowMillis) {
                slots.add(triggerMs)
                if (slots.size >= 2) {
                    break
                }
            }
        }
        return slots
    }

    private fun resolveRecurringTodoTrigger(
        record: AlarmRecord,
        nowMillis: Long,
        slots: List<Long>
    ): ComputedTrigger {
        val first = slots.getOrNull(0) ?: return ComputedTrigger(null)
        if (!record.skipNext) {
            return ComputedTrigger(first)
        }
        val pinnedSkip = record.skipTargetMs
        if (pinnedSkip != null && nowMillis >= pinnedSkip) {
            return ComputedTrigger(first, null, skipConsumed = true)
        }
        val targetSkip = pinnedSkip ?: first
        val nextAfterSkip = slots.firstOrNull { it > targetSkip }
        return ComputedTrigger(nextAfterSkip, targetSkip, skipConsumed = false)
    }

    private fun matchesTodoSchedule(
        kind: String,
        date: LocalDate,
        weeklyDow: Int?
    ): Boolean {
        return when (kind) {
            "daily" -> true
            "weekdays" -> date.dayOfWeek.value in 1..5
            "weekly" -> {
                val targetDow = ((weeklyDow ?: 5) % 7 + 7) % 7
                (date.dayOfWeek.value % 7) == targetDow
            }
            else -> false
        }
    }

    private fun computeEventNextMillis(
        record: AlarmRecord,
        nowMillis: Long,
        zone: ZoneId
    ): Long? {
        val anchorDate = parseIsoDate(record.eventDate) ?: return null
        val startTime = parseHhmm(record.startHhmm) ?: return null
        val rule = record.repeatRule ?: "none"
        val offsetMins = record.reminderOffsetMinutes.coerceIn(0, 1440).toLong()
        val nowDate = Instant.ofEpochMilli(nowMillis)
            .atZone(zone)
            .toLocalDate()
        val scanBase = maxOf(anchorDate, nowDate.minusDays(1))
        for (offset in 0L..16L) {
            val candidate = scanBase.plusDays(offset)
            if (!matchesEventRule(rule, anchorDate, candidate)) {
                continue
            }
            val triggerMs = ZonedDateTime.of(candidate, startTime, zone)
                .minusMinutes(offsetMins)
                .toInstant()
                .toEpochMilli()
            if (triggerMs > nowMillis) {
                return triggerMs
            }
            if (rule == "none") {
                return null
            }
        }
        return null
    }

    private fun matchesEventRule(
        rule: String,
        anchorDate: LocalDate,
        candidateDate: LocalDate
    ): Boolean {
        if (candidateDate.isBefore(anchorDate)) {
            return false
        }
        return when (rule) {
            "none" -> candidateDate == anchorDate
            "daily" -> true
            "weekdays" -> candidateDate.dayOfWeek.value in 1..5
            "weekly" -> candidateDate.dayOfWeek == anchorDate.dayOfWeek
            else -> false
        }
    }
}
