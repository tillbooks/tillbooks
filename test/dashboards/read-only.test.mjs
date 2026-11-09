// @ts-check
/**
 * F00's P5 tripwire, the STATIC half: the dashboards engine is read-only BY CONSTRUCTION.
 *
 * "F00 posts nothing and owns no tables" is a claim about code that does not exist, and the only
 * honest tests for absence are (1) looking for its effect, which `dashboards.test.mjs` does with a
 * full row census around every verb, and (2) looking for its MEANS, which this suite does by
 * scanning the source: no INSERT/UPDATE/DELETE/CREATE TABLE anywhere under `src/core/dashboards/`,
 * no import of `postEntry` (A02) or `recordPayment` (A14), no import of any ledger or payments
 * module at all, and no `.prepare(...)` whose SQL is anything but a SELECT. A read model that
 * quietly grew a memoisation table or a posting path would redden here even if its tests forgot
 * to census it.
 *
 * The scan reads the TypeScript SOURCE (not dist/) with comments stripped, so a comment ABOUT a
 * write cannot trip it and a real write cannot hide in one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const DASHBOARDS_DIR = fileURLToPath(new URL('../../src/core/dashboards', import.meta.url));

/** Comment-stripped source of every dashboards module, keyed by filename. */
function sources() {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const name of readdirSync(DASHBOARDS_DIR)) {
    if (!name.endsWith('.ts')) continue;
    const raw = readFileSync(join(DASHBOARDS_DIR, name), 'utf8');
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    out.set(name, stripped);
  }
  return out;
}

test('F00 read-only: no write SQL anywhere in src/core/dashboards/', () => {
  const writeSql = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|REPLACE\s+INTO)\b/i;
  for (const [name, code] of sources()) {
    assert.ok(
      !writeSql.test(code),
      `${name} contains write-shaped SQL; F00 is a pure read model (P5) and may only SELECT.`,
    );
  }
});

test('F00 read-only: every prepared statement is a SELECT', () => {
  for (const [name, code] of sources()) {
    for (const m of code.matchAll(/\.prepare\(\s*[`'"]([\s\S]*?)[`'"]\s*\)/g)) {
      const sql = String(m[1]).trim();
      assert.match(sql, /^SELECT\b/i, `${name} prepares non-SELECT SQL: ${sql.slice(0, 60)}...`);
    }
  }
});

test('F00 read-only: no postEntry / recordPayment import, no ledger or payments module reached', () => {
  const forbiddenSymbols = /\b(postEntry|recordPayment|reverseEntry|saveDraft)\b/;
  const forbiddenModules = /from\s+'[^']*\/(ledger|payments)\//;
  for (const [name, code] of sources()) {
    assert.ok(
      !forbiddenSymbols.test(code),
      `${name} names a posting/settlement verb; F00 has no financial effect (spec §3 out-of-scope).`,
    );
    assert.ok(
      !forbiddenModules.test(code),
      `${name} imports from the ledger or payments module; F00 composes the READ barrels only.`,
    );
  }
});

test('F00 owns no schema: no dashboards DDL module exists and no schema is exported', () => {
  const names = [...sources().keys()];
  assert.ok(!names.includes('schema.ts'), 'src/core/dashboards/schema.ts exists; F00 owns zero tables (P5).');
  for (const [name, code] of sources()) {
    assert.ok(!/SCHEMA_SQL/.test(code), `${name} references SCHEMA_SQL; a read model concatenates no DDL.`);
  }
});
