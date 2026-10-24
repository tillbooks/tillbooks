#!/usr/bin/env bash
#
# Build the DISTRIBUTABLE macOS TILL: a self-contained, Developer-ID-signed, notarised and stapled
# `TILL-macos.dmg` (M00, US-M00.2). `npm run build:mac:release` runs this.
#
# APPLE SILICON ONLY by default. macOS 26 warns "Support Ending for Intel-Based Apps" about any app
# with an Intel-only part that runs, and the next macOS drops Rosetta for apps, so the dmg carries no
# x86_64 code at all: an arm64 launcher, the arm64 Node, the darwin-arm64 addon. Intel Macs install
# with npm (`npm i -g tillbooks@beta && till up`). `--universal` builds the arm64 + x86_64 bundle
# instead (D172: the choice is a setting, arm64 the default). A check fails the build if any Mach-O
# lacks an arm64 slice, or, in the default build, carries anything but arm64.
#
# WHAT GOES IN. build-macos.sh assembles the native launcher (TillApp.swift). This script then adds
# what makes it run on a Mac with no Node installed:
#   Contents/Resources/runtime/bin/node  the pinned Node from nodejs.org, sha256-checked
#                                        (node-runtime.env); with --universal, arm64 + x86_64 joined
#                                        into one binary by lipo;
#   Contents/Resources/app               the `npm pack` tarball of this tree (its prepack builds dist/
#                                        and vendors the Studio into dist/studio), unpacked, with its
#                                        production dependencies from package-lock.json. better-sqlite3
#                                        ships N-API prebuilds for every platform; all but
#                                        darwin-arm64 (and darwin-x64 with --universal) are pruned.
# TillApp.swift prefers that runtime whenever no ~/.till/app.json names a launcher, so an install
# pinned through app.json (the Nomadik books) keeps running exactly what it names.
#
# SIGNING, inside out, hardened runtime and a secure timestamp everywhere: every native addon, then
# the Node runtime (node.entitlements: allow-jit + allow-unsigned-executable-memory, which V8 needs),
# then the app. No --deep: each piece is signed on purpose. The signed runtime is RUN (natively, never
# under Rosetta: an x86_64 run of a binary inside TILL.app is itself what raises the Intel warning)
# before anything is packed, so a missing entitlement fails here and not on a customer's Mac.
#
# NOTARISATION. The app is notarised (zip) and stapled first, so a copy dragged out of the dmg
# carries its own ticket offline; then the dmg is built, signed, notarised and stapled. Both use the
# first working keychain profile of `till-notary` and `plugsight-notary` (a profile belongs to the
# Apple ID and team, not to one app; TILL_NOTARY_PROFILE names one). None STOPS the build
# at the preflight with the one-time command for the owner: this script never asks for, reads or
# stores an Apple ID password.
#
# PUBLISHING is not done here. The output is packaging/macos/build/TILL-macos.dmg (+ .sha256); the
# owner-gated `gh release` step is in ./README.md.
#
# Usage:
#   packaging/macos/build-release.sh [--no-notarize] [--universal]
#     --no-notarize  sign everything but skip notarytool and stapler (a local check of the signed
#                    bundle; Gatekeeper still refuses a downloaded copy of that dmg).
#     --universal    arm64 + x86_64 instead of Apple silicon only.
# Environment:
#   TILL_SIGNING_IDENTITY  REQUIRED: the "Developer ID Application: <name> (<team>)" keychain identity
#   TILL_TEAM_ID           REQUIRED: the Apple Developer team id of that identity
#   TILL_SIGNING_ENV       a local file read first for the two above (default ~/.till/signing.env);
#                          the identity is personal and never lives in this public script
#   TILL_NOTARY_PROFILE    default: the first that works of "till-notary", "plugsight-notary"
#   TILL_APPLE_ID          only fills in the one-time store-credentials command a missing profile prints

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAC_DIR="${REPO_ROOT}/packaging/macos"
BUILD_DIR="${MAC_DIR}/build"
CACHE_DIR="${BUILD_DIR}/cache"
WORK="${BUILD_DIR}/release"
# The signing identity names a person, and this script ships in the public repo: it comes from the
# environment or a local file outside every repo, never from a default written here.
SIGNING_ENV="${TILL_SIGNING_ENV:-${HOME}/.till/signing.env}"
# shellcheck disable=SC1090
[ -f "${SIGNING_ENV}" ] && . "${SIGNING_ENV}"
IDENTITY="${TILL_SIGNING_IDENTITY:-}"
TEAM_ID="${TILL_TEAM_ID:-}"
NOTARY_CANDIDATES="${TILL_NOTARY_PROFILE:-till-notary plugsight-notary}"
NOTARY_PROFILE=""
APPLE_ID="${TILL_APPLE_ID:-<the Developer account Apple ID e-mail>}"
NOTARIZE=1
UNIVERSAL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-notarize) NOTARIZE=0 ;;
    --universal) UNIVERSAL=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# shellcheck source=node-runtime.env
. "${MAC_DIR}/node-runtime.env"

say() { echo "release: $*"; }
die() { echo "release: $*" >&2; exit 1; }

# --- 1. preflight: the identity and the notary profile, before any long step ----------------------
[ -n "${IDENTITY}" ] && [ -n "${TEAM_ID}" ] \
  || die "set TILL_SIGNING_IDENTITY and TILL_TEAM_ID (or put them in ${SIGNING_ENV}): the Developer ID Application identity and its team id"
security find-identity -v -p codesigning | grep -qF "\"${IDENTITY}\"" \
  || die "the signing identity \"${IDENTITY}\" is not in the keychain (security find-identity -v -p codesigning)"
if [ "${NOTARIZE}" -eq 1 ]; then
  for candidate in ${NOTARY_CANDIDATES}; do
    if xcrun notarytool history --keychain-profile "${candidate}" >/dev/null 2>&1; then
      NOTARY_PROFILE="${candidate}"; break
    fi
  done
fi
if [ "${NOTARIZE}" -eq 1 ] && [ -z "${NOTARY_PROFILE}" ]; then
  cat >&2 <<EOF
release: STOP. No notary keychain profile works (tried: ${NOTARY_CANDIDATES}). The owner creates one
         once, in a terminal, with an app-specific password generated under the Developer Apple ID
         at https://appleid.apple.com (Sign-In and Security > App-Specific Passwords):

    xcrun notarytool store-credentials till-notary --apple-id ${APPLE_ID} --team-id ${TEAM_ID}

         notarytool prompts for the password itself and keeps it in the login keychain. Then run
         \`npm run build:mac:release\` again. (--no-notarize builds the signed dmg without it.)
EOF
  exit 3
fi
[ -d "${REPO_ROOT}/app/node_modules" ] \
  || die "app/node_modules is missing: the Studio cannot be built for the package (npm run setup)"

VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
say "TILL ${VERSION}, Node ${NODE_VERSION}, signing as ${IDENTITY}${NOTARY_PROFILE:+, notary profile ${NOTARY_PROFILE}}"
rm -rf "${WORK}"
mkdir -p "${WORK}" "${CACHE_DIR}"

if [ "${UNIVERSAL}" -eq 1 ]; then NODE_ARCHS="arm64 x64" MAC_ARCHS="arm64 x86_64"; else NODE_ARCHS="arm64" MAC_ARCHS="arm64"; fi
say "architectures: ${MAC_ARCHS}"

# --- 2. the Node runtime: pinned, checksummed -----------------------------------------------------
RUNTIME="${WORK}/runtime"
mkdir -p "${RUNTIME}/bin"
for arch in ${NODE_ARCHS}; do
  tarball="node-v${NODE_VERSION}-darwin-${arch}.tar.gz"
  [ "${arch}" = arm64 ] && want="${NODE_SHA256_ARM64}" || want="${NODE_SHA256_X64}"
  if [ ! -f "${CACHE_DIR}/${tarball}" ]; then
    say "downloading ${tarball}"
    curl -fsSL --retry 3 -o "${CACHE_DIR}/${tarball}.part" "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
    mv "${CACHE_DIR}/${tarball}.part" "${CACHE_DIR}/${tarball}"
  fi
  got="$(shasum -a 256 "${CACHE_DIR}/${tarball}" | awk '{print $1}')"
  if [ "${got}" != "${want}" ]; then
    rm -f "${CACHE_DIR}/${tarball}"
    die "${tarball} sha256 ${got} does not match the pin ${want} (node-runtime.env); refusing it"
  fi
  mkdir -p "${WORK}/node-${arch}"
  tar -xzf "${CACHE_DIR}/${tarball}" -C "${WORK}/node-${arch}" --strip-components 1 \
    "node-v${NODE_VERSION}-darwin-${arch}/bin/node" "node-v${NODE_VERSION}-darwin-${arch}/LICENSE"
done
if [ "${UNIVERSAL}" -eq 1 ]; then
  lipo -create "${WORK}/node-arm64/bin/node" "${WORK}/node-x64/bin/node" -output "${RUNTIME}/bin/node"
else
  cp "${WORK}/node-arm64/bin/node" "${RUNTIME}/bin/node"
fi
chmod 755 "${RUNTIME}/bin/node"
cp "${WORK}/node-arm64/LICENSE" "${RUNTIME}/LICENSE"
say "runtime: node ($(lipo -archs "${RUNTIME}/bin/node"))"

# --- 3. the package: npm pack of this tree, production dependencies from the lockfile -------------
say "npm pack (prepack builds dist/ and vendors the Studio)"
( cd "${REPO_ROOT}" && npm pack --silent --pack-destination "${WORK}" ) > "${WORK}/pack.out"
TGZ="${WORK}/$(tail -n 1 "${WORK}/pack.out")"
[ -f "${TGZ}" ] || die "npm pack did not produce a tarball (${TGZ})"
PAYLOAD="${WORK}/app"
mkdir -p "${PAYLOAD}"
tar -xzf "${TGZ}" -C "${PAYLOAD}" --strip-components 1
[ -f "${PAYLOAD}/dist/studio/index.html" ] || die "the packed tarball carries no Studio (dist/studio/index.html)"
cp "${REPO_ROOT}/package-lock.json" "${PAYLOAD}/package-lock.json"
say "installing production dependencies"
( cd "${PAYLOAD}" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error )
rm -f "${PAYLOAD}/package-lock.json"

# Prune what a Mac never loads: better-sqlite3's other-platform prebuilds and its C sources.
BSQ="${PAYLOAD}/node_modules/better-sqlite3"
[ -f "${BSQ}/prebuilds/darwin-arm64.node" ] \
  || die "better-sqlite3 carries no darwin-arm64 prebuild; the bundle would not open a book"
if [ "${UNIVERSAL}" -eq 1 ]; then
  [ -f "${BSQ}/prebuilds/darwin-x64.node" ] || die "better-sqlite3 carries no darwin-x64 prebuild (--universal)"
  find "${BSQ}/prebuilds" -type f ! -name 'darwin-arm64.node' ! -name 'darwin-x64.node' -delete
else
  find "${BSQ}/prebuilds" -type f ! -name 'darwin-arm64.node' -delete
fi
rm -rf "${BSQ}/deps" "${BSQ}/src" "${BSQ}/build"

# Every Mach-O left in the payload must be a darwin binary, or signing and notarisation fail later.
MACHO_LIST="${WORK}/macho.txt"
find "${PAYLOAD}" -type f -print0 | xargs -0 file | grep 'Mach-O' | cut -d: -f1 > "${MACHO_LIST}" || true
say "payload: $(wc -l < "${MACHO_LIST}" | tr -d ' ') native file(s) to sign"
if find "${PAYLOAD}" -type f -name '*.node' -print0 | xargs -0 file | grep -v 'Mach-O' | grep .; then
  die "a non-Mach-O .node addon is left in the payload (listed above)"
fi

# --- 4. the app: the launcher, the runtime and the payload ----------------------------------------
"${MAC_DIR}/build-macos.sh" --out "${WORK}/out" --archs "${MAC_ARCHS}" > "${WORK}/build-macos.log" 2>&1 \
  || { cat "${WORK}/build-macos.log" >&2; die "build-macos.sh failed"; }
APP="${WORK}/out/TILL.app"
ditto "${RUNTIME}" "${APP}/Contents/Resources/runtime"
ditto "${PAYLOAD}" "${APP}/Contents/Resources/app"
xattr -cr "${APP}"

# Every Mach-O in the bundle must run natively on Apple silicon, and the default build must carry no
# Intel code at all: a single x86_64-only part is what macOS 26's Intel warning names.
ARCH_BAD=0
while IFS= read -r -d '' f; do
  file -b "${f}" | grep -q 'Mach-O' || continue
  archs="$(lipo -archs "${f}")"
  case " ${archs} " in *" arm64 "*) ;; *) echo "release: NO arm64 slice (${archs}): ${f#"${APP}/"}" >&2; ARCH_BAD=1 ;; esac
  if [ "${UNIVERSAL}" -eq 0 ] && [ "${archs}" != "arm64" ]; then
    echo "release: not arm64-only (${archs}): ${f#"${APP}/"}" >&2; ARCH_BAD=1
  fi
done < <(find "${APP}" -type f \( -perm +111 -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0)
[ "${ARCH_BAD}" -eq 0 ] || die "architecture check failed (listed above)"
say "architecture check: every Mach-O is ${MAC_ARCHS// / + }"

# --- 5. sign, inside out ----------------------------------------------------------------------------
sign() { codesign --force --timestamp --options runtime --sign "${IDENTITY}" "$@"; }
while IFS= read -r rel; do
  sign "${APP}/Contents/Resources/app/${rel#"${PAYLOAD}/"}"
done < "${MACHO_LIST}"
sign --entitlements "${MAC_DIR}/node.entitlements" "${APP}/Contents/Resources/runtime/bin/node"
sign "${APP}"
codesign --verify --deep --strict --verbose=2 "${APP}" 2>&1 | sed 's/^/release: /'

# The signed runtime has to RUN under the hardened runtime and open SQLite. Natively only: running
# the x86_64 slice through Rosetta would itself raise macOS's Intel warning for TILL.
SMOKE='const D=require("better-sqlite3");const d=new D(":memory:");console.log(process.arch, process.version, d.prepare("select sqlite_version() v").get().v)'
out="$(cd "${APP}/Contents/Resources/app" && env -i HOME="${WORK}" PATH=/usr/bin:/bin \
  arch -arm64 "${APP}/Contents/Resources/runtime/bin/node" -e "${SMOKE}")" \
  || die "the signed runtime does not run (entitlements or the addon signature)"
say "smoke: ${out}"
out="$(env -i HOME="${WORK}" PATH=/usr/bin:/bin "${APP}/Contents/Resources/runtime/bin/node" \
  "${APP}/Contents/Resources/app/bin/till.mjs" --version 2>&1)" || die "till --version failed: ${out}"
say "smoke till --version: ${out}"

# --- 6. notarise + staple the app, then build, sign, notarise + staple the dmg --------------------
notarize() {
  say "notarising $(basename "$1") (profile ${NOTARY_PROFILE}, this takes minutes)"
  xcrun notarytool submit "$1" --keychain-profile "${NOTARY_PROFILE}" --wait --output-format plist > "${WORK}/notary.plist" \
    || { cat "${WORK}/notary.plist" >&2; die "notarytool submit failed"; }
  status="$(/usr/libexec/PlistBuddy -c 'Print :status' "${WORK}/notary.plist")"
  if [ "${status}" != "Accepted" ]; then
    id="$(/usr/libexec/PlistBuddy -c 'Print :id' "${WORK}/notary.plist")"
    xcrun notarytool log "${id}" --keychain-profile "${NOTARY_PROFILE}" >&2 || true
    die "notarisation of $(basename "$1") ended ${status} (the log is above)"
  fi
}
if [ "${NOTARIZE}" -eq 1 ]; then
  ditto -c -k --keepParent "${APP}" "${WORK}/TILL-app.zip"
  notarize "${WORK}/TILL-app.zip"
  xcrun stapler staple "${APP}"
fi

DMG="${BUILD_DIR}/TILL-macos.dmg"
STAGE="${WORK}/dmg"
mkdir -p "${STAGE}"
ditto "${APP}" "${STAGE}/TILL.app"
ln -s /Applications "${STAGE}/Applications"
rm -f "${DMG}" "${DMG}.sha256"
hdiutil create -quiet -volname "TILL" -srcfolder "${STAGE}" -fs HFS+ -format UDZO -ov "${DMG}"
codesign --force --timestamp --sign "${IDENTITY}" "${DMG}"
if [ "${NOTARIZE}" -eq 1 ]; then
  notarize "${DMG}"
  xcrun stapler staple "${DMG}"
  spctl -a -t open --context context:primary-signature -vv "${DMG}" 2>&1 | sed 's/^/release: /'
  spctl -a -vv "${APP}" 2>&1 | sed 's/^/release: /'
fi
( cd "${BUILD_DIR}" && shasum -a 256 TILL-macos.dmg > TILL-macos.dmg.sha256 )
say "done: ${DMG} ($(du -h "${DMG}" | cut -f1), sha256 $(cut -d' ' -f1 "${DMG}.sha256"))"
[ "${NOTARIZE}" -eq 1 ] || say "NOT notarised (--no-notarize): Gatekeeper refuses a downloaded copy of this dmg"
