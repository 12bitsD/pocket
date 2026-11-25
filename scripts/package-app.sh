#!/usr/bin/env bash
set -euo pipefail

app="$1"
version="$2"
test -f "apps/$app/index.html"

rm -rf "dist/$app" "dist/$app-$version.zip"
mkdir -p "dist"

if [[ "$app" == "calendar" ]]; then
  npm --workspace "@pocket/$app" run build >/dev/null
  test -f "apps/$app/dist/index.html"
  (
    cd "apps/$app/dist"
    zip -qr "$OLDPWD/dist/$app-$version.zip" .
  )
else
  mkdir -p "dist/$app/apps" "dist/$app/packages"
  cp -R "apps/$app" "dist/$app/apps/"
  cp -R packages/agent-core "dist/$app/packages/"
  cp -R packages/design-system "dist/$app/packages/"
  (
    cd "dist/$app"
    zip -qr "../$app-$version.zip" \
      "apps/$app" packages/agent-core packages/design-system
  )
  rm -rf "dist/$app"
fi

echo "dist/$app-$version.zip"
