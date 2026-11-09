/**
 * N02 (D183), THE CONFINED READER: how an agent hands TILL a receipt by its PATH (`sourcePath`), and
 * the only place in the engine that reads a file the caller named.
 *
 * WHY IT EXISTS. Intake took base64 only, and an agent cannot reliably re-encode an image it was shown.
 * Claude Code keeps a chat attachment on disk, so the path is the honest hand-over. A path an agent
 * chose is also the most dangerous input this engine takes: read naively it turns every MCP client into
 * a file-read oracle for the whole home folder. So the rules below are not a filter in front of a read,
 * they decide WHETHER anything is read at all, and each one closes a named escape:
 *
 *  1. **Only a local host may read** (`LocalFileGrant`, set by `till mcp` over stdio and by `till up` in
 *     local mode). Every other host refuses `source_path_local_only` before the string is looked at:
 *     a served TILL must never read the server's disk for a caller across a proxy.
 *  2. **Only a leading `~/` is expanded**, and the result must be absolute. A relative path, `~user/`,
 *     a NUL byte or an absurd length refuses `path_not_allowed`.
 *  3. **Containment is decided BEFORE the file is opened** (critic F4). First lexically (a path that does
 *     not even name a place inside a root never touches the file system), then on the REAL parent folder:
 *     the deepest existing ancestor of the parent is resolved with `realpath.native`, and when it is not
 *     inside a root the answer is `outside_roots`, whatever exists or not beyond it. A symlinked folder
 *     inside a root that leads elsewhere is therefore no existence oracle: a file, a missing file and a
 *     folder behind it all answer the same, and so does a DANGLING folder link (an entry that exists but
 *     does not resolve stops the walk as outside; only a genuinely absent entry is walked past). A final-component symlink is resolved the same way before
 *     anything is opened, and a dangling one is `outside_roots` too.
 *  4. **The file is opened ONCE, by its real path, without following a link** (`O_NOFOLLOW`), and
 *     everything after is checked against that descriptor: `fstat` must be a regular file, and its (dev,
 *     ino) must equal `stat` of `realpath.native` of the same path taken AFTER the open, inside a root.
 *     A swap between the checks and the read (the classic TOCTOU) resolves to a different inode, or
 *     meets `O_NOFOLLOW`, and refuses `changed_while_reading`.
 *  5. **The real path must lie inside a root by an exact path-SEGMENT prefix** of `realpath.native` of
 *     the root: `/a/uploads-evil` is not inside `/a/uploads`.
 *  6. **A file with more than one hard link refuses**, judged on the descriptor AND on the resolved path
 *     after the inode match, and again after the read (critic F5). A hard link inside a root to a file
 *     outside it has a real path inside the root and the same inode, so rule 4 cannot see it; a receipt a
 *     chat client saved has exactly one name.
 *  7. **The size is read from the descriptor before any byte is**, against E00's single-call cap.
 *  8. **The first bytes are sniffed before the rest is read**: PDF, JPEG, PNG, HEIC or WebP, by their
 *     magic numbers, never by the extension. Nothing else is ever read past its first 32 bytes, and those
 *     are never stored or returned.
 *
 * The FIFO case is closed by opening non-blocking: a named pipe in a root cannot park the process, and
 * it fails rule 4 (not a regular file).
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { createHash } from 'node:crypto';

import { err } from '../result.js';
import type { Err } from '../result.js';
import { MAX_FILE_BYTES } from './files.js';

/**
 * The host's grant to read local files by path. Only `till mcp` (stdio) and `till up` in local mode set
 * it; its absence IS the served-mode refusal. `home` is injected so a suite never reads the developer's
 * home folder.
 */
export interface LocalFileGrant {
  readonly home: string;
}

/** The types `sourcePath` reads, by their magic numbers. The mime is derived from the bytes alone. */
export const SOURCE_PATH_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp'] as const;
export type SourcePathType = (typeof SOURCE_PATH_TYPES)[number];

/** The longest path the reader looks at. A real receipt path is a few hundred characters. */
const MAX_PATH_CHARS = 4096;

/** How many bytes the sniffer reads before deciding. Enough for every magic number above. */
const SNIFF_BYTES = 32;

/** The ISO BMFF major brands that are HEIF/HEIC stills (an iPhone photo is `heic`). AVIF is not here. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

/** What the bytes are, or null for anything the reader refuses. */
export function sniffType(head: Buffer): SourcePathType | null {
  if (head.length >= 5 && head.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.has(head.toString('latin1', 8, 12))) return 'image/heic';
  return null;
}

/**
 * Expand a caller's path: ONLY a leading `~/` becomes the home folder. Answers null for a form the
 * reader refuses (`~user/`, a bare `~`, a relative path).
 */
export function expandHome(raw: string, home: string): string | null {
  let expanded = raw;
  if (raw.startsWith('~/')) expanded = join(home, raw.slice(2));
  else if (raw.startsWith('~')) return null;
  if (!isAbsolute(expanded)) return null;
  return normalize(expanded);
}

/**
 * The folders a setting names: `;`-separated, trimmed, `~/` expanded, empty and unexpandable entries
 * dropped. Lexical only; `realRoots` resolves them.
 */
export function parseRoots(value: string, home: string): string[] {
  const out: string[] = [];
  for (const part of value.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const expanded = expandHome(trimmed, home);
    if (expanded !== null) out.push(stripTrailingSep(expanded));
  }
  return out;
}

function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}

/** `realpath.native` of each root that exists and is a directory; a missing root is skipped, never an error. */
export function realRoots(roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    try {
      const real = realpathSync.native(root);
      if (statSync(real).isDirectory()) out.push(stripTrailingSep(real));
    } catch {
      // A root that does not exist (yet) holds nothing to read.
    }
  }
  return out;
}

/** Exact path-SEGMENT containment: `child` is `root` itself or lies below it. */
export function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** What one confined read yields. The bytes are the file's, the mime is the sniffer's. */
export interface ConfinedFile {
  bytes: Buffer;
  mime: SourcePathType;
  /** The name the caller used (the last segment of the expanded path). */
  filename: string;
  /** The resolved path that was read, for the record of where a receipt came from. */
  realPath: string;
  sha256: string;
}

export interface ConfinedReadInput {
  /** The caller's path. */
  sourcePath: unknown;
  /** The roots, LEXICAL (already `~/`-expanded); resolved here. */
  roots: readonly string[];
  /** The host's grant; absent means the host may not read local files at all. */
  grant: LocalFileGrant | undefined;
  /** The input field name the refusals report. */
  field?: string;
}

function refuse(code: string, field: string, reason: string, extra: Record<string, unknown> = {}): Err {
  return err(code, { field, reason, ...extra }) as Err;
}

/**
 * Read ONE file the caller named, under every rule in the module note, or answer why not. Never throws
 * for a caller's input: every file-system failure is a structured refusal.
 */
export function readConfinedFile(input: ConfinedReadInput): { file: ConfinedFile } | Err {
  const field = input.field ?? 'sourcePath';
  if (input.grant === undefined) {
    return err('source_path_local_only', {
      field,
      reason: 'this TILL host does not read local files; send the bytes as contentBase64, or use till mcp / till up on this computer',
    }) as Err;
  }
  const raw = input.sourcePath;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_CHARS || raw.includes('\0')) {
    return refuse('path_not_allowed', field, 'invalid_path');
  }
  const expanded = expandHome(raw, input.grant.home);
  if (expanded === null) return refuse('path_not_allowed', field, 'not_absolute', { hint: 'an absolute path, or one starting with ~/' });

  const lexicalRoots = input.roots.map(stripTrailingSep);
  const resolvedRoots = realRoots(lexicalRoots);
  const outside = (): Err => refuse('path_not_allowed', field, 'outside_roots', { setting: 'files.source_roots' });
  const inside = (real: string): boolean => resolvedRoots.some((root) => isInside(real, root));
  // Rule 3a: nothing is touched for a path that does not even NAME a place inside a root.
  if (![...lexicalRoots, ...resolvedRoots].some((root) => isInside(expanded, root))) return outside();

  // Rule 3b: the REAL parent folder must be inside a root before anything in it is looked at.
  const parent = existingAncestor(dirname(expanded));
  if (parent === null || !inside(parent.real)) return outside();
  if (parent.missing) return refuse('file_not_found', field, 'missing');
  let target = join(parent.real, basename(expanded));
  let linkStat: ReturnType<typeof lstatSync>;
  try {
    linkStat = lstatSync(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return refuse('file_not_found', field, 'missing');
    return refuse('file_unreadable', field, 'permission_denied');
  }
  // Rule 3c: a final-component symlink is resolved before it is opened; dangling or outside, it is outside.
  if (linkStat.isSymbolicLink()) {
    let resolved: string;
    try {
      resolved = realpathSync.native(target);
    } catch {
      return outside();
    }
    if (!inside(resolved)) return outside();
    target = resolved;
  }

  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') return refuse('path_not_allowed', field, 'changed_while_reading');
    if (code === 'EACCES' || code === 'EPERM') return refuse('file_unreadable', field, 'permission_denied');
    return refuse('path_not_allowed', field, 'cannot_open', { code: code ?? 'unknown' });
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return refuse('path_not_allowed', field, 'not_a_file');
    // Rule 4 and 5: resolve AFTER the open, then require the resolved path inside a root and naming the
    // very inode the descriptor holds.
    let real: string;
    let named: ReturnType<typeof statSync>;
    try {
      real = realpathSync.native(target);
      named = statSync(real);
    } catch {
      return refuse('path_not_allowed', field, 'changed_while_reading');
    }
    if (!inside(real)) return outside();
    if (named.dev !== opened.dev || named.ino !== opened.ino) return refuse('path_not_allowed', field, 'changed_while_reading');
    // Rule 6, on both views of the file (critic F5).
    if (opened.nlink > 1 || named.nlink > 1) return refuse('path_not_allowed', field, 'hard_link');
    // Rule 7.
    if (opened.size > MAX_FILE_BYTES) return err('file_too_large', { field, bytes: opened.size, max: MAX_FILE_BYTES }) as Err;
    if (opened.size === 0) return refuse('unsupported_type', field, 'empty', { accepted: [...SOURCE_PATH_TYPES] });
    // Rule 8: the head first, and nothing more of a file that is not a receipt.
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, opened.size));
    const headRead = readSync(fd, head, 0, head.length, 0);
    const mime = sniffType(head.subarray(0, headRead));
    if (mime === null) return refuse('unsupported_type', field, 'not_pdf_or_image', { accepted: [...SOURCE_PATH_TYPES] });
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    if (offset !== opened.size) return refuse('file_unreadable', field, 'changed_while_reading');
    // Rule 6 once more, after the read: a link made while reading refuses too.
    const after = fstatSync(fd);
    if (after.nlink > 1) return refuse('path_not_allowed', field, 'hard_link');
    if (after.size !== opened.size) return refuse('file_unreadable', field, 'changed_while_reading');
    return {
      file: {
        bytes,
        mime,
        filename: basename(expanded),
        realPath: real,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * The real path of the deepest EXISTING ancestor of `dir` (itself included), and whether `dir` itself is
 * missing. Null means "answer outside_roots": nothing up to the file-system root exists, or an entry on
 * the way EXISTS but cannot be resolved.
 *
 * It walks up ONLY past an entry that is genuinely absent (`lstat` answers ENOENT or ENOTDIR). An entry
 * that exists but does not resolve, above all a DANGLING DIRECTORY SYMLINK inside a root (`s1/gone ->
 * ~/secret/nope`), stops the walk with null: walking past it would land on its in-root parent and answer
 * `file_not_found`, which tells the caller the link's target is missing, an existence oracle outside the
 * roots (security review of critic F4). This matches the dangling final-component case.
 */
function existingAncestor(dir: string): { real: string; missing: boolean } | null {
  let current = dir;
  let missing = false;
  for (;;) {
    try {
      lstatSync(current);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const up = dirname(current);
      if (up === current) return null;
      missing = true;
      current = up;
      continue;
    }
    // The entry exists (as a file, a folder or a link): it must resolve, or the answer is outside.
    try {
      const real = realpathSync.native(current);
      if (!statSync(real).isDirectory()) return { real, missing: true };
      return { real: stripTrailingSep(real), missing };
    } catch {
      return null;
    }
  }
}
