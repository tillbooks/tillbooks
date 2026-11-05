/**
 * N02 (D183), THE BELEGEINGANG: receipts the owner saves into a folder are captured without a chat.
 *
 * The scheduler tick (`src/api/scheduler.ts`) calls `scanBelegeingang` once per live workspace. The scan
 * reads the folder `files.belegeingang_folder` names (non-recursive, skipping `Erledigt/` and hidden
 * files), hands each new file to A31's capture engine through the injected `capture` call (the registry's
 * own `capture_document`, run as the SEATED OWNER, the D142 pattern), and only after that capture
 * committed moves the file into `Erledigt/` beside it (`files.belegeingang_after = move`, the default).
 *
 * EVERY FILE IS READ THROUGH THE CONFINED READER with the folder as its only root, so a symlink in the
 * folder that points elsewhere, a hard link, a FIFO or a non-receipt is refused exactly as an agent's
 * `sourcePath` would be, and named in the status line instead of read.
 *
 * WHAT IT REFUSES TO GUESS. TILL never creates the folder (`folder_missing`); a folder two live
 * workspaces both name is skipped for both (`folder_shared`), because a receipt must never land in the
 * wrong books; with no seated owner holding `manage_files` it reads nothing (`no_actor`). Every file seen
 * is remembered by name, size and modification time (`belegeingang_seen`), so `keep` never captures it
 * twice (a discarded capture would otherwise be rescued on every tick) and a move that failed is retried.
 */

import { mkdirSync, readdirSync, renameSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

import type { WorkspaceContext } from '../context.js';
import { ok } from '../result.js';
import type { Err, Result } from '../result.js';
import { getSetting } from '../settings/settings.js';
import { readConfinedFile, expandHome, type ConfinedFile, type LocalFileGrant } from './sourcePath.js';

/** The folder a captured file moves into, beside the receipts. Never scanned. */
export const ERLEDIGT = 'Erledigt';

/** The states a scan ends in (what `belegeingang_status` and the Studio's status line render). */
export const BELEGEINGANG_STATES = ['ok', 'off', 'folder_missing', 'folder_invalid', 'folder_shared', 'no_actor', 'not_local'] as const;
export type BelegeingangState = (typeof BELEGEINGANG_STATES)[number];

/** One file the scan could not take, by name, with the refusal code. */
export interface BelegeingangError {
  file: string;
  error: string;
  reason?: string;
}

export interface BelegeingangReport {
  workspaceId: string;
  state: BelegeingangState;
  folder: string | null;
  captured: number;
  duplicates: number;
  moved: number;
  errors: BelegeingangError[];
}

/** The capture call the scheduler injects: `capture_document` as the seated owner. */
export type BelegeingangCapture = (input: { contentBase64: string; mime: string; filename: string; idempotencyKey: string }) => Result;

/** The folder this workspace names, `~/`-expanded, or null when it cannot be one. */
export function belegeingangFolder(ctx: WorkspaceContext, grant: LocalFileGrant | undefined): string | null {
  if (grant === undefined) return null;
  return expandHome(getSetting<string>(ctx, 'files.belegeingang_folder').trim(), grant.home);
}

/** The real path of a folder that exists as a directory, else null. */
export function existingFolder(folder: string | null): string | null {
  if (folder === null) return null;
  try {
    const real = realpathSync.native(folder);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function recordScan(ctx: WorkspaceContext, report: BelegeingangReport): void {
  const at = ctx.clock.now();
  ctx.store.tx(() => {
    const existing = ctx.store.db.prepare('SELECT id FROM belegeingang_scan WHERE workspace_id = ?').get(ctx.workspaceId) as { id: string } | undefined;
    if (existing === undefined) {
      ctx.store.db
        .prepare(
          `INSERT INTO belegeingang_scan (id, workspace_id, folder, state, scanned_at, captured, duplicates, errors_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ctx.ids.next('bscan'), ctx.workspaceId, report.folder, report.state, at, report.captured, report.duplicates, JSON.stringify(report.errors));
    } else {
      ctx.store.db
        .prepare(
          `UPDATE belegeingang_scan SET folder = ?, state = ?, scanned_at = ?, captured = ?, duplicates = ?, errors_json = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(report.folder, report.state, at, report.captured, report.duplicates, JSON.stringify(report.errors), ctx.workspaceId, existing.id);
    }
  });
}

/** A free name in `Erledigt/`: `beleg.pdf`, then `beleg (2).pdf`, `beleg (3).pdf`. */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

function moveToErledigt(folder: string, name: string): boolean {
  try {
    const target = join(folder, ERLEDIGT);
    mkdirSync(target, { recursive: true });
    renameSync(join(folder, name), join(target, freeName(target, name)));
    return true;
  } catch {
    return false;
  }
}

interface SeenRow {
  id: string;
  sha256: string;
  moved: number;
}

export interface ScanOptions {
  grant: LocalFileGrant | undefined;
  /** The capture as the seated owner, or null when no seated owner holds `manage_files`. */
  capture: BelegeingangCapture | null;
  /** The real folder paths more than one live workspace names (skipped for all of them). */
  sharedFolders: ReadonlySet<string>;
}

/**
 * Scan this workspace's Belegeingang once. Never throws for anything the folder holds: every file it
 * cannot take is an entry in `errors`, and the scan's state is recorded for the status read.
 */
export function scanBelegeingang(ctx: WorkspaceContext, opts: ScanOptions): BelegeingangReport {
  const report: BelegeingangReport = { workspaceId: ctx.workspaceId, state: 'ok', folder: null, captured: 0, duplicates: 0, moved: 0, errors: [] };
  const finish = (state: BelegeingangState): BelegeingangReport => {
    report.state = state;
    recordScan(ctx, report);
    return report;
  };
  if (opts.grant === undefined) return finish('not_local');
  if (getSetting<string>(ctx, 'files.belegeingang_scan') !== 'on') return finish('off');
  const named = belegeingangFolder(ctx, opts.grant);
  report.folder = named;
  if (named === null) return finish('folder_invalid');
  const folder = existingFolder(named);
  if (folder === null) return finish('folder_missing');
  if (opts.sharedFolders.has(folder)) return finish('folder_shared');
  if (opts.capture === null) return finish('no_actor');

  const after = getSetting<string>(ctx, 'files.belegeingang_after');
  let entries: string[];
  try {
    entries = readdirSync(folder).sort();
  } catch {
    return finish('folder_missing');
  }
  for (const name of entries) {
    if (name.startsWith('.') || name === ERLEDIGT) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(join(folder, name));
    } catch {
      continue;
    }
    if (st.isDirectory()) continue;
    const mtimeMs = Math.trunc(st.mtimeMs);
    const seen = ctx.store.db
      .prepare('SELECT id, sha256, moved FROM belegeingang_seen WHERE workspace_id = ? AND folder = ? AND name = ? AND size = ? AND mtime_ms = ?')
      .get(ctx.workspaceId, folder, name, st.size, mtimeMs) as SeenRow | undefined;
    if (seen !== undefined) {
      // Taken before: only an owed move is retried.
      if (after === 'move' && seen.moved === 0 && moveToErledigt(folder, name)) {
        ctx.store.db.prepare('UPDATE belegeingang_seen SET moved = 1 WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, seen.id);
        report.moved += 1;
      }
      continue;
    }
    const read = readConfinedFile({ sourcePath: join(folder, name), roots: [folder], grant: opts.grant, field: 'file' });
    if ((read as { ok?: unknown }).ok === false) {
      const refused = read as Err;
      report.errors.push({ file: name, error: refused.error, ...(typeof refused.reason === 'string' ? { reason: refused.reason } : {}) });
      continue;
    }
    const file = (read as { file: ConfinedFile }).file;
    const sameBytesBefore = ctx.store.db
      .prepare('SELECT 1 AS p FROM belegeingang_seen WHERE workspace_id = ? AND sha256 = ?')
      .get(ctx.workspaceId, file.sha256) !== undefined;
    const captured = opts.capture({
      contentBase64: file.bytes.toString('base64'),
      mime: file.mime,
      filename: name,
      idempotencyKey: `belegeingang:${file.sha256}:${st.size}:${mtimeMs}:${name}`,
    });
    if (!captured.ok) {
      report.errors.push({ file: name, error: captured.error });
      continue;
    }
    const duplicate = captured.duplicate === true || sameBytesBefore;
    if (duplicate) report.duplicates += 1;
    else report.captured += 1;
    const captureId = typeof captured.captureId === 'string' ? captured.captureId : null;
    // Moved only now: the capture above committed (the verb returned after its own transaction).
    const moved = after === 'move' && moveToErledigt(folder, name);
    if (moved) report.moved += 1;
    else if (after === 'move') report.errors.push({ file: name, error: 'move_failed' });
    ctx.store.db
      .prepare(
        `INSERT INTO belegeingang_seen (id, workspace_id, folder, name, size, mtime_ms, sha256, capture_id, duplicate, moved, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ctx.ids.next('bseen'), ctx.workspaceId, folder, name, st.size, mtimeMs, file.sha256, captureId, duplicate ? 1 : 0, moved ? 1 : 0, ctx.clock.now());
  }
  return finish('ok');
}

/** `belegeingang_status`: the folder, the switches and what the last scan saw. Reads only. */
export function belegeingangStatus(ctx: WorkspaceContext): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const row = ctx.store.db.prepare('SELECT * FROM belegeingang_scan WHERE workspace_id = ?').get(ctx.workspaceId) as
    | { folder: string | null; state: string; scanned_at: string; captured: number; duplicates: number; errors_json: string }
    | undefined;
  let errors: BelegeingangError[] = [];
  try {
    errors = row === undefined ? [] : (JSON.parse(row.errors_json) as BelegeingangError[]);
  } catch {
    errors = [];
  }
  const waiting = ctx.store.db
    .prepare("SELECT COUNT(*) AS n FROM captures WHERE workspace_id = ? AND status = 'needs_review'")
    .get(ctx.workspaceId) as { n: number };
  return ok({
    folder: getSetting<string>(ctx, 'files.belegeingang_folder'),
    scan: getSetting<string>(ctx, 'files.belegeingang_scan'),
    after: getSetting<string>(ctx, 'files.belegeingang_after'),
    state: row?.state ?? 'never_scanned',
    scannedFolder: row?.folder ?? null,
    lastScanAt: row?.scanned_at ?? null,
    captured: row?.captured ?? 0,
    duplicates: row?.duplicates ?? 0,
    errors,
    waitingCaptures: waiting.n,
  });
}
