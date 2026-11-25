#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEFAULT_VER="$(node -p "require('./apps/calendar/package.json').version")"
VERSION="${1:-$DEFAULT_VER}"
OUT_APK="dist/pocket-calendar-${VERSION}.apk"

mkdir -p dist

TEMP_KEYSTORE=""
cleanup_keystore() {
  if [[ -n "$TEMP_KEYSTORE" && -f "$TEMP_KEYSTORE" ]]; then
    rm -f "$TEMP_KEYSTORE"
  fi
}
trap cleanup_keystore EXIT

if [[ -z "${POCKET_KEYSTORE_PATH:-}" && -n "${POCKET_KEYSTORE_BASE64:-}" ]]; then
  TEMP_KEYSTORE="$(mktemp "${TMPDIR:-/tmp}/pocket-ks.XXXXXX.p12")"
  printf '%s' "$POCKET_KEYSTORE_BASE64" | base64 --decode > "$TEMP_KEYSTORE"
  export POCKET_KEYSTORE_PATH="$TEMP_KEYSTORE"
fi

npm --workspace @pocket/calendar run build >/dev/null
(
  cd apps/calendar
  npx cap sync android >/dev/null
)

has_host_android_sdk() {
  if ! java -version >/dev/null 2>&1; then
    return 1
  fi
  local sdk_dir="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  [[ -n "$sdk_dir" && -d "$sdk_dir" ]]
}

if has_host_android_sdk; then
  (
    cd apps/calendar/android
    chmod +x gradlew
    ./gradlew --no-daemon \
      -PpocketVersionName="$VERSION" \
      testReleaseUnitTest assembleRelease
  )
  cp "apps/calendar/android/app/build/outputs/apk/release/app-release.apk" \
    "$OUT_APK"
else
  BUILDER_IMAGE="pocket-android-builder:35"
  if ! docker image inspect "$BUILDER_IMAGE" >/dev/null 2>&1; then
    docker build -t "$BUILDER_IMAGE" - <<'EOF'
FROM eclipse-temurin:21-jdk
ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH="${PATH}:${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${ANDROID_SDK_ROOT}/platform-tools"

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl unzip rsync ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p "${ANDROID_SDK_ROOT}/cmdline-tools" \
    && curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" \
      -o /tmp/cmdtools.zip \
    && unzip -q /tmp/cmdtools.zip -d "${ANDROID_SDK_ROOT}/cmdline-tools" \
    && mv "${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools" \
      "${ANDROID_SDK_ROOT}/cmdline-tools/latest" \
    && rm -f /tmp/cmdtools.zip \
    && yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" >/dev/null
EOF
  fi

  HOST_UID="$(id -u)"
  HOST_GID="$(id -g)"
  HOST_CACHE_DIR="${HOME}/.cache/pocket-android"
  mkdir -p "${HOST_CACHE_DIR}/gradle" "${HOST_CACHE_DIR}/tmp" "${HOST_CACHE_DIR}/sdk"
  if [[ ! -d "${HOST_CACHE_DIR}/sdk/platforms/android-35" ]]; then
    docker run --rm \
      -v "${HOST_CACHE_DIR}/sdk:/host-sdk" \
      "$BUILDER_IMAGE" \
      rsync -a /opt/android-sdk/ /host-sdk/
  fi

  EXTRA_DOCKER_ARGS=()
  if [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]]; then
    AMD64_LIB="${HOST_CACHE_DIR}/amd64-libs/usr/x86_64-linux-gnu/lib"
    if [[ ! -f "${AMD64_LIB}/ld-linux-x86-64.so.2" ]]; then
      mkdir -p "${HOST_CACHE_DIR}/amd64-libs"
      docker run --rm -v "${HOST_CACHE_DIR}:/hc" "$BUILDER_IMAGE" bash -euo pipefail -c '
        mkdir -p /hc/apt/lists /hc/apt/archives/partial
        apt-get -o Dir::State::Lists=/hc/apt/lists \
          -o Dir::Cache::Archives=/hc/apt/archives update -qq
        cd /hc/apt/archives
        apt-get -o Dir::State::Lists=/hc/apt/lists \
          -o Dir::Cache::Archives=/hc/apt/archives \
          download libc6-amd64-cross libgcc-s1-amd64-cross >/dev/null
        for deb in /hc/apt/archives/*.deb; do
          dpkg-deb --fsys-tarfile "$deb" \
            | tar -xf - --no-same-owner --no-same-permissions -C /hc/amd64-libs || true
        done
      '
    fi
    EXTRA_DOCKER_ARGS+=(
      -v "${AMD64_LIB}:/lib/x86_64-linux-gnu:ro"
      -v "${AMD64_LIB}/ld-linux-x86-64.so.2:/lib64/ld-linux-x86-64.so.2:ro"
    )
  fi

  if [[ -n "${POCKET_KEYSTORE_PATH:-}" && -f "$POCKET_KEYSTORE_PATH" ]]; then
    EXTRA_DOCKER_ARGS+=(
      -v "${POCKET_KEYSTORE_PATH}:/run/pocket-release.keystore:ro"
      -e "POCKET_KEYSTORE_PATH=/run/pocket-release.keystore"
    )
  fi
  if [[ -n "${POCKET_KEYSTORE_PASSWORD:-}" ]]; then
    EXTRA_DOCKER_ARGS+=(-e "POCKET_KEYSTORE_PASSWORD=${POCKET_KEYSTORE_PASSWORD}")
  fi
  if [[ -n "${POCKET_KEY_ALIAS:-}" ]]; then
    EXTRA_DOCKER_ARGS+=(-e "POCKET_KEY_ALIAS=${POCKET_KEY_ALIAS}")
  fi
  if [[ -n "${POCKET_KEY_PASSWORD:-}" ]]; then
    EXTRA_DOCKER_ARGS+=(-e "POCKET_KEY_PASSWORD=${POCKET_KEY_PASSWORD}")
  fi

  docker run --rm \
    ${EXTRA_DOCKER_ARGS[@]+"${EXTRA_DOCKER_ARGS[@]}"} \
    -v "$ROOT_DIR:/workspace:ro" \
    -v "$ROOT_DIR/dist:/out" \
    -v "${HOST_CACHE_DIR}/sdk:/opt/android-sdk" \
    -v "${HOST_CACHE_DIR}/gradle:/root/.gradle" \
    -v "${HOST_CACHE_DIR}/tmp:/tmp" \
    -e GRADLE_USER_HOME="/root/.gradle" \
    -e GRADLE_OPTS="-Xmx1536m -XX:MaxMetaspaceSize=512m -Djava.io.tmpdir=/tmp" \
    -e VERSION="$VERSION" \
    -e HOST_UID="$HOST_UID" \
    -e HOST_GID="$HOST_GID" \
    "$BUILDER_IMAGE" \
    bash -euo pipefail -c '
      WORK_ROOT="/tmp/pocket-android-build/src"
      BUILD_OUT="/tmp/pocket-android-build/out"
      mkdir -p "$WORK_ROOT/apps/calendar" "$WORK_ROOT/node_modules/@capacitor" "$BUILD_OUT"
      cp /workspace/package.json "$WORK_ROOT/package.json"
      cp /workspace/apps/calendar/package.json "$WORK_ROOT/apps/calendar/package.json"
      cp /workspace/apps/calendar/capacitor.config.json "$WORK_ROOT/apps/calendar/capacitor.config.json"
      rsync -a --delete /workspace/apps/calendar/android/ "$WORK_ROOT/apps/calendar/android/"
      rsync -a --delete /workspace/node_modules/@capacitor/android/ "$WORK_ROOT/node_modules/@capacitor/android/"
      rsync -a --delete /workspace/node_modules/@capacitor/core/ "$WORK_ROOT/node_modules/@capacitor/core/"
      cd "$WORK_ROOT/apps/calendar/android"
      chmod +x gradlew
      ./gradlew --no-daemon \
        -PpocketBuildRoot="$BUILD_OUT" \
        -PpocketVersionName="$VERSION" \
        testReleaseUnitTest assembleRelease
      cp "$BUILD_OUT/app/outputs/apk/release/app-release.apk" "/out/pocket-calendar-${VERSION}.apk"
      chown "${HOST_UID}:${HOST_GID}" "/out/pocket-calendar-${VERSION}.apk" 2>/dev/null || true
    '
fi

test -s "$OUT_APK"
echo "$OUT_APK"
