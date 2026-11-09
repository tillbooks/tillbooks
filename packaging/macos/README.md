# macOS delivery lane (M00, US-M00.2; D166)

The macOS-first install: a double-clickable native `TILL.app` that runs `till up` and shows the Studio in
its own window, already signed in, so a GmbH owner never touches a terminal. This directory holds the
part that can be built unattended (`build-macos.sh`) and the release lane that turns it into a
self-contained, signed and notarised `TILL-macos.dmg` (`build-release.sh`, below).

## What builds here (unattended)

`build-macos.sh` assembles an unsigned `TILL.app`:

- `Contents/Info.plist` from `Info.plist`: the bundle id `ch.tillbooks.studio`, the package version, and
  `NSAllowsLocalNetworking` (http to the loopback only; App Transport Security stays on for the rest).
- `Contents/Resources/TILL.icns`, the dock and Finder icon (`CFBundleIconFile`). This is option C,
  the paper drawer: the walnut mark on a paper rounded-square tile, the pull picked out in brass.
  The `.icns` is checked in at `packaging/macos/TILL.icns` so the build needs no Python. It is
  regenerated from the one mark geometry, never hand-drawn:
  ```
  python3 brand/render-icons.py                                             # renders TILL.iconset
  iconutil -c icns packaging/macos/TILL.iconset -o packaging/macos/TILL.icns
  ```
- `Contents/MacOS/TILL`, a **native AppKit + WKWebView app** compiled from `TillApp.swift`, by default
  universal (arm64 and x86_64 joined by `lipo`; `--archs` picks others, the release build passes `arm64`). It replaced the stay-open AppleScript applet on 14.10.2026 (D166):
  the applet opened the bare URL in the default browser, which has no Studio key, so the person was
  sent to a terminal for a link. The app:
  - starts `till up --no-open` (log: `~/Library/Logs/TILL.log`), or ADOPTS the `till up` its support
    directory's lock names on its port, so Quit still stops it;
  - loads nothing until the server PROVES it is that `till up`: it answers a nonce at
    `POST /studio/prove` with an HMAC only the process the lock names, holding the owner-only key
    (`<support dir>/studio.key`), can produce. Then it derives a ONE-TIME ticket for exactly that
    process (HMAC-SHA256 over its pid, start time and the issue time, `deriveTicket` in
    `src/api/studio-devices.ts`) and loads `http://127.0.0.1:PORT/#t=<ticket>`, bypassing the cache.
    It checks again after every load, before any Studio navigation the page starts itself, and every
    5 seconds, and replaces the page the moment the server is not ours. Short of a matching proof (a
    busy server answers slowly), the server counts as ours only while every process listening on the
    port is the `till up` the app started or adopted (`lsof`; another account's process is invisible
    to it), so silence is never a pass. It clears the HTTP cache, service workers and IndexedDB at
    launch and before every load. The key itself never goes into a URL,
    and the window pairs no WebCrypto device key (that would hang an unsigned rebuild on a Keychain
    prompt);
  - answers the Studio's `rekey` request (after "Auf allen Geräten abmelden" elsewhere) with a fresh
    ticket, at most once per 10 seconds, from its own main frame and origin only;
  - stops the server on Quit (Cmd+Q, Dock > Quit, closing the window, or a plain `kill` of the app):
    TERM, then KILL after 5 seconds, so no `till up` is left holding its port;
  - saves downloads (pain.001 files, PDFs) to `~/Downloads`, runs file inputs and JavaScript dialogs,
    and hands only http(s) and mailto links to the system, never `file:` or another app's URL scheme.
- with `--bundle-app`, `Contents/Resources/app` carrying `bin/`, `dist/`, `package.json` and
  `node_modules` (the native `better-sqlite3` build), still run by the login shell's `node`. The
  release lane below is the self-contained build.

### Installing on this Mac: one command

`packaging/macos/install-local.sh` builds the app, quits a running TILL.app the normal way (which
stops its server), keeps the previous app in `~/.till/app-backups/`, installs the new one in
`/Applications` and opens it. With `--launcher`, `--port`, `--support-dir` (and optionally `--log`)
it also writes `~/.till/app.json` (below). From then on the person only clicks the TILL icon.

### A non-default install: `~/.till/app.json`

Without it the app runs the bundled payload (or a `till` on the login PATH) on port 8788 with the
support directory `~/.till`. An install with its own environment (a pinned runtime, a bank wire, a
Keychain passphrase) keeps that environment in ONE launcher script and points the app at it:

```json
{
  "command": "~/.till/run-studio.sh",
  "port": 8790,
  "supportDir": "~/.till/books",
  "logFile": "~/.till/books/studio.log"
}
```

`command` runs through a login shell with `exec`, so its pid is the server's (the one Quit signals).
`port` and `supportDir` must be the ones the script's `till up` uses: the app reads the lock and the
key file there. `TILL_APP_CONFIG` names another file (a throwaway test install).

```
packaging/macos/build-macos.sh --bundle-app
```

This is the "runs unsigned in CI, signature stubbed" posture: the script produces the bundle and
stops. It never embeds a credential, and it never claims Gatekeeper will accept an unsigned build.
Gatekeeper will refuse it, which is exactly why the release lane below exists.

## The release lane: `npm run build:mac:release`

`build-release.sh` turns the launcher into the distributable `packaging/macos/build/TILL-macos.dmg`
(plus `TILL-macos.dmg.sha256`): self-contained, Developer-ID-signed, notarised and stapled. It runs
on the owner's Mac, where a Developer ID Application identity is in the login keychain. The script
reads it from `TILL_SIGNING_IDENTITY` and its team from `TILL_TEAM_ID`, or from a local
`~/.till/signing.env` that sets both; the identity names a person, so it is never written into this
public repo, and the build stops if neither is set.

**Apple silicon only.** macOS 26 shows "Support Ending for Intel-Based Apps" for any app with an
Intel-only part that runs, and the next macOS release drops Rosetta for apps. So the dmg carries no
x86_64 code: an arm64 launcher, the arm64 Node and only the `darwin-arm64` addon. **Intel Macs use
the npm install** (`npm i -g tillbooks@beta && till up`, Node 22 or later). `--universal` builds the
arm64 + x86_64 bundle instead (the choice is a setting, arm64 the default). Either way the build
fails if any Mach-O in the bundle lacks an arm64 slice, and the default build fails on any slice
other than arm64.

1. **Preflight.** The identity and a working notary profile must exist before any long step. With
   no working profile the build stops with the one-time command below.
2. **Node runtime.** Node from nodejs.org at the version and sha256 pinned in `node-runtime.env`
   (the checksums are the ones in that release's signed `SHASUMS256.txt`), the arm64 build (with
   `--universal`, arm64 and x64 joined by `lipo`): `Contents/Resources/runtime/bin/node`. A download that does not match the
   pin is deleted and refused. Raising Node is a reviewed edit of `node-runtime.env`.
3. **Package.** `npm pack` of this tree (its `prepack` builds `dist/` and vendors the Studio into
   `dist/studio`), unpacked into `Contents/Resources/app` with `npm ci --omit=dev` against the root
   `package-lock.json`. better-sqlite3 ships N-API prebuilds for every platform; all but
   `darwin-arm64.node` (plus `darwin-x64.node` with `--universal`) and its C sources are pruned.
4. **Sign, inside out**, each with the hardened runtime and a secure timestamp: every Mach-O in the
   payload (the better-sqlite3 addon), then the runtime with `node.entitlements`, then the app.
   No `--deep`. Entitlements, and only on the runtime: `com.apple.security.cs.allow-jit` and
   `com.apple.security.cs.allow-unsigned-executable-memory` (V8 writes machine code at run time).
   `disable-library-validation` is NOT granted: the addons carry the same team's signature, so
   library validation accepts them. The launcher itself has no entitlements.
5. **Smoke.** The SIGNED runtime opens an in-memory SQLite and runs `till --version`, natively, with
   an empty environment and no Node on `PATH`. Never through Rosetta: running an x86_64 binary that
   sits inside TILL.app is itself what raises the Intel warning for TILL on the build Mac.
6. **Notarise.** The app (as a zip) is notarised and stapled, so a copy dragged out of the dmg carries
   its own ticket offline. Then the dmg (`hdiutil`, HFS+, UDZO, with an `/Applications` link) is
   signed, notarised and stapled, and `spctl` checks both.

`--no-notarize` signs everything and stops before notarytool: a local check of the signed bundle,
not something to hand out (Gatekeeper refuses a downloaded copy of it).

What the app runs: with no `~/.till/app.json`, the bundled runtime runs the bundled package directly
(no login shell, nothing from the person's shell profile). An `app.json` that names a `command` wins,
exactly as before, so the Nomadik install, pinned through `~/.till/app.json` to its own launcher
script, keeps running what it names. A reinstall of the release app does not touch `app.json`.

### The notary profile

notarytool reads its credentials from a keychain profile. A profile belongs to an Apple ID and a team,
not to one app, so any profile for the signing team notarises TILL. The build takes the first that
works of `till-notary` and `plugsight-notary` (`TILL_NOTARY_PROFILE` names another). This Mac has
`plugsight-notary` (the Developer account's Apple ID, which also notarises pendpost and
Plugsight), so `npm run build:mac:release` runs unattended here.

On a Mac with neither, the owner creates one once in a terminal, with an app-specific password
generated under that same Apple ID at https://appleid.apple.com (Sign-In and Security, App-Specific
Passwords). notarytool prompts for the password itself; it never goes into a file or a script:

```
xcrun notarytool store-credentials till-notary --apple-id <Developer account Apple ID e-mail> --team-id <team id>
```

### Verifying a build

```
codesign --verify --deep --strict --verbose=2 packaging/macos/build/release/out/TILL.app
spctl -a -vv packaging/macos/build/release/out/TILL.app        # accepted, source=Notarized Developer ID
spctl -a -t open --context context:primary-signature -vv packaging/macos/build/TILL-macos.dmg
xcrun stapler validate packaging/macos/build/TILL-macos.dmg
```

The last check before handing it out is a clean user account with no Node installed: open the dmg,
drag TILL to Applications, open it, and the Studio window appears.

### Publishing (owner-gated, not done by the build)

The release asset keeps the STABLE name `TILL-macos.dmg`, so the site can link
`https://github.com/tillbooks/tillbooks/releases/latest/download/TILL-macos.dmg` and never changes.
Publishing to the public `tillbooks/tillbooks` repo is the owner's step:

```
gh release create v<version> packaging/macos/build/TILL-macos.dmg packaging/macos/build/TILL-macos.dmg.sha256 \
  --repo tillbooks/tillbooks --title "TILL <version>" --notes "macOS (Apple silicon): TILL-macos.dmg, notarised. Intel Macs: npm i -g tillbooks@beta"
```

For a release that already exists: `gh release upload v<version> packaging/macos/build/TILL-macos.dmg
packaging/macos/build/TILL-macos.dmg.sha256 --repo tillbooks/tillbooks --clobber`. Only then does the
site's `MAC_AVAILABLE` flag turn on the download button.

Do not document a right-click "Open anyway" bypass for an unsigned build (spec US-M00.2 error case):
the answer to "Gatekeeper blocked it" is the signed artifact, not a workaround.

## Owner-gated items handed over (not decided here)

- **The signing identity's name.** The Developer ID in the keychain is the owner's personal one,
  not one in Nomadik GmbH's legal name. Gatekeeper shows that
  name. Moving to a Nomadik GmbH identity is a change of `TILL_SIGNING_IDENTITY` and the team id.
- **Auto-update posture**: an updater is an outbound socket by definition and is deferred as a later,
  owner-gated delivery decision (spec §3 out-of-scope).

## Linux and Windows

Linux is `npm i -g tillbooks@beta && till up` during the beta, no installer needed. Windows is out of scope (D104): a
Windows user runs TILL inside an agent runtime (the `.mcpb` extension or `till mcp` in a session),
with no native installer, jail, or local inference promised.
