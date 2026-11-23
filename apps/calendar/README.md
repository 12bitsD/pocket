# Pocket Calendar

Unified schedule, alarm, and Agent task app (`apps/calendar/index.html`), following the [Pocket design standard](../../docs/design-standard.md) and [domain specification](../../docs/cloud/calendar.md).

## Three-tab interface

- **`[d] 今日日程`**: Today's events only (next/current hero card + remaining timeline + interval overlap check).
- **`[m] 月历`**: Seven-column month matrix with strong/normal reminder dots and per-day inspection.
- **`[t] Todo`**: One shared `@` routing flow for plain todos, `@me` native device alarms (with date picker, skip-next, and `LOCKED` write protection), and `@agent` scheduled Prompt deliveries.
