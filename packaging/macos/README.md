# macOS delivery lane (M00, US-M00.2)

The macOS-first install: a double-clickable `TILL.app` that runs `till up` and opens the browser on
the first-run flow, so a GmbH owner never touches a terminal. This directory holds the part that can
be built unattended. The signing and notarisation that make Gatekeeper accept it are a release-pipeline
step, owner-gated, and are described here rather than smuggled into an automated build.

## What builds here (unattended)

`build-macos.sh` assembles an unsigned `TILL.app`:

- `Contents/Info.plist` with the bundle id `ch.tillbooks.studio` and the package version.
- `Contents/Resources/TILL.icns`, the dock and Finder icon (`CFBundleIconFile`). This is option C,
  the paper drawer: the walnut mark on a paper rounded-square tile, the pull picked out in brass.
  The `.icns` is checked in at `packaging/macos/TILL.icns` so the build needs no Python. It is
  regenerated from the one mark geometry, never hand-drawn:
  ```
  python3 brand/render-icons.py                                             # renders TILL.iconset
  iconutil -c icns packaging/macos/TILL.iconset -o packaging/macos/TILL.icns
  ```
- `Contents/MacOS/applet`, a **stay-open AppleScript applet** compiled by `osacompile -s` from
  `launcher.applescript`. Double-click starts `till up --no-open` in the background (log:
  `~/Library/Logs/TILL.log`), keeps its PID, and opens the Studio once the port answers. Dock > Quit
  and Cmd+Q send `quit`, which stops the server (TERM, then KILL after 2 seconds) before the applet
  exits, so no `till up` is left holding port 8788. A second click on the Dock icon reopens the
  browser. The earlier bash launcher had no Apple event loop: Quit never reached it, Force Quit was
  the only way out, and it orphaned the server. The applet source documents the `do shell script`
  pipe trap (backgrounding an AND-list keeps its stdout open, so the call never returns).
- with `--bundle-app`, `Contents/Resources/app` carrying `bin/`, `dist/`, `package.json` and
  `node_modules` (the native `better-sqlite3` build), so the app is self-contained apart from the
  Node runtime.

```
packaging/macos/build-macos.sh --bundle-app
```

This is the "runs unsigned in CI, signature stubbed" posture: the script produces the bundle and
stops. It never embeds a credential, and it never claims Gatekeeper will accept an unsigned build.
Gatekeeper will refuse it, which is exactly why the signed lane below exists.

## What does NOT build here (STOP: owner-gated release pipeline)

Two things are deliberately out of this script, both because they need the owner:

1. **An embedded Node runtime.** A real installer ships a pinned, notarised Node so the user installs
   no Node themselves. Choosing and vendoring that runtime is a release-pipeline decision.
2. **Code-signing and notarisation.** These need an **Apple Developer ID Application** certificate in
   **Nomadik GmbH's legal name**, from a paid Apple Developer account. That identity is the STOP
   point: it cannot be acquired or used by an unattended build, and no key is ever committed.

The release pipeline runs, with the owner's identity available in the keychain:

```
# 1. sign the bundle (Developer ID Application), hardened runtime on
codesign --force --deep --options runtime \
  --sign "Developer ID Application: Nomadik GmbH (TEAMID)" \
  packaging/macos/build/TILL.app

# 2. build a distributable (dmg or pkg), sign the installer
#    pkg: productbuild --component TILL.app /Applications \
#           --sign "Developer ID Installer: Nomadik GmbH (TEAMID)" TILL.pkg

# 3. notarise and staple
xcrun notarytool submit TILL.pkg --keychain-profile "till-notary" --wait
xcrun stapler staple TILL.pkg
```

Do not document a right-click "Open anyway" bypass for an unsigned build (spec US-M00.2 error case):
the answer to "Gatekeeper blocked it" is the signed artifact, not a workaround.

## Owner-gated items handed over (not decided here)

- **Apple Developer identity purchase**: a paid Apple Developer Program membership in Nomadik GmbH's
  legal name, and the Developer ID Application + Installer certificates it issues.
- **Package layout**: whether the app bundles `app/dist` in-package or a vendored `dist/studio`
  (`resolveStudioDir` in `src/api/up.ts` serves whichever is present, so this decision is not
  blocking; the release pipeline picks one and the packer copies it into `Resources/app`).
- **Auto-update posture**: an updater is an outbound socket by definition and is deferred as a later,
  owner-gated delivery decision (spec §3 out-of-scope).

## Linux and Windows

Linux is `npm i -g tillbooks && till up`, no installer needed. Windows is out of scope (D104): a
Windows user runs TILL inside an agent runtime (the `.mcpb` extension or `till mcp` in a session),
with no native installer, jail, or local inference promised.
