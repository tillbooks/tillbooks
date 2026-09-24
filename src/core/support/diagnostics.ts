/**
 * G08 §4, the opt-in error journal.
 *
 * Two properties do the work here, and both are structural rather than procedural:
 *
 * - **The file exists only while capture is on.** Turning the switch off DELETES it. Off means gone,
 *   not dormant, which is what makes the opt-in reversible in fact rather than only in principle
 *   (revDSG Art. 32).
 * - **Writes are single-line appends, eviction happens at read time.** The MCP stdio server and the
 *   REST server can both be live against one home directory (D12 already put a second writer on the
 *   SQLite file). A read-modify-write of the whole journal to enforce a 20-entry cap would interleave
 *   and lose entries, so the cap is applied when reading and the file is compacted only once it
 *   grows past twice the cap.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { SupportPaths } from './config.js';
import type { DiagnosticEntry } from './redact.js';

/** The journal keeps the last 20 entries. The panel says "the last 20" rather than implying more. */
export const JOURNAL_CAP = 20;

const COMPACT_AT = JOURNAL_CAP * 2;

/**
 * Append one entry. Callers MUST have checked the capture preference first: this module writes what
 * it is given, and the consent check lives at the one place that reads the preference.
 */
export function appendEntry(paths: SupportPaths, entry: DiagnosticEntry): void {
  try {
    mkdirSync(paths.dir, { recursive: true });
    appendFileSync(paths.journalPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Diagnostics must never break the thing they are diagnosing. A journal we cannot write is a
    // journal that stays empty, and the panel will show the empty state honestly.
    return;
  }
  compactIfLarge(paths);
}

function compactIfLarge(paths: SupportPaths): void {
  try {
    const lines = readLines(paths);
    if (lines.length <= COMPACT_AT) return;
    const tmp = `${paths.journalPath}.tmp`;
    writeFileSync(tmp, `${lines.slice(-JOURNAL_CAP).join('\n')}\n`, 'utf8');
    renameSync(tmp, paths.journalPath);
  } catch {
    return;
  }
}

function readLines(paths: SupportPaths): string[] {
  const raw = readFileSync(paths.journalPath, 'utf8');
  return raw.split('\n').filter((line) => line.trim() !== '');
}

export interface JournalRead {
  readonly entries: readonly DiagnosticEntry[];
}

/**
 * Read the journal, newest last, capped at 20.
 *
 * A line that does not parse is SKIPPED rather than fatal: a torn write from a killed process must
 * not make the whole journal unreadable, because the journal is the evidence for the report the user
 * is trying to send at exactly that moment.
 */
export function readJournal(paths: SupportPaths): Result {
  let lines: string[];
  try {
    lines = readLines(paths);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return ok({ entries: [] }); // absent means nothing recorded yet
    return err('journal_not_readable', { path: paths.journalPath });
  }
  const entries: DiagnosticEntry[] = [];
  for (const line of lines.slice(-JOURNAL_CAP)) {
    try {
      entries.push(JSON.parse(line) as DiagnosticEntry);
    } catch {
      continue;
    }
  }
  return ok({ entries });
}

/**
 * Erase the journal, and ONLY the journal.
 *
 * Written feedback artifacts are deliberately untouched: the user chose to keep those, and deciding
 * what they may retain is not ours to do. The confirm dialog says which of the two it is about.
 */
export function clearJournal(paths: SupportPaths): Result {
  try {
    rmSync(paths.journalPath, { force: true });
  } catch (e) {
    return err('journal_not_readable', {
      path: paths.journalPath,
      reason: e instanceof Error ? e.name : 'unknown',
    });
  }
  return ok({ entries: [] });
}
