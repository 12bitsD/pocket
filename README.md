# Pocket

Self-hosted, Agent-native clock, calendar, and notes. **On Android, these are three separate apps, not one super-app**—each has its own UI entry, package, version, and release. **On desktop, a unified Web workspace** lets you manage alarms, Agent plans, calendar events, notes, and device/Agent bindings in one place while keeping device ringing strictly on the Android Clock app.

Pocket targets general Android (packaged with shared Web UI + thin Kotlin native plugins for exact alarms, lock-screen ringing, boot recovery, and native SQLite storage), with deep ColorOS guidance for background execution and autostart.

## Status

- **Clock**: interactive HTML prototype with alarms (optional one-off date, per-alarm local lock, skip-next, target device, and execution state), Agent plans (one-off and five-field Cron schedules bound to configured Agents), and world clock.
- **Agent Core**: tested Prompt + one-off / local-time Cron plan contract.
- **Pocket Cloud & Web Workspace**: architecture and Python 3.12 + FastAPI + PostgreSQL stack finalized; implementation starts with Slice 1.
- **Calendar / Notes**: scoped and registered in the monorepo; implementation has not started.

The aligned design is organized into the [Pocket architecture](docs/architecture.md), the shared [Cloud architecture](docs/cloud/architecture.md), the [Clock domain architecture](docs/cloud/clock.md), the evolving [Pocket design standard](docs/design-standard.md), and the finalized [backend & client technology stack](docs/research/backend-tech-stack.md).

## Layout

```text
apps/
  clock/          Alarms, Agent plans, and world clock
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

See [release conventions](docs/releases.md), the [Pocket architecture](docs/architecture.md), the shared [Cloud architecture](docs/cloud/architecture.md), and the [Clock domain architecture](docs/cloud/clock.md). The recommended backend stack is documented in the [backend technology research](docs/research/backend-tech-stack.md).
