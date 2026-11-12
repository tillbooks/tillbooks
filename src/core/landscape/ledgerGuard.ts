/**
 * NEVER SILENTLY CREATE AN EMPTY LEDGER WHERE AN ENVIRONMENT'S LEDGER IS EXPECTED.
 *
 * Opening a SQLite path that does not exist creates an empty ledger there, which is exactly right for
 * a first `till up` on `main` and exactly wrong for a non-main environment: a `test` or `develop`
 * data root whose file is missing (a crash, a hand-deleted file, a half-restored disk) would come
 * back as an empty, schema-only ledger that looks healthy, reports `exists: true` in `env_list`, and
 * quietly replaces the copy or seed the environment is supposed to hold. The landscape registers
 * every environment's data root in its control file, so the expectation is knowable before the
 * open. This module answers one question from that registry: does this missing path belong to a
 * registered, non-main environment? The faces (`ensureDbChoice`, and `ensureDbPath` through it) and
 * the mandate copy fail loud on a yes and tell the operator how to rebuild instead.
 *
 * It reads the control file WITHOUT verifying its checksum (`readLandscape` is the verifying read):
 * this is a refusal to create, never a grant, so a tampered file can at worst make TILL refuse to
 * invent an empty ledger, which is the safe direction.
 *
 * A 0-BYTE FILE COUNTS AS MISSING (critic R2-L2). A half-restored disk, an interrupted copy or a sync
 * client's placeholder leaves the name with no bytes, and SQLite opens a 0-byte file as a new, empty
 * database, which is the very silent empty ledger this module exists to prevent. A real TILL ledger is
 * never 0 bytes: its header is written when the store first opens it. The rebuild verbs replace such a
 * file like a missing one.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { CONTROL_FILE_NAME, type Environment } from './model.js';

/** How many parent directories above a data root are searched for the landscape's control file. */
const CONTROL_SEARCH_DEPTH = 6;

/** The real absolute path of `p`: the deepest existing ancestor resolved through symlinks, plus the missing tail. */
function canonicalPath(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    tail.unshift(basename(cur));
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  try {
    cur = realpathSync(cur);
  } catch {
    // keep the lexical path when the ancestor cannot be resolved
  }
  return tail.length > 0 ? join(cur, ...tail) : cur;
}

function readEnvironments(controlDir: string): Environment[] {
  try {
    const parsed = JSON.parse(readFileSync(join(controlDir, CONTROL_FILE_NAME), 'utf8')) as {
      environments?: Record<string, Environment>;
    };
    return Object.values(parsed.environments ?? {});
  } catch {
    return [];
  }
}

/** A missing ledger that a registered environment expects to find. */
export interface MissingEnvironmentLedger {
  /** The environment whose data root this is (or the directory name under `environments/`). */
  readonly environment: string;
  readonly dbPath: string;
  /** The support directory holding the landscape control file that registers it. */
  readonly landscapeDir: string;
  /** True when the file exists but holds 0 bytes (critic R2-L2), false when it is absent. */
  readonly empty: boolean;
}

/** Is `p` absent, or present with 0 bytes (which SQLite would open as a new, empty database)? */
function absentOrEmpty(p: string): { absent: boolean; empty: boolean } {
  if (!existsSync(p)) return { absent: true, empty: false };
  try {
    const st = statSync(p);
    return st.isFile() && st.size === 0 ? { absent: true, empty: true } : { absent: false, empty: false };
  } catch {
    return { absent: false, empty: false };
  }
}

/**
 * THE ONE ANSWER to "is there a ledger at `dbPath`?" for every landscape check (critic R2-L2, R3-L1):
 * false when the path is absent OR a 0-byte file, because SQLite opens a 0-byte file as a new, empty
 * database. `existsSync` alone answers "is there a name", which is the question three rounds of critics
 * found siblings of. Use this wherever a ledger's presence decides what happens next.
 */
export function ledgerFilePresent(dbPath: string): boolean {
  return !absentOrEmpty(dbPath).absent;
}

/**
 * Is `dbPath` MISSING (absent, or a 0-byte file) while a registered, non-main environment expects a
 * ledger there? Searches the
 * given support directories and the data root's own ancestors (a named environment lives under
 * `<support>/environments/`, and a caller-chosen data root is confined there too) for a landscape
 * control file. Returns the environment, or undefined when the path exists, is `:memory:`, or no
 * environment claims it (a first run of `main` creates its ledger as it always has).
 */
export function missingEnvironmentLedger(dbPath: string, supportDirs: readonly string[] = []): MissingEnvironmentLedger | undefined {
  if (dbPath === ':memory:' || dbPath === '') return undefined;
  const { absent, empty } = absentOrEmpty(dbPath);
  if (!absent) return undefined;
  const target = canonicalPath(dbPath);

  const candidates: string[] = [];
  for (const dir of supportDirs) candidates.push(resolve(dir));
  let cur = dirname(resolve(dbPath));
  for (let i = 0; i < CONTROL_SEARCH_DEPTH; i += 1) {
    candidates.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  for (const dir of new Set(candidates)) {
    if (!existsSync(join(dir, CONTROL_FILE_NAME))) continue;
    for (const env of readEnvironments(dir)) {
      if (env.name === 'main' || env.guard_tier === 'protected') continue;
      if (typeof env.db_path !== 'string') continue;
      if (canonicalPath(env.db_path) === target) return { environment: env.name, dbPath, landscapeDir: dir, empty };
    }
    // An unregistered path under this landscape's environments root is still an environment data root.
    const root = canonicalPath(join(dir, 'environments'));
    if (target.startsWith(root + sep)) {
      const name = target.slice(root.length + 1).split(sep)[0] ?? 'unknown';
      return { environment: name, dbPath, landscapeDir: dir, empty };
    }
  }
  return undefined;
}

/** Thrown by an open path asked to create a ledger that an environment expects to already exist. */
export class MissingEnvironmentLedgerError extends Error {
  constructor(readonly missing: MissingEnvironmentLedger) {
    super(
      `Refusing to create an empty ledger at ${missing.dbPath}: it is the data root of the environment ` +
        `"${missing.environment}", and its ledger is ${missing.empty ? 'empty (0 bytes)' : 'missing'}. Rebuild it with env_reset (or restore it from a ` +
        'backup) instead of opening it; nothing was created.',
    );
    this.name = 'MissingEnvironmentLedgerError';
  }
}

/** Throw `MissingEnvironmentLedgerError` when `missingEnvironmentLedger` finds one. */
export function assertEnvironmentLedgerPresent(dbPath: string, supportDirs: readonly string[] = []): void {
  const missing = missingEnvironmentLedger(dbPath, supportDirs);
  if (missing !== undefined) throw new MissingEnvironmentLedgerError(missing);
}
