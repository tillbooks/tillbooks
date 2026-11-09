/**
 * E04's mail-store adapters: Apple Mail (`.emlx`) and Thunderbird (Maildir and mbox).
 *
 * AN ADAPTER READS FILES AND NOTHING ELSE. Its whole interface is four filesystem operations
 * (`looksLike`, `walk`, `readBody`, `writeDraft`), and the module imports `node:fs`, `node:path`
 * and `node:crypto` only: no `net`, no `tls`, no `http(s)`, no `dns`, ever. That absence is the
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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

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
  /** Write an RFC-5322 message into the store's Drafts folder and answer its locator. Throws on an unwritable folder. */
  writeDraft(storePath: string, raw: string): string;
  /**
   * Replace the draft at `storeRef` with `raw` and answer the (possibly new) locator, so E06's
   * regenerate is ONE message in the Drafts folder rather than a growing pile (US-E06.4). Throws
   * on an unwritable folder; a `storeRef` that no longer resolves is the caller's `draft_gone`.
   */
  replaceDraft(storePath: string, storeRef: string, raw: string): string;
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
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${bodySha256(raw).slice(0, 12)}.emlx`;
    const file = join(dir, name);
    writeFileSync(file, `${Buffer.byteLength(raw, 'utf8')}\n${raw}`);
    return relative(storePath, file);
  },

  replaceDraft(storePath, storeRef, raw) {
    // Write the replacement first, then remove the old file: a crash between the two leaves a
    // duplicate to clean up, never a lost draft.
    const newRef = this.writeDraft(storePath, raw);
    const old = insideStore(storePath, storeRef);
    if (old !== undefined && existsSync(old)) unlinkSync(old);
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

  writeDraft(storePath, raw) {
    // Match the store's own dialect: Maildir stores get a Maildir Drafts folder, mbox stores an
    // mbox Drafts file. A store with both dialects gets Maildir, the richer one.
    if (maildirFolders(storePath).length > 0) {
      const dir = join(storePath, 'Drafts');
      for (const sub of ['cur', 'new', 'tmp']) mkdirSync(join(dir, sub), { recursive: true });
      const name = `${Date.now()}.${bodySha256(raw).slice(0, 12)}.till:2,D`;
      const file = join(dir, 'cur', name);
      writeFileSync(file, raw);
      return relative(storePath, file);
    }
    const file = join(storePath, 'Drafts');
    appendFileSync(file, `From - ${new Date(0).toUTCString()}\n${raw.replace(/^From /gm, '>From ')}\n\n`);
    const index = splitMbox(readFileSync(file, 'utf8')).length - 1;
    return `Drafts#${index}`;
  },

  replaceDraft(storePath, storeRef, raw) {
    const hash = storeRef.lastIndexOf('#');
    if (hash > 0) {
      // mbox: rewrite the message IN PLACE at its index, so every other draft's locator stays
      // valid (`Drafts#n` refs are positional and must not shift under their rows).
      const abs = insideStore(storePath, storeRef.slice(0, hash));
      const index = Number.parseInt(storeRef.slice(hash + 1), 10);
      if (abs === undefined || !existsSync(abs) || !Number.isInteger(index) || index < 0) {
        throw new Error(`mbox draft ${storeRef} does not resolve`);
      }
      const messages = splitMbox(readFileSync(abs, 'utf8'));
      if (index >= messages.length) throw new Error(`mbox draft ${storeRef} does not resolve`);
      messages[index] = raw;
      const rewritten = messages
        .map((m) => `From - ${new Date(0).toUTCString()}\n${m.replace(/^From /gm, '>From ')}\n\n`)
        .join('');
      writeFileSync(abs, rewritten);
      return storeRef;
    }
    // Maildir: write the replacement, then remove the old file (write-first, as Apple Mail above).
    const newRef = this.writeDraft(storePath, raw);
    const old = insideStore(storePath, storeRef);
    if (old !== undefined && existsSync(old)) unlinkSync(old);
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
