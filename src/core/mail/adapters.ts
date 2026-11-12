/**
 * E04's mail-store adapters: Apple Mail (`.emlx`) and Thunderbird (Maildir and mbox).
 *
 * AN ADAPTER READS FILES AND NOTHING ELSE. Its whole interface is four filesystem operations
 * (`looksLike`, `walk`, `readBody`, `writeDraft`), and the module imports `node:fs`, `node:path`,
 * `node:crypto`, the store's durable-file helper, and `node:child_process` for exactly one local
 * `lsof` probe (is Thunderbird holding the Drafts mbox open? see `assertNoMailClient`): no `net`, no
 * `tls`, no `http(s)`, no `dns`, ever. The `lsof` probe is the one subprocess this path starts: it
 * runs `lsof -t -w -- <files>` (`/usr/sbin/lsof` by absolute path on macOS), reads the open-file
 * table and opens no socket. It is called through the module's default export so E07's egress probe
 * records it, allow-listed by name and path (`ALLOWED_LOCAL_SUBPROCESSES` in egress/probe.ts), and
 * the Vertrauen limits list names it. That absence of a network module is the
 * OP6 mechanism (spec §1: "without opening a socket and without making a second copy of the
 * mail"), and the test-time egress probe in `test/mail/egress-probe.mjs` fails the suite if any
 * code on this path ever opens one.
 *
 * THE STORE IS THE AUTHORITY, THE INDEX IS DERIVED. `walk` re-reads the store on every reindex;
 * `readBody` re-reads one message on every thread read. Nothing is cached beyond the locator and
 * the hash, so the user's own retention and deletion behaviour in their mail client is honoured
 * for free (US-E04.2 Boundary).
 *
 * A plain module boundary, not a shared pattern: one consumer (E04), exactly as `parseRecurrence`
 * sits inside E03 (spec §4). Adding an adapter is one `MAIL_ADAPTERS` enum line + one entry in
 * `ADAPTERS` below + a fixture, and adds no verb.
 */

import {
  closeSync,
  type Stats,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
// The default export, not a named binding: E07's egress probe wraps the module object, so a named
// import captured at load time would spawn `lsof` unseen by `egress_self_test` (critic R1-L2).
import childProcess from 'node:child_process';

import { fsyncDirectory, makeDirectoryDurably, writeFileDurably } from '../store/sqlite-store.js';

import type { MailAdapterKind, MailDirection } from './enums.js';

/** One message found by a walk: a locator relative to the store root, plus the raw RFC-5322 source. */
export interface WalkedMessage {
  storeRef: string;
  raw: string;
}

export interface MailStoreAdapter {
  /** Does `storePath` have this adapter's store shape? Existence is checked by the caller. */
  looksLike(storePath: string): boolean;
  /** Every message in the store (Drafts excluded: TILL wrote those, indexing them is an echo). */
  walk(storePath: string): WalkedMessage[];
  /** Re-read one message by locator, or undefined when it no longer resolves (`message_moved`). */
  readBody(storePath: string, storeRef: string): string | undefined;
  /**
   * Write an RFC-5322 message into the store's Drafts folder and answer its locator. Throws on an
   * unwritable folder. `prepared` is the `prepareWrite` snapshot taken before the ledger transaction.
   */
  writeDraft(storePath: string, raw: string, prepared?: PreparedDraftWrite): string;
  /**
   * Replace the draft at `storeRef` with `raw` and answer the (possibly new) locator, so E06's
   * regenerate is ONE message in the Drafts folder rather than a growing pile (US-E06.4). Throws
   * on an unwritable folder; a `storeRef` that no longer resolves is the caller's `draft_gone`.
   */
  replaceDraft(storePath: string, storeRef: string, raw: string, identity: DraftIdentity, prepared?: PreparedDraftWrite): string;
  /**
   * The slow, ledger-free half of a Drafts write, run BEFORE the ledger transaction opens (critic
   * R1-L4): for a Thunderbird mbox, the mail-client busy check (`lsof`) and the read and hash of the
   * user's Drafts file. Never throws: a refusal is carried in the snapshot and raised by the write
   * that consumes it, so an idempotent replay (which never writes) is not refused. Undefined when the
   * write needs no preparation (Maildir, Apple Mail). The rename-time change check stays the last guard.
   * `guard` is the workspace's `mail.mbox_client_guard` (D172, critic R2-M1); absent means `refuse`.
   */
  prepareWrite?(storePath: string, storeRef?: string, guard?: MboxClientGuard): PreparedDraftWrite | undefined;
  /**
   * READ one of TILL's drafts BY IDENTITY: the message at `storeRef` when it proves to be the draft
   * (Message-ID or body hash, on the bytes read), else the draft wherever it now sits in the Drafts
   * folder (a compaction shifts mbox positions; a client renames Maildir files), with its CURRENT
   * locator; undefined when it is gone. A positional read alone could show the user's own draft.
   */
  locateDraft(storePath: string, storeRef: string, identity: DraftIdentity): { storeRef: string; raw: string } | undefined;
}

/**
 * Who the draft being replaced IS: TILL's own draft id (its Message-ID is `<id@till.local>` or
 * `<id.run@till.local>`) and the sha256 of the body TILL last wrote. A replace only ever touches a
 * message that proves to be this draft; a locator alone is not proof (see `DraftGoneError`).
 */
export interface DraftIdentity {
  readonly draftId: string;
  readonly bodySha256: string;
}

/**
 * The draft TILL wrote is no longer in the Drafts folder (the user sent or deleted it, or the client
 * compacted the folder so its locator now names another message). Nothing was written: a replace
 * never touches a message that is not TILL's own draft.
 */
export class DraftGoneError extends Error {
  constructor(readonly storeRef: string) {
    super(`the TILL draft at ${storeRef} is no longer in the Drafts folder`);
    this.name = 'DraftGoneError';
  }
}

/** Does this raw message prove to be the draft `identity` names (Message-ID first, body hash second)? */
function isTillDraft(raw: string | undefined, identity: DraftIdentity): boolean {
  if (raw === undefined || raw.length === 0) return false;
  const id = parseHeaders(raw)?.messageId;
  if (id !== undefined) {
    if (id === `${identity.draftId}@till.local`) return true;
    if (id.startsWith(`${identity.draftId}.`) && id.endsWith('@till.local')) return true;
  }
  return bodySha256(raw) === identity.bodySha256;
}

/**
 * The file holding the draft `identity` names in a one-file-per-message Drafts folder: the file at
 * `storeRef` when it proves to be that draft, else the first file in `dirs` that does (a client may
 * rename a draft, e.g. Maildir flag changes), else undefined.
 */
function findDraftFile(storePath: string, storeRef: string, dirs: readonly string[], read: (file: string) => string | undefined, identity: DraftIdentity): string | undefined {
  const at = insideStore(storePath, storeRef);
  if (at !== undefined && existsSync(at) && isTillDraft(read(at), identity)) return at;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const file = join(dir, name);
      if (isTillDraft(read(file), identity)) return file;
    }
  }
  return undefined;
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readEmlx(file: string): string | undefined {
  try {
    return parseEmlx(readFileSync(file));
  } catch {
    return undefined;
  }
}

/** The sha256 the index stores beside every locator, and re-checks on every read (`stale:true`). */
export function bodySha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** A locator must stay inside the store: a ref that escapes the root resolves to nothing. */
function insideStore(storePath: string, ref: string): string | undefined {
  const abs = resolve(storePath, ref);
  const root = resolve(storePath);
  return abs === root || abs.startsWith(root + sep) ? abs : undefined;
}

/** Recursively list files under `dir`, bounded so a pathological tree cannot hang a reindex. */
function listFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 8 || out.length > 50_000) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(path, depth + 1, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** Is any path segment a Drafts folder? Both stores name it `Drafts` (`Drafts.mbox` on Apple Mail). */
function isDraftsPath(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((part) => part === 'Drafts' || part === 'Drafts.mbox');
}

/* ------------------------------------------------------------------------------------------------
 * Apple Mail: `.emlx` files. An emlx is a byte count on its own first line, then exactly that many
 * bytes of RFC-5322 message, then an XML plist of flags. TILL reads the count and the message and
 * never touches the plist.
 * ---------------------------------------------------------------------------------------------- */

function parseEmlx(fileBytes: Buffer): string | undefined {
  const newline = fileBytes.indexOf(0x0a);
  if (newline <= 0) return undefined;
  const count = Number.parseInt(fileBytes.subarray(0, newline).toString('utf8').trim(), 10);
  if (!Number.isInteger(count) || count <= 0 || newline + 1 + count > fileBytes.length) return undefined;
  return fileBytes.subarray(newline + 1, newline + 1 + count).toString('utf8');
}

const appleMail: MailStoreAdapter = {
  looksLike(storePath) {
    return listFiles(storePath).some((f) => f.endsWith('.emlx'));
  },

  walk(storePath) {
    const out: WalkedMessage[] = [];
    for (const file of listFiles(storePath)) {
      if (!file.endsWith('.emlx')) continue;
      const ref = relative(storePath, file);
      if (isDraftsPath(ref)) continue;
      let raw: string | undefined;
      try {
        raw = parseEmlx(readFileSync(file));
      } catch {
        raw = undefined;
      }
      // An unreadable file is still WALKED (with empty raw) so the caller can count the skip: a
      // silently absent message and a deleted one must not look alike (US-E04.2 Error).
      out.push({ storeRef: ref, raw: raw ?? '' });
    }
    return out;
  },

  readBody(storePath, storeRef) {
    const abs = insideStore(storePath, storeRef);
    if (abs === undefined || !existsSync(abs)) return undefined;
    try {
      return parseEmlx(readFileSync(abs));
    } catch {
      return undefined;
    }
  },

  writeDraft(storePath, raw) {
    const dir = join(storePath, 'Drafts.mbox', 'Messages');
    makeDirectoryDurably(dir);
    const name = `${Date.now()}-${bodySha256(raw).slice(0, 12)}.emlx`;
    const file = join(dir, name);
    // Durable: a fsynced temp file renamed into place, then the folder synced. Apple Mail never sees
    // a half-written .emlx (the temp name is hidden and has no .emlx extension).
    writeFileDurably(file, `${Buffer.byteLength(raw, 'utf8')}\n${raw}`);
    return relative(storePath, file);
  },

  locateDraft(storePath, storeRef, identity) {
    const file = findDraftFile(storePath, storeRef, [join(storePath, 'Drafts.mbox', 'Messages')], readEmlx, identity);
    const raw = file === undefined ? undefined : readEmlx(file);
    return file === undefined || raw === undefined ? undefined : { storeRef: relative(storePath, file), raw };
  },

  replaceDraft(storePath, storeRef, raw, identity) {
    // Only TILL's own draft is ever removed: the file must prove to be it (Message-ID or body hash),
    // else it is looked up in the Drafts folder, else nothing is written (DraftGoneError).
    const old = findDraftFile(storePath, storeRef, [join(storePath, 'Drafts.mbox', 'Messages')], readEmlx, identity);
    if (old === undefined) throw new DraftGoneError(storeRef);
    // Write the replacement first, then remove the old file: a crash between the two leaves a
    // duplicate to clean up, never a lost draft.
    const newRef = this.writeDraft(storePath, raw);
    unlinkSync(old);
    fsyncDirectory(dirname(old));
    return newRef;
  },
};

/* ------------------------------------------------------------------------------------------------
 * Thunderbird: Maildir (a folder per mailbox holding `cur/` and `new/`, one file per message) and
 * classic mbox (one file per mailbox, messages separated by `From ` lines). A profile may hold
 * both; the walk reads whatever is there.
 * ---------------------------------------------------------------------------------------------- */

/** The Maildir folders directly under the store root (or the root itself, when it IS one). */
function maildirFolders(storePath: string): { name: string; path: string }[] {
  const folders: { name: string; path: string }[] = [];
  const isMaildir = (p: string) => existsSync(join(p, 'cur')) && existsSync(join(p, 'new'));
  if (isMaildir(storePath)) folders.push({ name: '.', path: storePath });
  let entries;
  try {
    entries = readdirSync(storePath, { withFileTypes: true });
  } catch {
    return folders;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && isMaildir(join(storePath, entry.name))) {
      folders.push({ name: entry.name, path: join(storePath, entry.name) });
    }
  }
  return folders;
}

/** The mbox files directly under the store root: a regular file starting with `From ` (or empty). */
function mboxFiles(storePath: string): string[] {
  let entries;
  try {
    entries = readdirSync(storePath, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.msf') || entry.name.endsWith('.sqlite')) continue;
    const path = join(storePath, entry.name);
    try {
      if (statSync(path).size === 0) continue;
      const head = readFileSync(path).subarray(0, 5).toString('utf8');
      if (head.startsWith('From ')) out.push(path);
    } catch {
      // Unreadable candidates are simply not mboxes.
    }
  }
  return out;
}

/** Split one mbox into raw messages, `From `-separator lines stripped. */
function splitMbox(content: string): string[] {
  const lines = content.split('\n');
  const messages: string[] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (line.startsWith('From ')) {
      if (current !== undefined) messages.push(current.join('\n'));
      current = [];
      continue;
    }
    // mbox escapes a body line starting `From ` as `>From `; undo exactly one level.
    if (current !== undefined) current.push(line.startsWith('>From ') ? line.slice(1) : line);
  }
  if (current !== undefined) messages.push(current.join('\n'));
  return messages.map((m) => m.replace(/\n+$/, ''));
}

/* ------------------------------------------------------------------------------------------------
 * Replacing one draft in a Thunderbird mbox, safely. The mbox `Drafts` file is the USER'S file: it
 * holds every draft they saved in Thunderbird, not only the ones TILL wrote. The old code truncated
 * and rewrote it in place (no temp file, no fsync), and re-serialised EVERY message with a fresh
 * `From -` line and a lossy `>From` round trip, so a crash mid-write could wipe all of those drafts
 * and even a clean run altered bytes TILL never owned.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Why a Drafts mbox write was refused as busy: `mail_client_running` (a mail client holds the mbox or
 * its profile open) or `mail_client_unknown` (the check could not answer: `lsof` missing, timed out or
 * failed, so TILL cannot tell whether Thunderbird is running and FAILS CLOSED, critic R1-L1).
 */
export type MailStoreBusyReason = 'mail_client_running' | 'mail_client_unknown';

/**
 * D172 (critic R2-M1): what the busy check before a Drafts mbox write does, the workspace setting
 * `mail.mbox_client_guard` (registry `src/core/settings/registry.ts`).
 *  - `refuse` (the default, critic R1-L1): refuse when a mail client holds the mbox or its profile, AND
 *    when that cannot be ruled out because `lsof` could not answer (`mail_client_unknown`).
 *  - `refuse_running`: refuse only when a client is proven to hold it; when `lsof` cannot answer the
 *    write goes ahead and the result says the check went unanswered (a TILL.app sandbox or a box
 *    without `lsof` would otherwise refuse every Drafts mbox write forever).
 *  - `off`: no busy check at all.
 * Under every value the rename-time change check stays: a Drafts file that moved since TILL read it
 * is refused `mail_store_changed`, so a draft the client saved meanwhile is never overwritten.
 */
export const MBOX_CLIENT_GUARDS = ['refuse', 'refuse_running', 'off'] as const;
export type MboxClientGuard = (typeof MBOX_CLIENT_GUARDS)[number];

/** Refused because a mail client holds the mbox (or its profile) open, or that cannot be ruled out. Nothing was written. */
export class MailStoreBusyError extends Error {
  constructor(
    readonly path: string,
    readonly evidence: string,
    readonly reason: MailStoreBusyReason = 'mail_client_running',
  ) {
    super(
      reason === 'mail_client_unknown'
        ? `refusing to rewrite ${path}: ${evidence}, so TILL cannot tell whether Thunderbird is running; nothing was written`
        : `refusing to rewrite ${path}: ${evidence}; close Thunderbird and regenerate the draft again`,
    );
    this.name = 'MailStoreBusyError';
  }
}

/** Refused because the mbox changed between TILL's read and its write. Nothing was written. */
export class MailStoreChangedError extends Error {
  constructor(readonly path: string) {
    super(`refusing to rewrite ${path}: it changed while the draft was being replaced; nothing was written`);
    this.name = 'MailStoreChangedError';
  }
}

/**
 * The byte offset of every message's `From ` separator line: at offset 0, or right after a `\n`.
 * The same message boundaries `splitMbox` uses, found on the raw BYTES so every other message can be
 * carried over byte for byte (a UTF-8 decode and re-encode would mangle an 8-bit Latin-1 body).
 */
function mboxSeparatorOffsets(bytes: Buffer): number[] {
  const marker = Buffer.from('From ', 'latin1');
  const offsets: number[] = [];
  let at = 0;
  while (at <= bytes.length - marker.length) {
    if ((at === 0 || bytes[at - 1] === 0x0a) && bytes.subarray(at, at + marker.length).equals(marker)) offsets.push(at);
    const next = bytes.indexOf(0x0a, at);
    if (next === -1) break;
    at = next + 1;
  }
  return offsets;
}

/** The Thunderbird profile directory above an mbox (the first ancestor holding `prefs.js`), if any. */
function thunderbirdProfileOf(mboxPath: string): string | undefined {
  let dir = dirname(mboxPath);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'prefs.js'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * How long one `lsof` may run. Well under the ledger's 5 s busy timeout (`DEFAULT_BUSY_TIMEOUT_MS`),
 * though the check now runs before the ledger transaction opens (`prepareWrite`). A real `lsof` on
 * two or three files answers in 0.1 to 0.4 s even on a loaded Mac.
 */
const LSOF_TIMEOUT_MS = 2_000;

/**
 * The `lsof` binaries to try, in order. macOS: ONLY the system binary by absolute path (it ships at
 * `/usr/sbin/lsof`; launchd's PATH or a user's PATH may lack `/usr/sbin`, or name another `lsof`
 * first). Elsewhere: the name through PATH, then the usual system locations, each tried only when the
 * previous one does not exist. Every entry is allow-listed in E07's probe (`ALLOWED_LOCAL_SUBPROCESSES`).
 */
function lsofCandidates(): readonly string[] {
  return process.platform === 'darwin' ? ['/usr/sbin/lsof'] : ['lsof', '/usr/bin/lsof', '/usr/sbin/lsof'];
}

/** What `processesHolding` found: the pids, that it cannot tell (and why), or that it does not apply. */
type Holders = { kind: 'known'; pids: number[] } | { kind: 'unknown'; why: string } | { kind: 'not_applicable' };

/**
 * Other processes holding any of `paths` open, via `lsof` (macOS and Linux ship it; it lists open
 * files and opens no socket). `unknown` when it cannot tell (no `lsof`, a timeout, an unexpected
 * status); `not_applicable` on Windows, where the `parent.lock` open test is the evidence instead.
 */
function processesHolding(paths: readonly string[]): Holders {
  if (process.platform === 'win32') return { kind: 'not_applicable' };
  const existing = paths.filter((p) => existsSync(p));
  if (existing.length === 0) return { kind: 'known', pids: [] };
  let why = 'lsof was not found';
  for (const lsof of lsofCandidates()) {
    const r = childProcess.spawnSync(lsof, ['-t', '-w', '--', ...existing], { encoding: 'utf8', timeout: LSOF_TIMEOUT_MS });
    if (r.error !== undefined) {
      const code = (r.error as { code?: string }).code;
      if (code === 'ENOENT') continue;
      why = code === 'ETIMEDOUT' ? `lsof did not answer within ${LSOF_TIMEOUT_MS} ms` : `lsof could not run (${code ?? r.error.message})`;
      return { kind: 'unknown', why };
    }
    // 0: holders listed; 1: none found. Anything else (a signal, another status) is no answer.
    if (r.status !== 0 && r.status !== 1) return { kind: 'unknown', why: `lsof failed (status ${String(r.status ?? r.signal)})` };
    const pids = String(r.stdout)
      .split(/\s+/)
      .filter((s) => /^\d+$/.test(s))
      .map(Number)
      .filter((pid) => pid !== process.pid);
    return { kind: 'known', pids };
  }
  return { kind: 'unknown', why };
}

/**
 * Is Thunderbird (or any other process) holding this mbox, or the Thunderbird profile it lives in?
 * Throws `MailStoreBusyError` when one is (`mail_client_running`) and when that cannot be ruled out
 * because `lsof` could not answer (`mail_client_unknown`: FAIL CLOSED, critic R1-L1, since on macOS
 * `lsof` is the only evidence of a running Thunderbird). Returns when nothing holds it. Checks, most
 * direct first:
 * a process with the mbox itself open; a running profile (the profile lock: Linux's `lock` symlink
 * naming a live pid, the `.parentlock` / `parent.lock` file a running instance holds open, or on
 * Windows a `parent.lock` that cannot be opened because the running instance holds it exclusively).
 *
 * `guard` (D172, `mail.mbox_client_guard`): `off` checks nothing; `refuse_running` refuses only a
 * proven holder and answers the reason `lsof` could not tell instead of throwing `mail_client_unknown`.
 * Returns that reason (the check went unanswered) or undefined (nothing holds the mbox, or `off`).
 */
function assertNoMailClient(mboxPath: string, guard: MboxClientGuard = 'refuse'): string | undefined {
  if (guard === 'off') return undefined;
  const profile = thunderbirdProfileOf(mboxPath);
  if (profile !== undefined) {
    const lockLink = join(profile, 'lock');
    let lockPid = Number.NaN;
    try {
      if (lstatSync(lockLink).isSymbolicLink()) lockPid = Number(/\+(\d+)$/.exec(readlinkSync(lockLink))?.[1] ?? Number.NaN);
    } catch {
      // no Linux lock symlink
    }
    if (Number.isInteger(lockPid) && lockPid !== process.pid && pidAlive(lockPid)) {
      throw new MailStoreBusyError(mboxPath, `Thunderbird is running on this profile (pid ${lockPid})`);
    }
    if (process.platform === 'win32') {
      const parentLock = join(profile, 'parent.lock');
      if (existsSync(parentLock)) {
        try {
          closeSync(openSync(parentLock, 'r+'));
        } catch (e) {
          const code = (e as { code?: string }).code ?? '';
          if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw new MailStoreBusyError(mboxPath, 'Thunderbird is running on this profile (parent.lock is held)');
        }
      }
    }
  }
  const locks = profile === undefined ? [] : [join(profile, '.parentlock'), join(profile, 'parent.lock')];
  const holders = processesHolding([mboxPath, ...locks]);
  if (holders.kind === 'unknown') {
    if (guard === 'refuse_running') return holders.why;
    throw new MailStoreBusyError(mboxPath, holders.why, 'mail_client_unknown');
  }
  if (holders.kind === 'known' && holders.pids.length > 0) {
    throw new MailStoreBusyError(mboxPath, `a mail client has the Drafts folder or its profile open (pid ${holders.pids.join(', ')})`);
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/**
 * Replace the message at `index` in the mbox at `abs` with `raw`, SAFELY:
 *
 *   1. Refuse, writing nothing, if Thunderbird (or anything) is detected holding the mbox or its
 *      profile open: rewriting a folder under a running client races its own writes and its summary.
 *   2. Only the target message's byte span is replaced; every other message (the user's own drafts)
 *      is carried over byte for byte, including the content before the first separator.
 *   3. The new file is written to a temp file in the SAME directory, fsynced, renamed over the mbox
 *      (atomic), and the directory is fsynced (`writeFileDurably`), keeping the file's permission
 *      bits. A crash leaves the old mbox or the new one, never a truncated one.
 *   4. Right before the rename, the mbox is re-read: if its size, mtime or content hash moved since
 *      TILL read it, the replace is refused and the temp file removed, so a draft Thunderbird saved
 *      meanwhile is never overwritten.
 */
function replaceMboxMessage(abs: string, index: number, raw: string, identity: DraftIdentity, storeRef: string, prepared?: PreparedDraftWrite): number {
  let replaced = -1;
  rewriteMbox(abs, (read) => {
    // IDENTITY ON THE BYTES BEING REPLACED. A positional locator is not proof: when the user sends
    // TILL's draft from Thunderbird and the folder is compacted, `#index` names the NEXT message,
    // which may be the user's own. So the message at the index must prove to be TILL's draft (its
    // Message-ID, else its body hash); otherwise the draft is looked up by identity across the file;
    // otherwise nothing is written.
    const offsets = mboxSeparatorOffsets(read);
    const messageAt = (i: number): string | undefined => {
      const start = offsets[i];
      if (start === undefined) return undefined;
      return splitMbox(read.subarray(start, offsets[i + 1] ?? read.length).toString('utf8'))[0];
    };
    let at = isTillDraft(messageAt(index), identity) ? index : -1;
    for (let i = 0; at === -1 && i < offsets.length; i += 1) if (isTillDraft(messageAt(i), identity)) at = i;
    if (at === -1) throw new DraftGoneError(storeRef);
    const start = offsets[at]!;
    const end = offsets[at + 1] ?? read.length;
    replaced = at;
    return Buffer.concat([read.subarray(0, start), mboxMessage(raw), read.subarray(end)]);
  }, prepared);
  return replaced;
}

/** One message in mbox form: a `From -` separator, the body with `From ` lines escaped, a blank line. */
function mboxMessage(raw: string): Buffer {
  return Buffer.from(`From - ${new Date(0).toUTCString()}\n${raw.replace(/^From /gm, '>From ')}\n\n`, 'utf8');
}

/**
 * Append one message to the mbox at `abs` (creating it, 0600, when absent) with the same rules as a
 * replace: refused while a mail client holds it, written whole through a durable temp + rename (an
 * in-place append that a crash cuts short would leave a torn message at the end of the user's file),
 * refused when the file changed underneath. Returns the new message's index.
 */
function appendMboxMessage(abs: string, raw: string, prepared?: PreparedDraftWrite): number {
  let index = -1;
  rewriteMbox(abs, (read) => {
    // A separator only counts at the start of a line: when the last message has no trailing newline,
    // one is added first, or the new draft would silently merge into the user's last message.
    const joint = read.length > 0 && read[read.length - 1] !== 0x0a ? Buffer.from('\n') : Buffer.alloc(0);
    const next = Buffer.concat([read, joint, mboxMessage(raw)]);
    index = mboxSeparatorOffsets(next).length - 1;
    return next;
  }, prepared);
  return index;
}

/** What TILL read of a user's mbox before writing it: the bytes, their stat and their hash. */
interface MboxSnapshot {
  readonly read: Buffer;
  readonly readStat: Stats | undefined;
  readonly readHash: string;
}

/**
 * The busy check and the read of one Drafts mbox, taken BEFORE the ledger transaction opens
 * (`MailStoreAdapter.prepareWrite`, critic R1-L4), so the ledger's write lock is never held across an
 * `lsof` spawn or a whole-file read and hash. Only `prepareWrite` mints one (a class instance, so a
 * JSON input can never pose as a checked snapshot). A refusal found while preparing rides in
 * `refusal` and is thrown by the write that consumes it. `guard` is the policy the check ran under;
 * `unanswered` is why `lsof` could not tell, when `refuse_running` let the write go ahead anyway.
 */
export class PreparedDraftWrite {
  /** @internal minted by `prepareWrite` and `recheckPreparedWrite` only */
  constructor(
    readonly mboxPath: string,
    readonly snapshot: MboxSnapshot | undefined,
    readonly refusal: unknown,
    readonly guard: MboxClientGuard = 'refuse',
    readonly unanswered?: string,
  ) {}
}

/** Read an mbox (an absent file reads as empty) with the stat and hash the rename-time check compares. */
function snapshotMbox(abs: string): MboxSnapshot {
  const existed = existsSync(abs);
  const read = existed ? readFileSync(abs) : Buffer.alloc(0);
  const readStat = existed ? statSync(abs) : undefined;
  return { read, readStat, readHash: createHash('sha256').update(read).digest('hex') };
}

/** The busy check, then the read: the order `rewriteMbox` has always used. Never throws. */
function prepareMbox(abs: string, guard: MboxClientGuard = 'refuse'): PreparedDraftWrite {
  try {
    const unanswered = assertNoMailClient(abs, guard);
    return new PreparedDraftWrite(abs, snapshotMbox(abs), undefined, guard, unanswered);
  } catch (e) {
    return new PreparedDraftWrite(abs, undefined, e, guard);
  }
}

/**
 * Critic R2-L1: ask again, right before the write, whether a mail client holds the mbox. A composite
 * that prepares before its transaction and then waits on something slow (E06's local model takes
 * seconds to minutes) would otherwise write on a busy answer older than a Thunderbird started
 * meanwhile. Runs the same check under the same guard; the earlier READ is kept, so the rename-time
 * change check still compares against what TILL first read. One `lsof` is bounded at
 * `LSOF_TIMEOUT_MS` (2 s), under the ledger's 5 s busy timeout, so this second check may run inside
 * the transaction. A snapshot that already carries a refusal, or that is not a real snapshot, is
 * returned unchanged. Never throws.
 */
export function recheckPreparedWrite(prepared: PreparedDraftWrite | undefined): PreparedDraftWrite | undefined {
  if (!(prepared instanceof PreparedDraftWrite) || prepared.refusal !== undefined) return prepared;
  try {
    const unanswered = assertNoMailClient(prepared.mboxPath, prepared.guard);
    return new PreparedDraftWrite(prepared.mboxPath, prepared.snapshot, undefined, prepared.guard, unanswered ?? prepared.unanswered);
  } catch (e) {
    return new PreparedDraftWrite(prepared.mboxPath, undefined, e, prepared.guard);
  }
}

/**
 * The one read-modify-write of a user's mbox. Reads the file (an absent file reads as empty), refuses
 * (writing nothing) when a mail client holds it or its profile, or when that cannot be ruled out,
 * builds the new content with `transform`, and publishes it with `writeFileDurably` (temp in the same
 * directory, fsync, atomic rename, directory fsync, the file's permission bits kept). Right before the
 * rename it re-reads the file: if its existence, size, mtime or content hash moved since the read, the
 * write is refused and the temp file removed, so a draft the client saved meanwhile is never
 * overwritten. With a `prepared` snapshot of THIS file, the busy check and the read were taken before
 * the ledger transaction opened and are not repeated here; the rename-time check compares against
 * that earlier read, so anything that changed since is still refused.
 */
function rewriteMbox(abs: string, transform: (read: Buffer) => Buffer, prepared?: PreparedDraftWrite): void {
  let snapshot: MboxSnapshot;
  if (prepared instanceof PreparedDraftWrite && resolve(prepared.mboxPath) === resolve(abs)) {
    if (prepared.refusal !== undefined) throw prepared.refusal;
    snapshot = prepared.snapshot as MboxSnapshot;
  } else {
    assertNoMailClient(abs);
    snapshot = snapshotMbox(abs);
  }
  const { read, readStat, readHash } = snapshot;

  const next = transform(read);
  writeFileDurably(abs, next, {
    mode: readStat === undefined ? 0o600 : readStat.mode & 0o7777,
    beforeRename: () => {
      if (readStat === undefined) {
        if (existsSync(abs)) throw new MailStoreChangedError(abs);
        return;
      }
      if (!existsSync(abs)) throw new MailStoreChangedError(abs);
      const now = statSync(abs);
      const unchanged =
        now.size === readStat.size &&
        now.mtimeMs === readStat.mtimeMs &&
        createHash('sha256').update(readFileSync(abs)).digest('hex') === readHash;
      if (!unchanged) throw new MailStoreChangedError(abs);
    },
  });
}

/**
 * Deliver one message into a Maildir folder the Maildir way, durably: write it under `tmp/` (fsynced,
 * via `writeFileDurably`), move it into `cur/` with one rename, and fsync `cur/` so the new entry
 * survives a power cut. A reader never sees a half-written file in `cur/`.
 */
function deliverMaildir(folder: string, name: string, raw: string): string {
  for (const sub of ['cur', 'new', 'tmp']) makeDirectoryDurably(join(folder, sub));
  const staged = join(folder, 'tmp', name);
  const file = join(folder, 'cur', name);
  writeFileDurably(staged, raw);
  renameSync(staged, file);
  fsyncDirectory(join(folder, 'cur'));
  return file;
}

const thunderbird: MailStoreAdapter = {
  looksLike(storePath) {
    return maildirFolders(storePath).length > 0 || mboxFiles(storePath).length > 0;
  },

  walk(storePath) {
    const out: WalkedMessage[] = [];
    for (const folder of maildirFolders(storePath)) {
      if (folder.name === 'Drafts') continue;
      for (const sub of ['cur', 'new']) {
        const dir = join(folder.path, sub);
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          const file = join(dir, name);
          let raw = '';
          try {
            if (statSync(file).isFile()) raw = readFileSync(file, 'utf8');
            else continue;
          } catch {
            raw = '';
          }
          out.push({ storeRef: relative(storePath, file), raw });
        }
      }
    }
    for (const file of mboxFiles(storePath)) {
      const ref = relative(storePath, file);
      if (isDraftsPath(ref)) continue;
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      splitMbox(content).forEach((raw, i) => {
        out.push({ storeRef: `${ref}#${i}`, raw });
      });
    }
    return out;
  },

  readBody(storePath, storeRef) {
    const hash = storeRef.lastIndexOf('#');
    if (hash > 0) {
      const abs = insideStore(storePath, storeRef.slice(0, hash));
      const index = Number.parseInt(storeRef.slice(hash + 1), 10);
      if (abs === undefined || !existsSync(abs) || !Number.isInteger(index) || index < 0) return undefined;
      try {
        return splitMbox(readFileSync(abs, 'utf8'))[index];
      } catch {
        return undefined;
      }
    }
    const abs = insideStore(storePath, storeRef);
    if (abs === undefined || !existsSync(abs)) return undefined;
    try {
      return readFileSync(abs, 'utf8');
    } catch {
      return undefined;
    }
  },

  writeDraft(storePath, raw, prepared) {
    // Match the store's own dialect: Maildir stores get a Maildir Drafts folder, mbox stores an
    // mbox Drafts file. A store with both dialects gets Maildir, the richer one.
    if (maildirFolders(storePath).length > 0) {
      const name = `${Date.now()}.${bodySha256(raw).slice(0, 12)}.till:2,D`;
      return relative(storePath, deliverMaildir(join(storePath, 'Drafts'), name, raw));
    }
    // mbox: the user's own Drafts file, so the same rules as a replace (see `rewriteMbox`).
    const index = appendMboxMessage(join(storePath, 'Drafts'), raw, prepared);
    return `Drafts#${index}`;
  },

  prepareWrite(storePath, storeRef, guard) {
    // Only an mbox write touches the user's own file; a Maildir delivery needs no preparation.
    const hash = storeRef === undefined ? -1 : storeRef.lastIndexOf('#');
    if (storeRef !== undefined && hash > 0) {
      const abs = insideStore(storePath, storeRef.slice(0, hash));
      return abs === undefined || !existsSync(abs) ? undefined : prepareMbox(abs, guard);
    }
    if (storeRef !== undefined || maildirFolders(storePath).length > 0) return undefined;
    return prepareMbox(join(storePath, 'Drafts'), guard);
  },

  locateDraft(storePath, storeRef, identity) {
    const hash = storeRef.lastIndexOf('#');
    if (hash > 0) {
      const abs = insideStore(storePath, storeRef.slice(0, hash));
      const index = Number.parseInt(storeRef.slice(hash + 1), 10);
      if (abs === undefined || !existsSync(abs)) return undefined;
      let messages: string[];
      try {
        messages = splitMbox(readFileSync(abs, 'utf8'));
      } catch {
        return undefined;
      }
      let at = Number.isInteger(index) && index >= 0 && isTillDraft(messages[index], identity) ? index : -1;
      for (let i = 0; at === -1 && i < messages.length; i += 1) if (isTillDraft(messages[i], identity)) at = i;
      const raw = at === -1 ? undefined : messages[at];
      return raw === undefined ? undefined : { storeRef: `${storeRef.slice(0, hash)}#${at}`, raw };
    }
    const drafts = join(storePath, 'Drafts');
    const file = findDraftFile(storePath, storeRef, [join(drafts, 'cur'), join(drafts, 'new')], readText, identity);
    const raw = file === undefined ? undefined : readText(file);
    return file === undefined || raw === undefined ? undefined : { storeRef: relative(storePath, file), raw };
  },

  replaceDraft(storePath, storeRef, raw, identity, prepared) {
    const hash = storeRef.lastIndexOf('#');
    if (hash > 0) {
      // mbox: replace the ONE message at its index, so every other draft's locator stays valid
      // (`Drafts#n` refs are positional and must not shift under their rows). See `replaceMboxMessage`
      // for why this never rewrites the user's file in place.
      const abs = insideStore(storePath, storeRef.slice(0, hash));
      const index = Number.parseInt(storeRef.slice(hash + 1), 10);
      if (abs === undefined || !existsSync(abs) || !Number.isInteger(index) || index < 0) {
        throw new Error(`mbox draft ${storeRef} does not resolve`);
      }
      const replaced = replaceMboxMessage(abs, index, raw, identity, storeRef, prepared);
      return `${storeRef.slice(0, hash)}#${replaced}`;
    }
    // Maildir: only TILL's own draft is removed (proved by Message-ID or body hash, looked up in the
    // Drafts folder when the client renamed it), then the replacement is written first and the old
    // file removed (write-first, as Apple Mail above), and the folder synced.
    const drafts = join(storePath, 'Drafts');
    const old = findDraftFile(storePath, storeRef, [join(drafts, 'cur'), join(drafts, 'new')], readText, identity);
    if (old === undefined) throw new DraftGoneError(storeRef);
    const newRef = this.writeDraft(storePath, raw);
    unlinkSync(old);
    fsyncDirectory(dirname(old));
    return newRef;
  },
};

export const ADAPTERS: Readonly<Record<MailAdapterKind, MailStoreAdapter>> = {
  apple_mail: appleMail,
  thunderbird: thunderbird,
};

/* ------------------------------------------------------------------------------------------------
 * RFC-5322 header parsing, shared by the reindex and the draft composer. Deliberately minimal:
 * TILL indexes metadata, it does not render MIME.
 * ---------------------------------------------------------------------------------------------- */

export interface ParsedHeaders {
  messageId: string | undefined;
  inReplyTo: string | undefined;
  /** The FIRST id in References: the root of the thread, the stable key. */
  referenceRoot: string | undefined;
  subject: string | undefined;
  fromAddress: string | undefined;
  toAddress: string | undefined;
  /** ISO instant when Date: parses, else undefined. */
  sentAt: string | undefined;
}

/** Unfold and read the header block of one raw message. Returns undefined when there is none. */
export function parseHeaders(raw: string): ParsedHeaders | undefined {
  if (raw.length === 0) return undefined;
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const block = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  // Unfold continuation lines (a line starting with whitespace continues the previous header).
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  if (headers.size === 0) return undefined;

  const angleId = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const match = /<([^<>]+)>/.exec(value);
    return match?.[1] ?? (value.trim().length > 0 ? value.trim() : undefined);
  };
  const firstAngleId = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const match = /<([^<>]+)>/.exec(value);
    return match?.[1];
  };
  const address = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const angled = /<([^<>@\s]+@[^<>\s]+)>/.exec(value);
    if (angled?.[1] !== undefined) return angled[1].toLowerCase();
    const bare = /([^\s<>,;"]+@[^\s<>,;"]+)/.exec(value);
    return bare?.[1]?.toLowerCase();
  };
  const date = headers.get('date');
  const parsedDate = date === undefined ? Number.NaN : Date.parse(date);

  return {
    messageId: angleId(headers.get('message-id')),
    inReplyTo: firstAngleId(headers.get('in-reply-to')),
    referenceRoot: firstAngleId(headers.get('references')),
    subject: headers.get('subject'),
    fromAddress: address(headers.get('from')),
    toAddress: address(headers.get('to')),
    sentAt: Number.isNaN(parsedDate) ? undefined : new Date(parsedDate).toISOString(),
  };
}

/** The direction rule, stated once: From matching the account address is outbound. */
export function directionOf(fromAddress: string | undefined, accountAddress: string): MailDirection {
  return fromAddress !== undefined && fromAddress.toLowerCase() === accountAddress.toLowerCase()
    ? 'outbound'
    : 'inbound';
}
