/**
 * Where the ledger lives on disk: ONE answer, shared by every face of the engine (D12).
 *
 * Before this, the Studio's dev bridge hardcoded `app/.dev-data/till.db` while `till mcp` defaulted
 * to `:memory:`. The Studio and the agent were therefore not on one ledger, which quietly falsifies
 * the central product claim: the agent could post an entry the human could never see.
 *
 * The rule is now: `TILL_DB_PATH` if it is set, otherwise `~/.till/till.db`. The default sits in the
 * home directory rather than in the project, so it is the same file whatever directory an agent
 * subprocess happens to be spawned in, and so a checkout is never the place the books live.
 * `:memory:` is honoured verbatim for an ephemeral run.
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import { makeDirectoryDurably } from '../core/store/sqlite-store.js';

/** The in-memory location, spelled the way better-sqlite3 spells it. */
export const MEMORY_DB = ':memory:';

/** The default directory holding the ledger, when `TILL_DB_PATH` says nothing. */
export function defaultDbDir(home = homedir()): string {
  return join(home, '.till');
}

/** The default ledger file. */
export function defaultDbPath(home = homedir()): string {
  return join(defaultDbDir(home), 'till.db');
}

/**
 * The path this process should open. A blank or whitespace-only `TILL_DB_PATH` is treated as unset,
 * because an empty environment variable is a misconfiguration, not a request for a file named ''.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TILL_DB_PATH?.trim();
  return configured === undefined || configured === '' ? defaultDbPath() : configured;
}

/**
 * Resolve the path AND make sure its directory exists, so opening it cannot fail on a fresh machine.
 * Returns the path, so a caller can hand it straight to the store.
 *
 * A directory created here (on a first run, `~/.till`) is created DURABLY: its parent is synced, so a
 * power cut cannot take the new directory, and the ledger the store then creates inside it, back out
 * of existence. The store syncs the ledger's own directory entry when it creates the file.
 */
export function ensureDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const path = resolveDbPath(env);
  if (path !== MEMORY_DB) makeDirectoryDurably(dirname(path));
  return path;
}

/**
 * G08's directory. Honours `TILL_SUPPORT_DIR` the way `resolveDbPath` honours `TILL_DB_PATH`.
 *
 * The env var exists so a test run can never write into the developer's real `~/.till/`. A suite
 * that builds its own `ApiDeps` and forgets to inject `supportDir` would otherwise land feedback
 * artifacts in a real home directory, which is both untidy and a bad look for the one capability
 * whose whole claim is that it keeps to itself.
 */
export function resolveSupportDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TILL_SUPPORT_DIR?.trim();
  return configured === undefined || configured === '' ? defaultDbDir() : configured;
}

/**
 * G04's backup directory: where `.tillbackup` / `.tillexport` artifact bundles are written.
 *
 * Three rungs, most specific first: `TILL_BACKUP_DIR` names the directory outright; otherwise a set
 * `TILL_SUPPORT_DIR` puts the artefacts UNDER it (`<support>/backups`); otherwise `~/.till/backups`.
 *
 * The middle rung is F-06 (2026-09-05). Before it, a harness run that isolated everything else
 * under its own support dir still wrote every backup and export into the developer's real
 * `~/.till/backups` (the J7 measurement left bundles there), and a served instance that mounts its
 * support dir on a volume would have kept its backups OFF that volume. The support dir is the one
 * directory an operator already points at machine state (G08's diagnostics, the `till up` lock), so
 * the artefacts follow it; the default for a plain local install does not move.
 */
export function resolveBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TILL_BACKUP_DIR?.trim();
  if (configured !== undefined && configured !== '') return configured;
  const support = env.TILL_SUPPORT_DIR?.trim();
  if (support !== undefined && support !== '') return join(support, 'backups');
  return join(defaultDbDir(), 'backups');
}
