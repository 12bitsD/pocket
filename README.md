# Pocket

Agent-native clock, calendar, and notes for Android. **These are three separate apps, not one super-app.** Each has its own UI, package, version, and release; the monorepo only shares the backend contracts, authorization model, Prompt jobs, and visual language.

Pocket targets general Android. ColorOS receives deep optimizations for background execution, autostart, battery policies, and permission guidance without restricting the other apps or devices to OPPO.

## Status

- **Clock**: interactive HTML prototype with alarms, world clock, stopwatch, timer, and Agent Cron Job creation.
- **Agent Core**: tested Prompt + local-time schedule → five-field Cron contract.
- **Calendar / Notes**: scoped and registered in the monorepo; implementation has not started.

The aligned design is organized into the [Pocket architecture](docs/architecture.md), the shared [Cloud architecture](docs/cloud/architecture.md), and the [Clock domain architecture](docs/cloud/clock.md). Current implementation remains the interactive Clock prototype; Android and live Cloud integration have not started.

## Layout

```text
apps/
  clock/          Alarm, world clock, stopwatch, timer
  calendar/       Calendar product scope and future app
  notes/          Notes product scope and future app
packages/
  agent-core/     Shared Prompt and Cron Job contract
  design-system/  Shared monochrome editorial terminal styles
docs/             Architecture and release conventions
scripts/          Syntax checks and release packaging
```

## Run

Open `apps/clock/index.html` directly in a browser. No install or build is required for the prototype.

```sh
npm install
npm test
npm run check
```

## Release model

Apps have independent versions, tags, and GitHub Releases:

```text
clock-v0.1.0
calendar-v0.1.0
notes-v0.1.0
```

See [release conventions](docs/releases.md), the [Pocket architecture](docs/architecture.md), the shared [Cloud architecture](docs/cloud/architecture.md), and the [Clock domain architecture](docs/cloud/clock.md).
