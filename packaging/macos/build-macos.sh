#!/usr/bin/env bash
#
# Assemble the macOS "TILL" launcher app (M00, US-M00.2).
#
# WHAT THIS PRODUCES: an UNSIGNED native `TILL.app` whose double-click runs `till up` and shows the
# Studio in its own window, already signed in (D166), so a GmbH owner never opens a terminal, and whose
# Quit (Cmd+Q, Dock > Quit, closing the window) stops the server again. It assembles the bundle and
# deliberately STOPS before code-signing: the embedded Node runtime, signing, notarisation and the dmg
# are ./build-release.sh (`npm run build:mac:release`), which calls this script first. This is the
# "runs unsigned in CI, signature stubbed" posture the spec (§8) asks for. It NEVER embeds a
# credential and never claims Gatekeeper will accept an unsigned build (it will not).
#
# Usage:
#   packaging/macos/build-macos.sh [--bundle-app] [--out DIR] [--archs "arm64 x86_64"]
#     --bundle-app  copy bin/ + dist/ + package.json + node_modules into the app (self-contained);
#                   omit for a thin launcher that calls a `till` already on PATH (dev builds).
#     --out DIR     where to write TILL.app (default: packaging/macos/build)
#     --archs LIST  the launcher's architectures (default "arm64 x86_64", universal); the release
#                   build passes "arm64" (build-release.sh, Apple silicon only)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/packaging/macos/build"
BUNDLE_APP=0
ARCHS="arm64 x86_64"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle-app) BUNDLE_APP=1 ;;
    --out) OUT_DIR="$2"; shift ;;
    --archs) ARCHS="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
APP="${OUT_DIR}/TILL.app"
CONTENTS="${APP}/Contents"

echo "macos: assembling ${APP} (version ${VERSION})"
rm -rf "${APP}"
mkdir -p "${OUT_DIR}" "${CONTENTS}/MacOS" "${CONTENTS}/Resources"

# D166: a NATIVE app (AppKit + WKWebView, ./TillApp.swift), not the AppleScript applet it replaces. The
# applet opened the bare URL in the default browser, which has no Studio key, so the person was sent to
# a terminal for a link. The app opens its own window with a one-time ticket derived from the owner-only
# key file, never the key itself, and still stops `till up` on Quit. Compiled for each of --archs and
# joined by lipo (by default Apple silicon and Intel, one universal binary).
sed -e "s|__VERSION__|${VERSION}|g" "${REPO_ROOT}/packaging/macos/Info.plist" > "${CONTENTS}/Info.plist"
SWIFT_TMP="$(mktemp -d)"
for arch in ${ARCHS}; do
  xcrun swiftc -O -target "${arch}-apple-macos12.0" -framework Cocoa -framework WebKit \
    -o "${SWIFT_TMP}/TILL-${arch}" "${REPO_ROOT}/packaging/macos/TillApp.swift"
done
SLICES=()
for arch in ${ARCHS}; do SLICES+=("${SWIFT_TMP}/TILL-${arch}"); done
lipo -create "${SLICES[@]}" -output "${CONTENTS}/MacOS/TILL"
chmod +x "${CONTENTS}/MacOS/TILL"
rm -rf "${SWIFT_TMP}"

# The dock/Finder icon (option C, the paper drawer). CFBundleIconFile in Info.plist names it. The .icns
# is checked in and regenerated from the one mark geometry by `python3 brand/render-icons.py` followed
# by `iconutil -c icns packaging/macos/TILL.iconset -o packaging/macos/TILL.icns`, so the build does
# not need Python or Pillow. If it is ever missing the bundle still assembles, iconless.
if [ -f "${REPO_ROOT}/packaging/macos/TILL.icns" ]; then
  cp "${REPO_ROOT}/packaging/macos/TILL.icns" "${CONTENTS}/Resources/TILL.icns"
  echo "macos: bundled icon packaging/macos/TILL.icns -> Contents/Resources/TILL.icns"
else
  echo "macos: WARNING no packaging/macos/TILL.icns found; TILL.app will use the generic icon" >&2
fi

# The payload. The app finds `Contents/Resources/app/bin/till.mjs` itself and runs it with the login
# shell's `node`; a thin build (no app dir) runs whatever `till` is on the login PATH, and an
# `~/.till/app.json` can name a launcher script instead (see TillApp.swift). It logs to
# ~/Library/Logs/TILL.log and opens its window once the port answers.
if [ "${BUNDLE_APP}" -eq 1 ]; then
  echo "macos: bundling bin/ + dist/ + node_modules into Resources/app"
  mkdir -p "${CONTENTS}/Resources/app"
  cp -R "${REPO_ROOT}/bin" "${REPO_ROOT}/dist" "${REPO_ROOT}/package.json" "${CONTENTS}/Resources/app/"
  # node_modules carries the native better-sqlite3 build; the login shell's node runs it. The
  # self-contained build with its own pinned Node is build-release.sh.
  [ -d "${REPO_ROOT}/node_modules" ] && cp -R "${REPO_ROOT}/node_modules" "${CONTENTS}/Resources/app/"
fi

echo "macos: unsigned bundle assembled at ${APP}"

# --- Signing and notarisation live in build-release.sh, not here ---------------------------------
# This script is the unattended assembly step; build-release.sh (npm run build:mac:release) calls it
# and then embeds the Node runtime, signs, notarises and builds the dmg on the owner's Mac.
cat >&2 <<'STUB'
macos: UNSIGNED bundle (this script never signs).
  Gatekeeper will REFUSE this bundle on another Mac; that is intended, not a bug. The distributable,
  self-contained, signed and notarised TILL-macos.dmg is `npm run build:mac:release`
  (packaging/macos/build-release.sh), run on the owner's Mac with the Developer ID in the keychain.
STUB
echo "macos: done (unsigned)."
