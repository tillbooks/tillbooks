/**
 * Rich SYNTHETIC worlds for the list-free restore gate (spec G04 §0c item 5). Every value here is
 * invented or a published sample: no real book, bank file or export is read (private data never
 * ships, CLAUDE.md).
 *
 *  - `conformanceWorld()`: ONE workspace that every write verb's conformance scenario
 *    (`test/api/conformance-contract.mjs`, one valid call per write verb, written by the verb's own
 *    author) has been driven into, in registry order. It reaches far more tables than any hand-written
 *    fixture could, and it grows by itself: a verb added next month brings its scenario, and its rows,
 *    into this world without anyone editing the gate.
 *  - `seeblickWorld(dir)`: the D118 Seeblick presentation ledger (`scripts/seed-demo-rich.mjs`), two
 *    workspaces with a year of dated, cross-linked business, seeded into a file under `dir`.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAction } from '../../dist/api/registry.js';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * Scenarios the world does NOT drive, each with its reason. Everything else runs.
 */
export const WORLD_SKIPPED_VERBS = {
  // Workspace- and machine-level verbs: they mint, archive or replace workspaces or environments, or
  // write to disk, instead of adding rows to the ONE workspace the world is.
  create_workspace: 'mints another workspace',
  bootstrap_workspace: 'mints another workspace',
  onboard_client: 'mints another workspace',
  create_demo_workspace: 'mints another workspace',
  discard_demo_workspace: 'discards a workspace',
  archive_workspace: 'archives the world itself',
  env_switch: 'machine-level environment verb',
  env_create: 'machine-level environment verb',
  env_reset: 'machine-level environment verb',
  env_delete: 'machine-level environment verb',
  env_copy: 'machine-level environment verb (the gate drives env_copy itself)',
  prepare_feedback: 'writes a support bundle, no rows',
  set_diagnostics: 'machine-level diagnostics switch',
  clear_diagnostics: 'machine-level diagnostics switch',
  // G04 itself: the gate takes the backup and runs the restore it is checking.
  export_workspace: 'the gate runs G04 itself',
  create_backup: 'the gate runs G04 itself',
  delete_backup: 'the gate runs G04 itself',
  restore_backup: 'the gate runs G04 itself',
};

/**
 * Drive the named write scenarios (all of them by default) into ONE fresh fixture workspace. A
 * scenario that fails in the shared world (its precondition met another scenario's state) is
 * returned in `failed`, not fatal: the world is judged by the tables it reaches, which the gate
 * reports, and `conformanceWorlds` gives the failures a fresh world of their own.
 */
export function conformanceWorld(names = Object.keys(SCENARIOS)) {
  const fx = fixture();
  const ran = [];
  const failed = [];
  for (const name of names) {
    const scenario = SCENARIOS[name];
    if (scenario === undefined || WORLD_SKIPPED_VERBS[name] !== undefined) continue;
    try {
      const input = scenario(fx);
      const res = getAction(name).run(fx.deps, input);
      if (res && res.ok === true) ran.push(name);
      else failed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { fx, ran, failed };
}

/**
 * Worlds until no scenario is left that a fresh world could still run: the first drives every
 * scenario, each next one drives only what failed before, stopping when a round makes no progress.
 */
export function conformanceWorlds(maxWorlds = 6) {
  const worlds = [];
  let names = Object.keys(SCENARIOS);
  for (let i = 0; i < maxWorlds && names.length > 0; i += 1) {
    const w = conformanceWorld(names);
    worlds.push(w);
    if (w.ran.length === 0) break;
    names = w.failed;
  }
  return worlds;
}

/** Seed the Seeblick presentation ledger into `<dir>/seeblick.db` and return its path. */
export function seeblickWorld(dir) {
  const dbPath = join(dir, 'seeblick.db');
  // The frozen calendar (no TILL_SEED_TODAY), so the world is byte-identical on every run.
  const env = { ...process.env, TILL_DB_PATH: dbPath, TILL_SUPPORT_DIR: join(dir, 'support') };
  delete env.TILL_SEED_TODAY;
  const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'seed-demo-rich.mjs'), '--reset'], { env, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`seed-demo-rich failed (${res.status}): ${res.stderr}\n${res.stdout.slice(-2000)}`);
  return dbPath;
}
