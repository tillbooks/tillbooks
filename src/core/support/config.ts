/**
 * G08 §4, the machine-scope preference file.
 *
 * TILL had no user config file before this: only environment variables, the SQLite ledger and the
 * Studio's `localStorage`. D42 chose a new `~/.till/config.json` over a workspace column, because a
 * person's privacy choice is not a property of one set of books, and over `localStorage`, because
 * the MCP and CLI faces cannot read that and an agent must be able to honour the user's choice.
 *
 * The directory is INJECTED, never re-derived. `src/api/db-path.ts` already owns `~/.till/`, and
 * deriving `join(homedir(), '.till')` a second time here would be the duplication that goes stale.
 * It also means every test points at a temporary directory rather than the developer's home.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { ok, err } from '../result.js';
import type { Result } from '../result.js';

export interface SupportPaths {
  readonly dir: string;
  readonly configPath: string;
  readonly journalPath: string;
  readonly feedbackDir: string;
}

export function supportPaths(dir: string): SupportPaths {
  return {
    dir,
    configPath: join(dir, 'config.json'),
    journalPath: join(dir, 'diagnostics.jsonl'),
    feedbackDir: join(dir, 'feedback'),
  };
}

export interface ConfigRead {
  /** The opt-in. Default FALSE, which is the Art. 7 Abs. 3 privacy-by-default posture. */
  readonly capture: boolean;
  /**
   * False when the file exists but does not parse. The panel says so and the file is LEFT ALONE:
   * a privacy setting that crashes the app is a privacy setting nobody keeps on, and silently
   * rewriting a file we failed to understand is worse than reporting that we failed.
   */
  readonly configReadable: boolean;
  /** Everything else in the file, preserved so a newer TILL's keys survive our write. */
  readonly rest: Record<string, unknown>;
}

const DEFAULTS: ConfigRead = { capture: false, configReadable: true, rest: {} };

export function readConfig(paths: SupportPaths): ConfigRead {
  let raw: string;
  try {
    raw = readFileSync(paths.configPath, 'utf8');
  } catch {
    return DEFAULTS; // absent is not an error: it is the default state of a fresh install
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { capture: false, configReadable: false, rest: {} };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { capture: false, configReadable: false, rest: {} };
  }
  const record = parsed as Record<string, unknown>;
  const { diagnostics, ...rest } = record;
  const capture =
    typeof diagnostics === 'object' && diagnostics !== null
      ? (diagnostics as Record<string, unknown>).capture === true
      : false;
  return { capture, configReadable: true, rest };
}

/**
 * Write the preference, preserving every key we did not write.
 *
 * Forward compatibility is not politeness here: a config written by a newer TILL carries keys this
 * version has never heard of, and clobbering them would silently downgrade the user's settings the
 * first time they open an older build.
 */
export function writeCapture(paths: SupportPaths, capture: boolean): Result {
  const current = readConfig(paths);
  const next = { ...current.rest, diagnostics: { capture } };
  const tmp = `${paths.configPath}.tmp`;
  try {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, paths.configPath);
  } catch (e) {
    // The failure mode of a privacy control must be the private one: the caller leaves capture OFF.
    return err('config_not_writable', {
      path: paths.configPath,
      reason: e instanceof Error ? e.name : 'unknown',
    });
  }
  return ok({ capture });
}
