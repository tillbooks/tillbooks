/**
 * D190: the Export page's "Quelle" filter offers exactly the engine's journal sources, in the engine's order.
 *
 * `EXPORT_SOURCES` in `app/src/surfaces/Review/model.ts` mirrors `VALID_SOURCES` in
 * `src/core/ledger/postEntry.ts`, the single §H-ENUM source of truth for `journal_entry.source`. The engine
 * keeps that set unexported on purpose, so both lists are read TEXTUALLY, the way
 * `test/planning/journal-source-filter-drift.test.mjs` reads the Journal surface's own mirror. A source the
 * engine adds or drops reddens this suite until the export filter matches. Nothing is executed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The string-literal entries of the array block opening at `marker`, `//` comments stripped per line. */
function stringArray(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not find ${marker} in the source`);
  const open = source.indexOf('[', start);
  const close = source.indexOf(']', open);
  assert.ok(open !== -1 && close !== -1 && close > open, `could not bound the array after ${marker}`);
  const out = [];
  for (const raw of source.slice(open + 1, close).split('\n')) {
    const line = raw.replace(/\/\/.*$/, '');
    const m = line.match(/'([a-z_]+)'/);
    if (m !== null) out.push(m[1]);
  }
  return out;
}

test('D190: the export Quelle filter offers every engine source, in the engine order', () => {
  const engine = readFileSync(join(ROOT, 'src/core/ledger/postEntry.ts'), 'utf8');
  const model = readFileSync(join(ROOT, 'app/src/surfaces/Review/model.ts'), 'utf8');
  const validSources = stringArray(engine, 'const VALID_SOURCES = new Set([');
  const exportSources = stringArray(model, 'export const EXPORT_SOURCES = [');
  assert.ok(validSources.length > 0, 'VALID_SOURCES parsed to nothing: the parser, not the mirror, is wrong');
  assert.deepEqual(
    exportSources,
    validSources,
    'EXPORT_SOURCES in app/src/surfaces/Review/model.ts has drifted from VALID_SOURCES in src/core/ledger/postEntry.ts',
  );
});
