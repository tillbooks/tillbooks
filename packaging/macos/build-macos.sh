#!/usr/bin/env bash
#
# Assemble the macOS "TILL" launcher app (M00, US-M00.2).
#
# WHAT THIS PRODUCES: an UNSIGNED `TILL.app` whose double-click runs `till up`, so a GmbH owner who
# never opens a terminal gets the Studio in their browser, and whose Dock Quit / Cmd+Q stops it again. It assembles the bundle; it deliberately
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
mkdir -p "${OUT_DIR}"
# The launcher is a STAY-OPEN AppleScript applet (`-s`), compiled from ./launcher.applescript. A bash
# script as CFBundleExecutable has no Apple event loop, so Dock > Quit never reached it and the only
# way out was Force Quit, which orphaned `till up` on its port. The applet starts the server, keeps
# its PID, and stops it on quit. The source explains the `do shell script` pipe trap it avoids.
osacompile -s -o "${APP}" "${REPO_ROOT}/packaging/macos/launcher.applescript"
# osacompile ships Script Editor's own icon in Assets.car (CFBundleIconName wins over
# CFBundleIconFile), so drop it and let the TILL.icns below be the icon.
rm -f "${CONTENTS}/Resources/Assets.car" "${CONTENTS}/Resources/applet.icns"

# The dock/Finder icon (option C, the paper drawer). CFBundleIconFile below names it. The .icns is
# checked in and regenerated from the one mark geometry by `python3 brand/render-icons.py` followed
# by `iconutil -c icns packaging/macos/TILL.iconset -o packaging/macos/TILL.icns`, so the build does
# not need Python or Pillow. If it is ever missing the bundle still assembles, iconless, as before.
if [ -f "${REPO_ROOT}/packaging/macos/TILL.icns" ]; then
  cp "${REPO_ROOT}/packaging/macos/TILL.icns" "${CONTENTS}/Resources/TILL.icns"
  echo "macos: bundled icon packaging/macos/TILL.icns -> Contents/Resources/TILL.icns"
else
  echo "macos: WARNING no packaging/macos/TILL.icns found; TILL.app will use the generic icon" >&2
fi

# Brand the applet's Info.plist. It keeps CFBundleExecutable=applet and OSAAppletStayOpen=true from
# osacompile. No LSUIElement: the Dock icon IS the quit control.
PLIST="${CONTENTS}/Info.plist"
plutil -replace CFBundleName -string "TILL" "${PLIST}"
plutil -replace CFBundleDisplayName -string "TILL" "${PLIST}"
plutil -replace CFBundleIdentifier -string "ch.tillbooks.studio" "${PLIST}"
plutil -replace CFBundleVersion -string "${VERSION}" "${PLIST}"
plutil -replace CFBundleShortVersionString -string "${VERSION}" "${PLIST}"
plutil -replace CFBundleIconFile -string "TILL" "${PLIST}"
plutil -remove CFBundleIconName "${PLIST}" 2>/dev/null || true
plutil -replace LSMinimumSystemVersion -string "12.0" "${PLIST}"
plutil -replace OSAAppletShowStartupScreen -bool false "${PLIST}"
plutil -replace OSAAppletStayOpen -bool true "${PLIST}"

# The payload. The applet finds `Contents/Resources/app/bin/till.mjs` itself and runs it with the
# login shell's `node`; a thin build (no app dir) runs whatever `till` is on the login PATH. Either way
# it logs to ~/Library/Logs/TILL.log and opens the browser once the port answers.
if [ "${BUNDLE_APP}" -eq 1 ]; then
  echo "macos: bundling bin/ + dist/ + node_modules into Resources/app"
  mkdir -p "${CONTENTS}/Resources/app"
  cp -R "${REPO_ROOT}/bin" "${REPO_ROOT}/dist" "${REPO_ROOT}/package.json" "${CONTENTS}/Resources/app/"
  # node_modules carries the native better-sqlite3 build; a real installer also embeds a Node runtime
  # so the user installs no Node. Embedding Node is a release-pipeline concern (a pinned, notarised
  # runtime), flagged in ./README.md, not done here.
  [ -d "${REPO_ROOT}/node_modules" ] && cp -R "${REPO_ROOT}/node_modules" "${CONTENTS}/Resources/app/"
fi

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
