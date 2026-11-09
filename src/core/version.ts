/**
 * The ONE source of the version TILL says it is, read at runtime from the package's own
 * `package.json` (beta launch P0.1).
 *
 * THE DEFECT. The version was typed out by hand wherever something shipped it, and every hand copy
 * said `0.0.0`: the eCH-0217 file handed to the ESTV named its sending application "TILL 0.0.0"
 * whatever build wrote it. A release bump touches `package.json` (`ops/release.mjs`), so anything that
 * reads THAT follows the bump with no second edit, and there is nothing left to forget.
 *
 * WHY A RUNTIME READ AND NOT A BUILD STAMP. `tsc` emits this file to `dist/core/version.js`, and both a
 * checkout and an installed package keep `package.json` two directories above it (`dist/core` ->
 * package root), so one relative URL is right in both. An unreadable file answers `unknown` rather
 * than a plausible number: a version that cannot be read must not be invented.
 *
 * Node-only (it reads the file system): the Studio gets its version baked in by Vite
 * (`__TILL_VERSION__`, from the same `package.json`) and never imports this module.
 */

import { readFileSync } from 'node:fs';

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The `version` of the `tillbooks` package this engine was loaded from, e.g. `1.0.0-beta.1`. */
export const TILL_PACKAGE_VERSION: string = readPackageVersion();
