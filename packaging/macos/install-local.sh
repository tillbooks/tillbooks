#!/usr/bin/env bash
#
# Install or update TILL.app on THIS Mac from this checkout, in one command (D166).
#
# It builds the native app (build-macos.sh), optionally points it at a launcher script that owns the
# install's environment (writes ~/.till/app.json, owner-only), quits a running TILL.app the normal way
# (which stops its server), keeps the previous app as a backup, installs the new one in /Applications
# and opens it. The person then just clicks the TILL icon from now on.
#
# Usage:
#   packaging/macos/install-local.sh                      # default install: port 8788, ~/.till
#   packaging/macos/install-local.sh --launcher ~/.till/run-studio.sh --port 8790 \
#       --support-dir ~/.till/books --log ~/.till/books/studio.log
#
# It never touches a book, a key file or the Keychain. A locally built app carries no quarantine flag,
# so Gatekeeper opens it; a DISTRIBUTED build still needs the signed lane in ./README.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Test seams: install somewhere else, and do not open the app at the end.
APPS="${TILL_APPLICATIONS_DIR:-/Applications}"
LAUNCHER="" PORT="" SUPPORT_DIR="" LOG_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --launcher) LAUNCHER="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --support-dir) SUPPORT_DIR="$2"; shift ;;
    --log) LOG_FILE="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

expand() { case "$1" in "~"*) printf '%s' "${HOME}${1#\~}" ;; *) printf '%s' "$1" ;; esac; }

if [ -n "${LAUNCHER}" ]; then
  LAUNCHER="$(expand "${LAUNCHER}")"
  [ -x "${LAUNCHER}" ] || { echo "install: the launcher ${LAUNCHER} is missing or not executable" >&2; exit 1; }
  [ -n "${PORT}" ] && [ -n "${SUPPORT_DIR}" ] || { echo "install: --launcher needs --port and --support-dir (the ones the launcher's till up uses)" >&2; exit 1; }
fi

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "${BUILD_DIR}"' EXIT
echo "install: building TILL.app"
"${REPO_ROOT}/packaging/macos/build-macos.sh" --out "${BUILD_DIR}" >/dev/null 2>&1 || {
  echo "install: the build failed; run packaging/macos/build-macos.sh to see why" >&2; exit 1; }

if [ -n "${LAUNCHER}" ]; then
  mkdir -p "${HOME}/.till"
  CONFIG="${HOME}/.till/app.json"
  [ -f "${CONFIG}" ] && cp -p "${CONFIG}" "${CONFIG}.bak"
  node -e '
    const [launcher, port, supportDir, logFile] = process.argv.slice(1);
    const config = { command: launcher, port: Number(port), supportDir, ...(logFile ? { logFile } : {}) };
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
  ' "${LAUNCHER}" "${PORT}" "$(expand "${SUPPORT_DIR}")" "$(expand "${LOG_FILE}")" > "${CONFIG}.tmp"
  chmod 600 "${CONFIG}.tmp" && mv "${CONFIG}.tmp" "${CONFIG}"
  echo "install: ~/.till/app.json points TILL.app at ${LAUNCHER} (port ${PORT})"
fi

# Quit the running TILL.app the normal way: it stops its till up before it exits.
if pgrep -f "${APPS}/TILL.app/Contents/MacOS/" >/dev/null 2>&1; then
  echo "install: quitting the running TILL"
  [ "${APPS}" = "/Applications" ] && { osascript -e 'tell application id "ch.tillbooks.studio" to quit' >/dev/null 2>&1 || true; }
  for _ in $(seq 1 40); do pgrep -f "${APPS}/TILL.app/Contents/MacOS/" >/dev/null 2>&1 || break; sleep 0.25; done
fi

if [ -d "${APPS}/TILL.app" ]; then
  BACKUPS="${HOME}/.till/app-backups"
  mkdir -p "${BACKUPS}"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  mv "${APPS}/TILL.app" "${BACKUPS}/TILL-${STAMP}.app"
  echo "install: the previous app is kept at ~/.till/app-backups/TILL-${STAMP}.app"
fi
ditto "${BUILD_DIR}/TILL.app" "${APPS}/TILL.app"
if [ "${TILL_INSTALL_NO_OPEN:-}" = "1" ]; then
  echo "install: TILL.app installed in ${APPS}"
else
  echo "install: TILL.app installed; opening it"
  open "${APPS}/TILL.app"
fi
