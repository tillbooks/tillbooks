/**
 * The three STRUCTURAL invariants of G10 (spec §7), each proven non-vacuous rather than asserted:
 *
 *  1. THE LOCALE FENCE: no file under `src/core/migration/` outside `locale/ch/` may contain a KMU
 *     account number or an MWST code. This is what keeps "Swiss is a pack" true instead of
 *     aspirational: remove the fence (paste one `UST81` or one KMU number into `maps.ts`) and this
 *     suite goes red naming the file. The scanner is proven to bite by running it over a synthetic
 *     offender first, so a scanner that silently matched nothing cannot pass.
 *  2. CLEAN-ROOM: every registered source adapter carries a non-empty `cleanRoomSource` URL.
 *  3. The identifier sets the fence scans FOR are DERIVED from the shipped seeds, never spelled
 *     here, so the fence cannot drift from the chart and code set it protects.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KMU_CORE_SEED } from '../../dist/core/accounts/kmuSeed.js';
import { DEFAULT_TAX_CODES } from '../../dist/core/vat/enums.js';
import { SOURCE_ADAPTERS, LOCALE_PACKS, localePackDef } from '../../dist/core/migration/index.js';

const MIGRATION_SRC = fileURLToPath(new URL('../../src/core/migration/', import.meta.url));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** The Swiss identifiers, DERIVED from the seeds the pack itself derives from. */
function swissIdentifiers() {
  // MWST codes are distinctive strings; bare 4-digit numbers would false-positive on years, so an
  // account number counts only when quoted ('1000', "1000"), which is the only shape a literal in
  // TypeScript source can take.
  const codes = DEFAULT_TAX_CODES.map((c) => c.code);
  const numbers = KMU_CORE_SEED.map((a) => a.number);
  return { codes, numbers };
}

/** Every fence violation in one file's text: the offending identifiers, or []. */
function violationsIn(text) {
  const { codes, numbers } = swissIdentifiers();
  const found = [];
  for (const code of codes) {
    if (text.includes(`'${code}'`) || text.includes(`"${code}"`) || text.includes('`' + code + '`')) found.push(code);
  }
  for (const number of numbers) {
    if (text.includes(`'${number}'`) || text.includes(`"${number}"`)) found.push(number);
  }
  return found;
}

test('the scanner itself bites: a synthetic offender is caught for both identifier families', () => {
  // If either seed changed shape or the matcher rotted, the fence below would be green by
  // vacuity. This turns that failure mode into a red test.
  const someCode = DEFAULT_TAX_CODES[0].code;
  const someNumber = KMU_CORE_SEED[0].number;
  const offender = `const a = '${someCode}'; const b = "${someNumber}";`;
  const found = violationsIn(offender);
  assert.ok(found.includes(someCode), 'the scanner catches an MWST code literal');
  assert.ok(found.includes(someNumber), 'the scanner catches a quoted KMU account number');
});

test('the locale fence: no Swiss identifier outside src/core/migration/locale/ch/', () => {
  const files = walk(MIGRATION_SRC);
  assert.ok(files.length >= 5, `the walker found the migration sources (got ${files.length})`);
  const offenders = [];
  for (const file of files) {
    const rel = relative(MIGRATION_SRC, file).split(sep).join('/');
    if (rel.startsWith('locale/ch/')) continue; // the ONE place the identifiers may live
    const found = violationsIn(readFileSync(file, 'utf8'));
    if (found.length > 0) offenders.push(`${rel}: ${found.join(', ')}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `Swiss identifiers leaked outside locale/ch/, so "Swiss is a pack" is decoration: ${offenders.join('; ')}`,
  );
});

test('the ch pack itself derives from the shipped seeds rather than restating them', () => {
  const ch = localePackDef('ch');
  assert.ok(ch !== undefined, 'ch always ships (US-G10.4)');
  assert.deepEqual([...ch.targetChartSeed.accountNumbers], KMU_CORE_SEED.map((a) => a.number));
  assert.deepEqual([...ch.taxCodeSet], DEFAULT_TAX_CODES.map((c) => c.code));
});

test('clean-room: every registered source adapter carries a non-empty cleanRoomSource URL', () => {
  assert.ok(SOURCE_ADAPTERS.length >= 1, 'at least the generic csv adapter is registered');
  for (const a of SOURCE_ADAPTERS) {
    assert.equal(typeof a.cleanRoomSource, 'string', `${a.id}: cleanRoomSource is a string`);
    assert.ok(a.cleanRoomSource.startsWith('https://'), `${a.id}: cleanRoomSource is a URL, got '${a.cleanRoomSource}'`);
  }
});

test('every locale pack states its parse conventions and statutory anchors', () => {
  for (const p of LOCALE_PACKS) {
    assert.ok(p.statutoryAnchors.length > 0, `${p.id}: statutory anchors are stated`);
    assert.ok(['dmy', 'mdy', 'ymd'].includes(p.parseConventions.dateOrder), `${p.id}: date order is declared`);
  }
});
