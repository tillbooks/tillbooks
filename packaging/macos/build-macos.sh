#!/usr/bin/env bash
#
# Assemble the macOS "TILL" launcher app (M00, US-M00.2).
#
# WHAT THIS PRODUCES: an UNSIGNED `TILL.app` whose double-click execs `till up`, so a GmbH owner who
# never opens a terminal gets the Studio in their browser. It assembles the bundle; it deliberately
# STOPS at code-signing and notarisation, which need an Apple Developer ID from a paid account in
# Nomadik's legal name and therefore belong to the release pipeline, not to an unattended build.
# See ./README.md for the full lane and the owner-gated handover.
#
# The signing step is STUBBED, not faked: with no identity this prints the exact commands the release
# pipeline must run and exits 0 with the unsigned bundle. This is the "runs unsigned in CI, signature
# stubbed" posture the spec (§8) asks for. It NEVER embeds a credential and never claims Gatekeeper
# will accept an unsigned build (it will not; that is the whole point of the signed lane).
#
# Usage:
#   packaging/macos/build-macos.sh [--bundle-app] [--out DIR]
#     --bundle-app  copy bin/ + dist/ + package.json + node_modules into the app (self-contained);
#                   omit for a thin launcher that calls a `till` already on PATH (dev builds).
#     --out DIR     where to write TILL.app (default: packaging/macos/build)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/packaging/macos/build"
BUNDLE_APP=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle-app) BUNDLE_APP=1 ;;
    --out) OUT_DIR="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
APP="${OUT_DIR}/TILL.app"
CONTENTS="${APP}/Contents"

echo "macos: assembling ${APP} (version ${VERSION})"
rm -rf "${APP}"
mkdir -p "${CONTENTS}/MacOS" "${CONTENTS}/Resources"

cat > "${CONTENTS}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>TILL</string>
  <key>CFBundleDisplayName</key><string>TILL</string>
  <key>CFBundleIdentifier</key><string>ch.tillbooks.studio</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>TILL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# The launcher: exec `till up`. A bundled app runs its own node against the packaged bin; a thin
# build calls whatever `till` is on PATH. `till up` itself prints the URL and opens the browser.
if [ "${BUNDLE_APP}" -eq 1 ]; then
  echo "macos: bundling bin/ + dist/ + node_modules into Resources/app"
  mkdir -p "${CONTENTS}/Resources/app"
  cp -R "${REPO_ROOT}/bin" "${REPO_ROOT}/dist" "${REPO_ROOT}/package.json" "${CONTENTS}/Resources/app/"
  # node_modules carries the native better-sqlite3 build; a real installer also embeds a Node runtime
  # so the user installs no Node. Embedding Node is a release-pipeline concern (a pinned, notarised
  # runtime), flagged in ./README.md, not done here.
  [ -d "${REPO_ROOT}/node_modules" ] && cp -R "${REPO_ROOT}/node_modules" "${CONTENTS}/Resources/app/"
  cat > "${CONTENTS}/MacOS/TILL" <<'LAUNCH'
#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
exec node "${HERE}/bin/till.mjs" up
LAUNCH
else
  cat > "${CONTENTS}/MacOS/TILL" <<'LAUNCH'
#!/bin/bash
set -euo pipefail
exec till up
LAUNCH
fi
chmod +x "${CONTENTS}/MacOS/TILL"

echo "macos: unsigned bundle assembled at ${APP}"

# --- The signing / notarisation lane: STUBBED, owner-gated ---------------------------------------
if [ -n "${TILL_SIGNING_IDENTITY:-}" ]; then
  echo "macos: TILL_SIGNING_IDENTITY is set, but this script does NOT run codesign/notarytool." >&2
  echo "       Signing and notarisation are a release-pipeline step with the owner's Apple Developer" >&2
  echo "       identity. See packaging/macos/README.md for the exact commands. Refusing to sign here." >&2
fi
cat >&2 <<'STUB'
macos: SIGNING STEP STUBBED (owner-gated).
  Gatekeeper will REFUSE this unsigned bundle; that is intended, not a bug. The signed lane needs an
  Apple Developer ID application certificate in Nomadik GmbH's legal name and runs in the release
  pipeline, never in an unattended build. The remainder is recorded against the release pipeline in
  packaging/macos/README.md. This build produced the unsigned artifact and stopped there.
STUB
echo "macos: done (unsigned)."
