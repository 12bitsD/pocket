# Independent Client Releases

**Pocket Calendar** and **Pocket Notes** are two separate applications with independent versions, tags, and GitHub Releases. Client packages (standalone Web builds and signed Android APKs) are published directly to [GitHub Releases](https://github.com/12bitsD/pocket/releases).

## Release tags

```text
calendar-v<version>
notes-v<version>
```

Example:

```sh
git tag calendar-v0.2.0
git push origin calendar-v0.2.0
```

## Published artifacts

- **`calendar-v<version>`**:
  - `dist/calendar-<version>.zip` — standalone static Web bundle (`apps/calendar/dist`).
  - `dist/pocket-calendar-<version>.apk` — v1+v2 signed Android Release APK (`com.pocket.calendar` with Capacitor + Kotlin Direct Boot alarm plugin).
- **`notes-v<version>`**:
  - `dist/notes-<version>.zip` — standalone Pocket Notes Web package.

## Local packaging

```sh
# Standalone Web zip
bash scripts/package-app.sh calendar 0.2.0

# Signed Android Release APK (uses host JDK 21 + Android SDK or cached Docker builder)
bash scripts/build-android-apk.sh 0.2.0
```

Pushing an app tag runs `npm test` and `npm run check`, packages that app's artifacts into `dist/`, and publishes them to the corresponding GitHub Release without triggering a release for the other app.
