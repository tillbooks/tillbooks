/**
 * F-06 (J7.2), `listRestorableBackups`: the artefacts a fresh install can SEE, before any workspace
 * exists.
 *
 * The restore door on `/first-run` used to take one typed absolute path and nothing else, because
 * `list_backups` is §H-TENANT (a `backups` row belongs to the workspace that wrote it) and a second
 * machine has no workspace yet. But the artefact directory is machine state the process already
 * knows (`backupDir`, the support dir's `backups/`), and every bundle carries its own `manifest.json`
 * with the facts the door needs to name BEFORE the act: when it was taken, which schema generation
 * it is, how many posted entries it holds. So this read lists exactly that, from the directory, and
 * says which generation THIS runtime expects, so an incompatible bundle is named before anyone
 * presses restore rather than refused after.
 *
 * It is a pure read over the file system: it opens no database file (it reads only the SHAPE of the
 * store it is handed, to judge a bundle's recorded shape against it, spec G04 §0c item 6), verifies no
 * checksum (that is `verify_backup`, which the door runs on the pick before the act), and writes
 * nothing. A directory
 * that is missing reads as an empty list, never an error: on a fresh machine "nothing here yet" is
 * the honest state, and the typed path stays the door's fallback. Only `.tillbackup` bundles are
 * listed: an export is not a restore source (`unrestorable_format`), so offering one here would be
 * the very dishonesty J7.5 names.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Result } from '../result.js';
import { ok } from '../result.js';
import { SCHEMA_GENERATION } from '../store/schema.js';
import type { SqliteStore } from '../store/sqlite-store.js';
import { isEmptyGap, schemaShapeOf, shapeGap } from '../store/schemaShape.js';
import type { SchemaShape } from '../store/schemaShape.js';

export interface RestorableBackup {
  /** The bundle directory, exactly what `verify_backup` and `restore_backup` take as `source`. */
  source: string;
  createdAt: string;
  schemaVersion: number;
  tillVersion: string;
  entryCount: number;
  /** The workspace the bundle was taken from (its id; the name lives inside the snapshot). */
  workspaceId: string;
  /**
   * True when this runtime can restore it as-is: an EXACT generation match (spec G04 §0a.6) and, where
   * the manifest records its shape (bundles from 30.09.2026 on), every table and column of it has a
   * place in this book (spec G04 §0c item 6). `verify_backup` re-reads the shape from the file itself.
   */
  compatible: boolean;
  /** The shape's sha256, when the manifest records it. */
  schemaFingerprint?: string;
  /** Tables and `table.column`s the bundle holds that this book has no place for (a newer TILL's). */
  unknownSchema?: string[];
}

interface ManifestFacts {
  format?: unknown;
  kind?: unknown;
  schemaVersion?: unknown;
  tillVersion?: unknown;
  workspaceId?: unknown;
  createdAt?: unknown;
  entryCount?: unknown;
  schemaShape?: unknown;
  schemaFingerprint?: unknown;
}

function readManifest(dir: string): ManifestFacts | null {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as ManifestFacts) : null;
  } catch {
    return null;
  }
}

/** A manifest's recorded shape, when it is one (a table name to an array of column names). */
function recordedShape(value: unknown): SchemaShape | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  for (const cols of Object.values(value as Record<string, unknown>)) {
    if (!Array.isArray(cols) || !cols.every((c) => typeof c === 'string')) return undefined;
  }
  return value as SchemaShape;
}

export function listRestorableBackups(deps: { backupDir: string; store?: SqliteStore }): Result {
  const directory = deps.backupDir;
  const backups: RestorableBackup[] = [];
  const here = deps.store === undefined ? undefined : schemaShapeOf(deps.store.db);
  if (existsSync(directory)) {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.tillbackup')) continue;
      const source = join(directory, name);
      let isDir = false;
      try {
        isDir = statSync(source).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      const m = readManifest(source);
      // A bundle whose manifest is missing or is not a sqlite snapshot is not offered: the door
      // names only what a restore could take. (verify_backup still answers `backup_corrupt` for it
      // if the person types its path by hand.)
      if (m === null || m.format !== 'sqlite_snapshot' || typeof m.schemaVersion !== 'number') continue;
      const shape = recordedShape(m.schemaShape);
      const gap = shape === undefined || here === undefined ? undefined : shapeGap(here, shape);
      backups.push({
        source,
        createdAt: typeof m.createdAt === 'string' ? m.createdAt : '',
        schemaVersion: m.schemaVersion,
        tillVersion: typeof m.tillVersion === 'string' ? m.tillVersion : '',
        entryCount: typeof m.entryCount === 'number' ? m.entryCount : 0,
        workspaceId: typeof m.workspaceId === 'string' ? m.workspaceId : '',
        compatible: m.schemaVersion === SCHEMA_GENERATION && (gap === undefined || isEmptyGap(gap)),
        ...(typeof m.schemaFingerprint === 'string' ? { schemaFingerprint: m.schemaFingerprint } : {}),
        ...(gap === undefined || isEmptyGap(gap) ? {} : { unknownSchema: [...gap.tables, ...gap.columns] }),
      });
    }
  }
  backups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return ok({ directory, currentSchemaVersion: SCHEMA_GENERATION, backups });
}
