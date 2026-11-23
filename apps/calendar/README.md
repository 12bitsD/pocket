# Pocket Calendar

Interactive HTML prototype (`apps/calendar/index.html`) following the [Pocket design standard](../../docs/design-standard.md) and [Calendar domain architecture](../../docs/cloud/calendar.md).

## Three-tab structure

- **`[d] 今日日程`**: Focused strictly on **today's** events (next/current event hero card + today's remaining timeline + interval overlap detection).
- **`[m] 月历`**: Seven-column tabular month matrix with reminder indicators and per-day event inspection.
- **`[t] Todo`**: Unified `@` assignee routing—configure plain todos, `@me` phone alarms (synced to Clock), and `@agent` scheduled Prompt jobs through **one shared interaction** (including inline `@handle HH:MM` parsing) instead of two separate forms.
