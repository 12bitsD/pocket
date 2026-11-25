package com.pocket.calendar

import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlarmTimeCalculatorTest {
    private val shanghai: ZoneId = ZoneId.of("Asia/Shanghai")

    private fun msAt(isoLocal: String): Long {
        return LocalDateTime.parse(isoLocal)
            .atZone(shanghai)
            .toInstant()
            .toEpochMilli()
    }

    @Test
    fun onceTodoReturnsFutureAndNullWhenPast() {
        val nowMs = msAt("2026-11-24T08:00")
        val futureTodo = AlarmRecord(
            alarmKey = "todo:t1",
            entityType = "todo",
            entityId = "t1",
            title = "Morning Train",
            subtitle = "once",
            scheduleKind = "once",
            timeHhmm = "09:30",
            onceDate = "2026-11-24",
            timezone = "Asia/Shanghai"
        )
        assertEquals(
            msAt("2026-11-24T09:30"),
            AlarmTimeCalculator.computeNextTriggerMillis(futureTodo, nowMs)
        )

        val pastTodo = futureTodo.copy(timeHhmm = "07:30")
        assertNull(
            AlarmTimeCalculator.computeNextTriggerMillis(pastTodo, nowMs)
        )
    }

    @Test
    fun dailyRolloverAndNonSlidingSkipTarget() {
        val morningBefore = msAt("2026-11-24T06:00")
        val dailySkip = AlarmRecord(
            alarmKey = "todo:daily1",
            entityType = "todo",
            entityId = "daily1",
            title = "Standup",
            subtitle = "daily",
            scheduleKind = "daily",
            timeHhmm = "07:00",
            skipNext = true,
            timezone = "Asia/Shanghai"
        )
        val firstCalc = AlarmTimeCalculator.computeSchedule(
            dailySkip,
            morningBefore
        )
        assertEquals(msAt("2026-11-24T07:00"), firstCalc.skipTargetMs)
        assertEquals(msAt("2026-11-25T07:00"), firstCalc.triggerAtMs)
        assertFalse(firstCalc.skipConsumed)

        // Reboot/resync at 08:00 after skipped 07:00 slot consumes skip cleanly
        val persisted = dailySkip.copy(skipTargetMs = firstCalc.skipTargetMs)
        val afterSkippedSlot = AlarmTimeCalculator.computeSchedule(
            persisted,
            msAt("2026-11-24T08:00")
        )
        assertTrue(afterSkippedSlot.skipConsumed)
        assertEquals(msAt("2026-11-25T07:00"), afterSkippedSlot.triggerAtMs)
    }

    @Test
    fun weekdaysJumpsFromFridayToMonday() {
        val fridayMorningAfter = msAt("2026-11-27T09:00")
        val weekdaysTodo = AlarmRecord(
            alarmKey = "todo:wkd",
            entityType = "todo",
            entityId = "wkd",
            title = "Weekday Focus",
            subtitle = "weekdays",
            scheduleKind = "weekdays",
            timeHhmm = "08:30",
            timezone = "Asia/Shanghai"
        )
        assertEquals(
            msAt("2026-11-30T08:30"),
            AlarmTimeCalculator.computeNextTriggerMillis(
                weekdaysTodo,
                fridayMorningAfter
            )
        )
    }

    @Test
    fun weeklySupportsSundayZeroAndFridayFiveWithSkipNext() {
        val tuesdayNow = msAt("2026-11-24T10:00")
        val sundayTodo = AlarmRecord(
            alarmKey = "todo:sun",
            entityType = "todo",
            entityId = "sun",
            title = "Sunday Review",
            subtitle = "weekly",
            scheduleKind = "weekly",
            timeHhmm = "20:00",
            weeklyDow = 0,
            timezone = "Asia/Shanghai"
        )
        assertEquals(
            msAt("2026-11-29T20:00"),
            AlarmTimeCalculator.computeNextTriggerMillis(sundayTodo, tuesdayNow)
        )

        val fridayTodo = sundayTodo.copy(
            alarmKey = "todo:fri",
            weeklyDow = 5,
            timeHhmm = "18:00"
        )
        assertEquals(
            msAt("2026-11-27T18:00"),
            AlarmTimeCalculator.computeNextTriggerMillis(fridayTodo, tuesdayNow)
        )
        assertEquals(
            msAt("2026-12-04T18:00"),
            AlarmTimeCalculator.computeNextTriggerMillis(
                fridayTodo.copy(skipNext = true),
                tuesdayNow
            )
        )
    }

    @Test
    fun eventAlarmSubtractsReminderOffsetAndHonorsSnooze() {
        val nowMs = msAt("2026-11-24T08:00")
        val eventAlarm = AlarmRecord(
            alarmKey = "event:ev1",
            entityType = "event",
            entityId = "ev1",
            title = "Architecture Sync",
            subtitle = "2026-11-24 10:00",
            repeatRule = "none",
            eventDate = "2026-11-24",
            startHhmm = "10:00",
            reminderOffsetMinutes = 15,
            timezone = "Asia/Shanghai"
        )
        assertEquals(
            msAt("2026-11-24T09:45"),
            AlarmTimeCalculator.computeNextTriggerMillis(eventAlarm, nowMs)
        )

        val snoozeTarget = AlarmTimeCalculator.computeSnoozeTriggerMillis(
            nowMs,
            10
        )
        assertEquals(nowMs + 600_000L, snoozeTarget)
        assertEquals(
            snoozeTarget,
            AlarmTimeCalculator.computeNextTriggerMillis(
                eventAlarm.copy(snoozeUntilMs = snoozeTarget),
                nowMs
            )
        )
    }

    @Test
    fun ringingClockSchedulesExactNextMinuteBoundary() {
        assertEquals(
            60_000L,
            RingingActivity.millisUntilNextMinute(LocalTime.of(7, 30, 0, 0))
        )
        assertEquals(
            30_500L,
            RingingActivity.millisUntilNextMinute(
                LocalTime.of(7, 30, 29, 500_000_000)
            )
        )
        assertEquals(
            250L,
            RingingActivity.millisUntilNextMinute(
                LocalTime.of(7, 30, 59, 900_000_000)
            )
        )
    }
}
