/**
 * G13's TWO STATIC WALLS (spec §4/§7), proven by mutation so they cannot rot into vacuity:
 *
 *   Wall 1: no module under `core/reports/` (a live read model) imports `core/migration/archive`.
 *   Wall 2: `core/migration/archive.ts` never reads the live ledger: no `journal_entry` or
 *           `journal_line` token appears in it.
 *
 * The one sanctioned meeting point is `src/api/report-actions.ts`, which imports BOTH sides and
 * joins them into a labelled column; that import is asserted PRESENT, which is also what keeps the
 * Wall-1 probe non-vacuous (the same regex finds the import where it legitimately lives).
 *
 * A third structural claim rides here because it is the same kind of evidence: `archivePurge`'s
 * module names no live table in any write statement, so the purge is INCAPABLE of touching a
 * journal row rather than merely not doing so today.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = (rel) => fileURLToPath(new URL(`../../src/${rel}`, import.meta.url));
const ARCHIVE_IMPORT = /from\s+'[^']*migration\/(archive|index)(\.js)?'/;

test('G13 wall 1: no file under core/reports imports the archive module (directly or via the barrel)', () => {
  const dir = SRC('core/reports');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 0, 'core/reports is empty, so this wall guards nothing');
  for (const file of files) {
    const source = readFileSync(`${dir}/${file}`, 'utf8');
    assert.equal(
      ARCHIVE_IMPORT.test(source),
      false,
      `core/reports/${file} imports the migration/archive module: a live read model crossed the wall`,
    );
  }
  // Non-vacuous, by mutation: the SAME probe must find the import at the one sanctioned meeting
  // point, or it is matching nothing anywhere and every assertion above is empty.
  const meetingPoint = readFileSync(SRC('api/report-actions.ts'), 'utf8');
  assert.equal(
    ARCHIVE_IMPORT.test(meetingPoint),
    true,
    'the probe cannot see the archive import even in report-actions.ts, so wall 1 proves nothing',
  );
});

test('G13 wall 2: archive.ts never names a live journal table', () => {
  const source = readFileSync(SRC('core/migration/archive.ts'), 'utf8');
  for (const token of ['journal_entry', 'journal_line']) {
    assert.equal(
      source.includes(token),
      false,
      `core/migration/archive.ts names ${token}: the archive read a live ledger table`,
    );
  }
  // Non-vacuous, by mutation: the same token probe DOES find the live tables where they live.
  const statements = readFileSync(SRC('core/reports/statements.ts'), 'utf8');
  assert.ok(statements.includes('journal_line'), 'the token probe cannot see journal_line even in statements.ts');
});

test('G13: the purge path is structurally incapable of touching a live row (no live table in any write)', () => {
  const source = readFileSync(SRC('core/migration/archive.ts'), 'utf8');
  // Every DELETE / UPDATE / INSERT statement in the module, with the table it targets.
  const writes = [...source.matchAll(/\b(DELETE FROM|UPDATE|INSERT INTO|INSERT OR IGNORE INTO)\s+([a-z_]+)/g)];
  assert.ok(writes.length > 0, 'no write statements found: the probe is broken, not the module clean');
  const allowed = new Set(['gl_archive_entry', 'gl_archive_line', 'gl_archive_period', 'gl_archive_purge_record', 'gl_archive_purge_gate', 'migration_step']);
  for (const [, kindOfWrite, table] of writes) {
    assert.ok(
      allowed.has(table),
      `archive.ts writes to ${table} (${kindOfWrite}): outside its own tables and the step it lands`,
    );
  }
});
