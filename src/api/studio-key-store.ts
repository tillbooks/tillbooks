/**
 * The Studio key, kept between launches (D166, owner decision 14.10.2026).
 *
 * Until D166 `till up` minted a fresh key on every start and handed it over only in the printed
 * link. That kept the key off every HTTP response, but it also meant a bookmark, a new tab or any
 * restart lost the key, and the person was told to go and find a link in a terminal they never
 * opened. The owner's rule: TILL opens by itself on a known device, and a non-technical person is
 * never sent to a terminal.
 *
 * So the key now lives in ONE file, `<support dir>/studio.key`, readable and writable by the owner
 * only (0600), and survives restarts. Three readers, all of them the person's own:
 *
 *   1. `till up` itself, which reads it at start (or mints and writes it on the first start);
 *   2. the native `TILL.app` (packaging/macos), which reads it to prove the server and to derive a
 *      ONE-TIME ticket for its window (`/#t=`, `studio-devices.ts`), without a terminal and without
 *      the key ever going into a URL or crossing HTTP;
 *   3. a second `till up` (the redirect), which derives a ticket the same way to reopen the Studio.
 *
 * WHAT THIS DOES AND DOES NOT CHANGE IN THE THREAT MODEL (`session.ts` holds the full note). The key
 * still never appears in anything served: not the HTML, not the lock `till mcp` reads, not any API
 * response, ever. A program that can only make HTTP requests to
 * the loopback (curl, a fetch tool, an MCP client) learns nothing from the file existing. A program
 * that can READ this user's files could already open the SQLite book directly, and it can now also
 * read this file: that is the residual the approval claim's scope sentence names ("an agent that can
 * run commands on your computer can act as you"), unchanged in kind. Persisting the key lengthens how
 * long a stolen copy stays good, which is why `rotate` exists ("Auf allen Geräten abmelden").
 *
 * A key file that someone other than the owner could read (group or world bits set) is treated as
 * exposed and REPLACED rather than trusted. A symlink is never followed: the file is written to a
 * temporary name with `O_EXCL` and renamed over, so a planted link cannot redirect the write.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isWellFormedStudioKey, mintStudioKey } from './session.js';

/** The file name, inside the support directory. The native app reads the same path. */
export const STUDIO_KEY_FILE = 'studio.key';

/** Where a support directory keeps its Studio key. */
export function studioKeyPath(supportDir: string): string {
  return join(supportDir, STUDIO_KEY_FILE);
}

/**
 * The text of an owner-only file, or null when it is missing, not a plain file (a symlink is never
 * followed), or readable by anyone but the owner. Never throws. Shared with `studio-devices.ts`.
 */
export function readOwnerOnlyFile(file: string): string | null {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return null;
    // POSIX only: Windows reports synthetic mode bits, and its ACLs are the user profile's.
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write `content` owner-only (0600), atomically: a temporary name created with `O_EXCL`, then a rename
 * over the target, so a planted symlink is replaced rather than followed. Returns false on failure.
 */
export function writeOwnerOnlyFile(file: string, content: string): boolean {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600); // a umask cannot widen it, but be explicit about the one mode it may have
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing to clean up
    }
    return false;
  }
}

/**
 * The key a support directory holds, or null when there is none, it is malformed, it is not a plain
 * file, or others could read it. Never throws.
 */
export function readStudioKeyFile(supportDir: string): string | null {
  const key = readOwnerOnlyFile(studioKeyPath(supportDir))?.trim() ?? null;
  return key !== null && isWellFormedStudioKey(key) ? key : null;
}

/**
 * Write `key` as the support directory's Studio key, owner-only, atomically. Returns false when the
 * write failed (a read-only support dir): the host then runs on an in-memory key, as before D166.
 */
export function writeStudioKeyFile(supportDir: string, key: string): boolean {
  return writeOwnerOnlyFile(studioKeyPath(supportDir), `${key}\n`);
}

/** Where a host's key came from at start. */
export type StudioKeyOrigin = 'persisted' | 'minted' | 'memory';

/**
 * The live Studio key of one host. The faces read `current()` on every request, so a rotation takes
 * effect on the next request on both faces, and every tab still holding the old key is refused.
 */
export interface StudioKeySource {
  current(): string;
  /**
   * Mint a new key, persist it (when this host persists), and make it current. Returns it. Throws
   * `StudioKeyNotPersisted`, changing nothing, when the new key cannot be written.
   */
  rotate(): string;
}

export interface StudioKeyStore extends StudioKeySource {
  /** How the key was obtained at start: read from the file, minted and written, or memory only. */
  readonly origin: StudioKeyOrigin;
}

/**
 * Open the key store of a support directory: the persisted key when there is a trustworthy one,
 * otherwise a fresh key written to the file. `persist: false` keeps everything in memory (served
 * mode, where the key seats nobody, and hosts that must not write).
 */
export function openStudioKeyStore(supportDir: string, opts: { persist?: boolean } = {}): StudioKeyStore {
  const persist = opts.persist !== false;
  let key: string;
  let origin: StudioKeyOrigin;
  const existing = persist ? readStudioKeyFile(supportDir) : null;
  if (existing !== null) {
    key = existing;
    origin = 'persisted';
  } else {
    key = mintStudioKey();
    origin = persist && writeStudioKeyFile(supportDir, key) ? 'minted' : 'memory';
  }
  return {
    origin,
    current: () => key,
    rotate() {
      const next = mintStudioKey();
      // FAIL CLOSED: a rotation that cannot be persisted is refused and changes nothing. Switching only
      // the in-memory key would leave the revoked key in the file, where the next start (and TILL.app)
      // would read it back as valid: the rotation the person asked for would undo itself on restart.
      if (persist && !writeStudioKeyFile(supportDir, next)) throw new StudioKeyNotPersisted();
      key = next;
      return next;
    },
  };
}

/** A rotation whose new key could not be written. Nothing changed: the old key is still current. */
export class StudioKeyNotPersisted extends Error {
  constructor() {
    super('studio_key_not_persisted');
  }
}

/** A fixed key as a source, for hosts and suites that hold one string (the dev bridge, tests). */
export function fixedStudioKey(key: string): StudioKeySource {
  let current = key;
  return {
    current: () => current,
    rotate() {
      current = mintStudioKey();
      return current;
    },
  };
}
