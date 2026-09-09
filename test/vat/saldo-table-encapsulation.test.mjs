/**
 * The Saldo approval tables have ONE reader, and this is what keeps it that way.
 *
 * Three independent reviews of the previous attempt at multi-rate Saldo all returned FAIL, and the
 * third one named the pattern out loud: the change turned a CURRENT-STATE table into a HISTORY table
 * and the review was three times scoped to the files the change touched. The two defects that
 * survived were both in files OUTSIDE the diff, and both were silent wrong answers rather than
 * crashes:
 *
 *   - `ech0217.ts` counted `SELECT COUNT(*) FROM vat_saldo_rate` and refused a lawful export with
 *     `saldo_rates_exceed_form_lines configuredRates=3` for a workspace that had held exactly ONE
 *     Saldosteuersatz in every period of its life;
 *   - `resolveTax.saldoOutputFormLine` read `rates.length === 1` as "one approved rate" and, once a
 *     second approval existed, reported NO ESTV Ziffer at all on every preview, forever, while the
 *     return it previewed went on filing under 323.
 *
 * A code review cannot be relied on to catch that a third time, because the defect is invisible
 * unless you already know the table changed meaning. So it is a constraint instead. The old name is
 * gone (generation 5 drops it), and this test refuses any SQL naming the new tables outside the one
 * module whose entire job is to answer "what governed THIS date".
 *
 * The point is not tidiness. Every query in the owning module takes a date, so a reader that goes
 * through it CANNOT ask the dateless question that produced both defects.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../../src/', import.meta.url).pathname;

/** The tables only `saldoGenerations.ts` may name. */
const OWNED_TABLES = [
  'vat_saldo_generation',
  'vat_saldo_generation_rate',
  'vat_saldo_activity',
  'vat_saldo_activity_account',
  'vat_saldo_declaration_election',
  'vat_method_era',
];

/**
 * The files allowed to name them.
 *
 * `schema.ts` DEFINES the tables and `migrations.ts` lifts the old rows into them, so both name them
 * necessarily and neither can ask a question of a live workspace. Everything else goes through the
 * accessor.
 */
const ALLOWED = new Set([
  'core/vat/saldoGenerations.ts',
  'core/store/schema.ts',
  'core/store/migrations.ts',
]);

function sourceFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, `${prefix}${name}/`));
    else if (name.endsWith('.ts')) out.push({ rel: `${prefix}${name}`, full });
  }
  return out;
}

/**
 * The file with its comments blanked out, so only CODE is searched.
 *
 * A regex over the raw text cannot tell a live query from one quoted in a comment, and this guard
 * already promises in two places that prose is allowed. It was not: `ech0217.ts` explains the defect
 * this whole module exists to close by quoting the query it deleted, verbatim and in backticks, and
 * the raw-text regex read that comment as the very reader it had just been rewritten to remove. The
 * guard would have forced the explanation out of the one file where the next reader will meet it.
 *
 * Comments are BLANKED rather than dropped so byte offsets and line numbers survive, and string and
 * template literals are tracked so that a `//` inside one (a URL, say) cannot swallow the rest of a
 * real line of code. That direction matters more than the other: a false positive is an argument, a
 * false negative is a stale reader shipping against a table that no longer exists.
 */
function codeOnly(text) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let j = i; j < stop; j += 1) out += text[j] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

test('only saldoGenerations.ts may name the Saldo approval tables in SQL', () => {
  const offenders = [];
  for (const { rel, full } of sourceFiles(SRC)) {
    if (ALLOWED.has(rel)) continue;
    const text = codeOnly(readFileSync(full, 'utf8'));
    for (const table of OWNED_TABLES) {
      // The table name inside a SQL keyword context, which is what a query looks like. A prose
      // mention in a comment (`// vat_method_era holds closed eras`) is not a reader and must not
      // fail the guard, or the rule would push the reasoning out of the code that needs it.
      const sql = new RegExp(`(FROM|JOIN|INTO|UPDATE|TABLE)\\s+${table}\\b`, 'i');
      if (sql.test(text)) offenders.push(`${rel} names ${table} in SQL`);
    }
  }
  assert.deepEqual(offenders, [], 'these files must go through src/core/vat/saldoGenerations.ts');
});

test('no query anywhere in src/ still reads the retired vat_saldo_rate', () => {
  // Generation 5 drops the table, so a surviving query would fail with `no such table` the first
  // time it ran. Catching it here means catching it without needing a workspace in exactly the state
  // that exercises it, which is the state neither prior review thought to build.
  //
  // PROSE IS ALLOWED and several files carry it deliberately: the whole reason the fix is a rename
  // is a story that has to be written down where the next reader will meet it, and a guard that
  // banned the words would push that story out of the code. Only a SQL keyword followed by the table
  // name is a reader.
  const offenders = [];
  for (const { rel, full } of sourceFiles(SRC)) {
    if (rel === 'core/store/migrations.ts') continue;
    if (/(FROM|JOIN|INTO|UPDATE|TABLE)\s+vat_saldo_rate\b/i.test(codeOnly(readFileSync(full, 'utf8')))) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], 'vat_saldo_rate was dropped in schema generation 5');
});
