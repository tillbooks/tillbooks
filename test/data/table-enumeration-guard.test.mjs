/**
 * THE POSITIVE GUARD for the table chokepoint (LOW from the 13.10.2026 backup-tool-tables critic,
 * hardened after the 14.10.2026 critic planted eight bypasses that all got through, finding L3).
 *
 * `isTillTable` / `tillTables(db)` (`src/core/store/schemaShape.ts`) is the one rule for which tables
 * are TILL's: it drops SQLite's `sqlite_*` and every `_`-prefixed tool table (Litestream's
 * `_litestream_seq` / `_litestream_lock`). A module that lists the tables of a book from SQLite's
 * catalogue on its own treats a tool's table as part of the book: four of them did, and each reached a
 * tool table that carried a `workspace_id` (`test/landscape/tool-table-untouched.test.mjs`).
 *
 * So this test reads every string literal of every `src/**.ts` file and finds every reference to the
 * catalogue: `sqlite_master`, `sqlite_schema`, `sqlite_temp_master`, `sqlite_temp_schema` and
 * `table_list`, in ANY letter case (SQLite identifiers and pragma names are case-insensitive). Each
 * query must be
 *
 *  - a PROBE of one table named exactly, matched against the WHOLE query (`SELECT <cols> FROM
 *    sqlite_master WHERE type = 'table' AND name = ?|'x'` and nothing else: no UNION, no OR, no NOT,
 *    no trailing operator), which lists nothing, or
 *  - EQUAL, as a whole query, to an entry on the ALLOWLIST below, which names its file and the reason
 *    it is not a table enumeration for data handling.
 *
 * A literal that ends in `sqlite_` (or interpolates right after it) is a FRAGMENT of a catalogue name
 * built by concatenation and reds too. Anything else reds the build with its file, line and query,
 * and the fix is to call `tillTables(db)`. An allowlist entry that matches no query reds, so the list
 * cannot rot into a blanket pass.
 *
 * THE RESIDUAL a text scan cannot close: a catalogue name assembled with no literal ending in
 * `sqlite_` (`['sqlite', 'master'].join('_')`, a name read from data) is invisible to it. G04 says so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import * as schemaShape from '../../dist/core/store/schemaShape.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcRoot = join(repoRoot, 'src');

/**
 * The catalogue queries that are NOT table enumerations for data handling, each the WHOLE query with
 * its whitespace collapsed, in the file that runs it.
 */
const ALLOWLIST = [
  {
    file: 'src/core/store/schemaShape.ts',
    query: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    reason: 'THE chokepoint itself: `fileTables`, which `tillTables` filters through `isTillTable`.',
  },
  {
    file: 'src/core/store/schemaShape.ts',
    query:
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, rowid",
    reason: '`copySchemaDdl` reads every object and skips each whose name or owning table fails `isTillTable`.',
  },
  {
    file: 'src/core/store/sqlite-store.ts',
    query: 'SELECT COUNT(*) AS n FROM sqlite_master',
    reason: 'an emptiness probe (a brand-new file has no schema at all); it lists nothing.',
  },
  {
    file: 'src/core/store/migrations.ts',
    query:
      "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'journal_line' AND sql IS NOT NULL AND type IN ('index', 'trigger') ORDER BY type, name",
    reason: 'the journal_line rebuild captures the indexes and triggers of that ONE named TILL table.',
  },
  {
    file: 'src/core/store/migrations.ts',
    query: "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'journal_line'",
    reason: 'the journal_line rebuild re-reads the triggers of that ONE named TILL table.',
  },
  {
    file: 'src/core/store/migrations.ts',
    query: "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    reason: 'a one-TRIGGER probe: the generation-18 step checks its three named triggers arrived; it lists no table.',
  },
  {
    file: 'src/core/landscape/copy.ts',
    query: "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL",
    reason:
      'a TRIGGER enumeration: the immutability guards are dropped and recreated from their own SQL around a clone transform; no table row is read or written.',
  },
  {
    file: 'src/core/migration/testmandant.ts',
    query: "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'",
    reason:
      'a TRIGGER enumeration: the protective triggers are lifted and recreated from their own SQL in the same transaction; no table row is read or written.',
  },
];

/** Every `.ts` file under src/, absolute. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Any of SQLite's catalogue names, in any letter case, plus the two other ways a SQLite file lists its
 * tables: the `dbstat` virtual table (better-sqlite3 ships it, and it lists a tool's `_tool_state`) and
 * the ANALYZE statistics tables `sqlite_stat1`..`4` (critic L-R2-1, 14.10.2026), and `sqlite_sequence`, which names every
 * AUTOINCREMENT table (critic round 4, INFO).
 */
const CATALOGUE_RE = /sqlite_(temp_)?(master|schema)|table_list|\bdbstat\b|sqlite_stat\d|sqlite_sequence/i;
/** A catalogue name cut in two: a literal ending in `sqlite_`, or interpolating right after it. */
const FRAGMENT_RE = /sqlite_(\$\{|$)/i;
/** The WHOLE query is a probe of one table named exactly. */
const EXACT_NAME_PROBE_RE =
  /^SELECT \w+(, \w+)* FROM sqlite_(master|schema) WHERE type = 'table' AND name = (\?|'[^'%]+')$/i;

/**
 * Comments and string literals in one left-to-right pass, so a `//` inside a string and a quote inside
 * a comment are each read as what they are. Only the string literals are queries.
 */
const TOKEN_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/** A source line that is plainly a comment (JSDoc body, block opener, a line comment, or SQL's `--`). */
const COMMENT_LINE_RE = /^\s*(\*|\/\*|\/\/|--)/;

/**
 * The catalogue literals of one source text: each with its line and its query (whitespace collapsed),
 * plus `lost`, the code lines that name the catalogue outside any literal this scan read (FAIL-CLOSED:
 * a tokenizer slip can never hide a query inside something it misread as a comment).
 */
function scanText(text, file) {
  const sites = [];
  const lines = new Set();
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m[0].startsWith('/')) continue; // a comment
    // SQL line comments inside a literal (SCHEMA_SQL's prose) are blanked, offsets kept.
    const tok = m[0].replace(/--[^\n]*/g, (c) => ' '.repeat(c.length));
    const body = tok.slice(1, -1);
    // The code right around the literal (a small window: a query is never built further away).
    const before = text.slice(Math.max(0, m.index - 200), m.index).replace(/\s+$/, '');
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 200).replace(/^\s+/, '');
    // An operand of `+`: the literal is extended or cut, so the query that runs is not this text.
    const concatenated = before.endsWith('+') || after.startsWith('+');
    // A catalogue name cut anywhere and glued with `+` ('sqlite' + '_master'), or by interpolation.
    const loose = concatenated && (/sqlite_?$/i.test(body.trimEnd()) || /^_?(temp_)?(master|schema)\b/i.test(body.trimStart()));
    const fragment = FRAGMENT_RE.test(body.trimEnd()) || loose;
    if (!CATALOGUE_RE.test(tok) && !fragment) continue;
    // A template that interpolates: what runs is not this text either.
    const interpolated = tok.startsWith('`') && tok.includes('${');
    // FAIL-CLOSED (critic L-R3-2): a literal is the query that runs only when it is the SOLE argument
    // of `.prepare(` or `.pragma(` (a trailing comma allowed). An operand of `+` (with or without a
    // comment or parentheses around it), an object property, a constant: each puts something between
    // the literal and the call. This one rule replaces round 2's separate `+` and reused-constant rules.
    const soleArg = /\.(prepare|pragma)\(\s*$/.test(before) && /^,?\s*\)/.test(after);
    const at = tok.search(CATALOGUE_RE) === -1 ? 0 : tok.search(CATALOGUE_RE);
    const line = text.slice(0, m.index).split('\n').length + tok.slice(0, at).split('\n').length - 1;
    lines.add(line);
    sites.push({ file, line, query: body.replace(/\s+/g, ' ').trim(), fragment, interpolated, soleArg });
  }
  const lost = [];
  text.split('\n').forEach((l, i) => {
    if (CATALOGUE_RE.test(l) && !COMMENT_LINE_RE.test(l) && !lines.has(i + 1)) lost.push(`${file}:${i + 1}  ${l.trim()}`);
  });
  return { sites, lost };
}

/** `probe`, `allowlisted:<index>` or `offender`, for one site. */
function verdictOf(site) {
  // A template that fills text in (even a quoted name, which the probe shape would otherwise accept) is
  // never the query it looks like. (A cut catalogue name is recorded as a site by FRAGMENT_RE and the
  // loose rule, and is never the sole argument of the call, so the next rule reds it.)
  if (site.interpolated) return 'offender';
  // Only the sole argument of `.prepare(` / `.pragma(` can be a probe or an allowlisted query.
  if (site.soleArg !== true) return 'offender';
  if (EXACT_NAME_PROBE_RE.test(site.query)) return 'probe';
  const hit = ALLOWLIST.findIndex((a) => a.file === site.file && a.query === site.query);
  return hit === -1 ? 'offender' : `allowlisted:${hit}`;
}

function scanSrc() {
  const sites = [];
  const lost = [];
  for (const full of sourceFiles(srcRoot)) {
    const r = scanText(readFileSync(full, 'utf8'), relative(repoRoot, full).split('\\').join('/'));
    sites.push(...r.sites);
    lost.push(...r.lost);
  }
  return { sites, lost };
}

test('table chokepoint: every catalogue query in src/ is a whole-query one-table probe, an exact allowlisted query, or goes through tillTables', () => {
  const { sites, lost } = scanSrc();
  assert.deepEqual(lost, [], `catalogue references outside any string literal the scan could read:\n  ${lost.join('\n  ')}`);
  // Non-vacuity: the scan must actually see the catalogue queries it is policing.
  assert.ok(sites.length >= ALLOWLIST.length, `the scan found only ${sites.length} catalogue queries`);
  assert.ok(sites.some((s) => verdictOf(s) === 'probe'), 'the scan sees the one-table probes');

  const offenders = [];
  const used = new Set();
  for (const site of sites) {
    const v = verdictOf(site);
    if (v.startsWith('allowlisted:')) used.add(Number(v.slice('allowlisted:'.length)));
    if (v === 'offender') offenders.push(`${site.file}:${site.line}  ${site.query}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `These enumerate the tables of a book without the chokepoint. Call tillTables(db) from src/core/store/schemaShape.ts ` +
      `(or, when it is genuinely not a table enumeration for data handling, allowlist the WHOLE query here with the reason):\n  ${offenders.join('\n  ')}`,
  );

  const stale = ALLOWLIST.filter((_, i) => !used.has(i)).map((a) => `${a.file}: ${a.query}`);
  assert.deepEqual(stale, [], `allowlist entries that match no query any more (remove them):\n  ${stale.join('\n  ')}`);
});

/**
 * The eight bypasses the 14.10.2026 critic planted (all of which got through the first version of this
 * guard), two more shapes of the same kind, and one control. Scanned exactly as a src/ file would be.
 */
const PLANTED = `
import type Database from 'better-sqlite3';
export function bypasses(db: Database.Database): unknown[] {
  return [
    db.prepare("SELECT name FROM SQLITE_MASTER WHERE type = 'table'").all(),
    db.pragma('TABLE_LIST'),
    db.prepare("SELECT name FROM sqlite_temp_schema WHERE type = 'table'").all(),
    db.prepare('SELECT name FROM ' + 'sqlite_' + 'master').all(),
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? UNION SELECT name FROM sqlite_master WHERE type = 'table'").all('x'),
    db.prepare("SELECT name FROM sqlite_master WHERE NOT (type = 'table' AND name = ?)").all('x'),
    db.prepare("SELECT name FROM sqlite_master WHERE (type = 'table' AND name = ?) OR type = 'table'").all('x'),
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? IS NOT 1").all('x'),
    db.prepare(\`SELECT name FROM sqlite_\${'master'} WHERE type = 'table'\`).all(),
    db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' OR type = 'table'").all(),
  ];
}
export function control(db: Database.Database): unknown {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('journal_line');
}
`;

test('table chokepoint: the planted bypasses are each caught, and the one-table probe is not', () => {
  // Planted as if it were the Testmandant module, so the widened trigger query meets its allowlisted file.
  const { sites, lost } = scanText(PLANTED, 'src/core/migration/testmandant.ts');
  assert.deepEqual(lost, []);
  const verdicts = sites.map((s) => [s.line, verdictOf(s), s.query]);
  const caught = verdicts.filter(([, v]) => v === 'offender');
  const passed = verdicts.filter(([, v]) => v !== 'offender');
  // Lines 5..14 are the ten bypasses (the concatenation yields one fragment site on its line).
  assert.deepEqual(
    [...new Set(caught.map(([line]) => line))],
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    `every planted bypass line must red the guard:\n${verdicts.map((v) => v.join('  ')).join('\n')}`,
  );
  assert.deepEqual(passed.map(([line, v]) => [line, v]), [[18, 'probe']], 'only the control passes, as a probe');
});

/**
 * The shapes the round-2 critic planted that still got through (L-R2-1). Each line marked BYPASS must
 * red the guard; the line marked CONTROL is an inline probe, which must not.
 */
const PLANTED_R2 = `
import type Database from 'better-sqlite3';
const PROBE_A = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"; // BYPASS: glued below
const PROBE_B = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"; // BYPASS: wrapped below
export function bypasses(db: Database.Database, x: string): unknown[] {
  return [
    db.prepare(PROBE_A + " OR type = 'table'").all('x'),
    db.prepare(\`\${PROBE_B} UNION SELECT name FROM \${x}\`).all('x'),
    db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'" + " OR type = 'table'").all(), // BYPASS
    db.prepare('SELECT name FROM sqlite' + '_master').all(), // BYPASS
    db.prepare('SELECT DISTINCT name FROM dbstat').all(), // BYPASS
    db.prepare('SELECT tbl FROM sqlite_stat1').all(), // BYPASS
  ];
}
export function control(db: Database.Database): unknown {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('journal_line'); // CONTROL
}
`;

test('table chokepoint: glued, wrapped and dbstat shapes are caught, and an inline probe is not (critic L-R2-1)', () => {
  const { sites, lost } = scanText(PLANTED_R2, 'src/core/migration/testmandant.ts');
  assert.deepEqual(lost, []);
  const marked = (tag) =>
    PLANTED_R2.split('\n')
      .map((l, i) => (l.includes(`// ${tag}`) ? i + 1 : null))
      .filter((n) => n !== null);
  const verdicts = sites.map((s) => [s.line, verdictOf(s), s.query]);
  const caught = [...new Set(verdicts.filter(([, v]) => v === 'offender').map(([line]) => line))].sort((a, b) => a - b);
  assert.deepEqual(caught, marked('BYPASS'), `every BYPASS line must red the guard:\n${verdicts.map((v) => v.join('  ')).join('\n')}`);
  assert.deepEqual(
    verdicts.filter(([, v]) => v !== 'offender').map(([line, v]) => [line, v]),
    marked('CONTROL').map((line) => [line, 'probe']),
    'only the control passes, as a probe',
  );
});

/**
 * The shapes the round-3 critic planted that still got through (L-R3-2), and the one shape only the
 * `interpolated` rule catches (a quoted name filled in by interpolation reads as a probe otherwise).
 */
const PLANTED_R3 = `
import type Database from 'better-sqlite3';
export function bypasses(db: Database.Database, t: string): unknown[] {
  const Q = { probe: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?" }; // BYPASS: an object property
  return [
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?" /* widen */ + " OR type = 'table'").all('x'), // BYPASS
    db.prepare(("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?") + " OR type = 'table'").all('x'), // BYPASS
    db.prepare(Q.probe + " OR type = 'table'").all('x'),
    db.prepare(\`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '\${t}'\`).all(), // BYPASS
    db.prepare('SELECT name FROM sqlite_sequence').all(), // BYPASS
  ];
}
export function control(db: Database.Database): unknown {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('journal_line'); // CONTROL
}
`;

test('table chokepoint: only the sole argument of .prepare( or .pragma( can pass, and an interpolated name never does (critic L-R3-2)', () => {
  const { sites, lost } = scanText(PLANTED_R3, 'src/core/migration/testmandant.ts');
  assert.deepEqual(lost, []);
  const marked = (tag) =>
    PLANTED_R3.split('\n')
      .map((l, i) => (l.includes(`// ${tag}`) ? i + 1 : null))
      .filter((n) => n !== null);
  const verdicts = sites.map((s) => [s.line, verdictOf(s), s.query]);
  const caught = [...new Set(verdicts.filter(([, v]) => v === 'offender').map(([line]) => line))].sort((a, b) => a - b);
  assert.deepEqual(caught, marked('BYPASS'), `every BYPASS line must red the guard:\n${verdicts.map((v) => v.join('  ')).join('\n')}`);
  assert.deepEqual(
    verdicts.filter(([, v]) => v !== 'offender').map(([line, v]) => [line, v]),
    marked('CONTROL').map((line) => [line, 'probe']),
    'only the control (the sole argument) passes, as a probe',
  );
});

test('table chokepoint: the allowlist is matched by the whole query, never a substring of it', () => {
  const allowed = ALLOWLIST[6];
  const site = (file, query) => ({ file, query, fragment: false, soleArg: true });
  assert.equal(verdictOf(site(allowed.file, allowed.query)), 'allowlisted:6');
  assert.equal(verdictOf(site(allowed.file, `${allowed.query} OR type = 'table'`)), 'offender');
  assert.equal(verdictOf(site('src/core/elsewhere.ts', allowed.query)), 'offender', 'the entry is bound to its file');
  assert.equal(verdictOf({ ...site(allowed.file, allowed.query), soleArg: false }), 'offender', 'and to being the sole argument of the call');
});

test('table chokepoint: the schema shape exposes no way to list a tool table', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE account (id TEXT PRIMARY KEY); CREATE TABLE _tool_state (id TEXT PRIMARY KEY, workspace_id TEXT)');
    // Whatever a caller passes, the exported shape is TILL's (the whole-file shape stays module-private,
    // for `fingerprintMatches` alone).
    assert.deepEqual(Object.keys(schemaShape.schemaShapeOf(db, { includeForeignTables: true })), ['account']);
    assert.deepEqual(schemaShape.tillTables(db), ['account']);
    const exported = Object.keys(schemaShape).sort();
    assert.deepEqual(
      exported.filter((name) => !['copySchemaDdl', 'fingerprintMatches', 'isEmptyGap', 'isTillTable', 'schemaFingerprint', 'schemaShapeOf', 'shapeGap', 'tillTables'].includes(name)),
      [],
      'no other export of schemaShape.ts (a whole-file lister would be a way around the chokepoint)',
    );
  } finally {
    db.close();
  }
});
