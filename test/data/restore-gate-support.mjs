/**
 * The LIST-FREE restore gate's scanner (spec G04 §0c item 5), shared by the gate suite and the A31
 * capture suite. It asserts the OUTCOME of a restore, never a list of places to look: every TEXT value
 * of every row the restore wrote is split into id-shaped tokens, and a token that is a SOURCE
 * surrogate id is a leak, whatever the column is called and wherever in the value it sits.
 *
 * It is deliberately STRICTER than the chokepoint it checks. The chokepoint rewrites a whole value or
 * a whole JSON string; this scan also flags an id inside a comma list, a composite key or a sentence.
 * So a NEW form of reference (a delimited list of ids, an id baked into a derived key) fails the gate
 * instead of slipping past a chokepoint that was never taught it, and forces a decision.
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';

import { restoreLoadTables, workspaceRowsWhere } from '../../dist/core/data/portability.js';
import { NATURAL_KEY_COLUMNS } from '../../dist/core/data/idRemap.js';

/** Characters an id is made of (`<prefix>_<uuid>`, `<prefix>_<n>`); anything else separates tokens. */
const TOKEN_SPLIT = /[^A-Za-z0-9_-]+/;

/** The single-column surrogate primary key of a table (`id`), or undefined. */
function surrogatePk(db, table) {
  const pks = db.pragma(`table_info("${table}")`).filter((c) => c.pk > 0);
  return pks.length === 1 && pks[0].name === 'id' ? 'id' : undefined;
}

/**
 * Every source id a restore of this backup re-mints, mapped to its table: the workspace id, every
 * surrogate id of every table the restore loads, and every audit row id. Read from the BACKUP itself,
 * so the set is exactly what the restore had to move.
 */
export function sourceIdsOfBackup(artifactRef) {
  const snap = new Database(join(artifactRef, 'data.sqlite'), { readonly: true });
  try {
    const ws = snap.prepare('SELECT id FROM "workspace"').get().id;
    const ids = new Map([[ws, 'workspace']]);
    for (const table of [...restoreLoadTables(snap), 'audit_log']) {
      if (surrogatePk(snap, table) === undefined) continue;
      for (const r of snap.prepare(`SELECT id FROM "${table}"`).all()) ids.set(String(r.id), table);
    }
    return ids;
  } finally {
    snap.close();
  }
}

/** Every source id in a whole database file (an env_copy source: every workspace it holds). */
export function sourceIdsOfDatabase(db) {
  const ids = new Map();
  for (const { id } of db.prepare('SELECT id FROM "workspace"').all()) ids.set(String(id), 'workspace');
  for (const table of [...restoreLoadTables(db), 'audit_log']) {
    if (surrogatePk(db, table) === undefined) continue;
    for (const r of db.prepare(`SELECT id FROM "${table}"`).all()) ids.set(String(r.id), table);
  }
  return ids;
}

/**
 * The leaks in one text value: the whole value, every id-shaped token, and every hyphen-joined run
 * inside a token that has the minted shape `<prefix>_<suffix>` (an id glued to a label with a hyphen,
 * `INV-<id>`). The scan must be at least as strict as the chokepoint everywhere, and stricter on prose.
 */
function leaksIn(value, sourceIds) {
  const found = new Set();
  if (sourceIds.has(value)) found.add(value);
  for (const token of value.split(TOKEN_SPLIT)) {
    if (token.length === 0) continue;
    if (sourceIds.has(token)) found.add(token);
    if (!token.includes('-')) continue;
    const parts = token.split('-');
    for (let i = 0; i < parts.length; i += 1) {
      for (let j = i; j < parts.length; j += 1) {
        const run = parts.slice(i, j + 1).join('-');
        if (run.includes('_') && sourceIds.has(run)) found.add(run);
      }
    }
  }
  return [...found];
}

/**
 * One leak: the `table.column` it sits in, the full value, the source id it names and that id's table.
 * `formatLeaks` turns a list into readable lines for an assertion message.
 */
function leak(key, value, id, sourceIds) {
  return { key, value, id, sourceTable: sourceIds.get(id) };
}

export function formatLeaks(leaks, max = 40) {
  return leaks
    .slice(0, max)
    .map((l) => `${l.key} = ${JSON.stringify(l.value).slice(0, 160)} (names source ${l.sourceTable} ${l.id})`)
    .join('\n');
}

/**
 * Scan the rows a restore wrote for `wsId` (every table the restore loads, plus the audit log) and
 * return one entry per leak (see `leak`). `exempt` maps a `table.column` to the reason the gate
 * tolerates a source token there; `NATURAL_KEY_COLUMNS` is always exempt (the chokepoint's own
 * allowlist).
 */
export function scanRestoredWorkspace(db, wsId, sourceIds, exempt = {}) {
  const leaks = [];
  const tables = [...restoreLoadTables(db), 'audit_log', 'audit_head'];
  for (const table of tables) {
    const cols = db.pragma(`table_info("${table}")`).map((c) => c.name);
    const where = workspaceRowsWhere(db, table, wsId);
    for (const row of db.prepare(`SELECT * FROM "${table}" WHERE ${where.clause}`).all(...where.params)) {
      for (const col of cols) {
        const v = row[col];
        if (typeof v !== 'string') continue;
        const key = `${table}.${col}`;
        if (NATURAL_KEY_COLUMNS[key] !== undefined || exempt[key] !== undefined) continue;
        for (const id of leaksIn(v, sourceIds)) leaks.push(leak(key, v, id, sourceIds));
      }
    }
  }
  return leaks;
}

/** The same scan over EVERY row of a whole database file (an env_copy target holds only copies). */
export function scanWholeDatabase(db, sourceIds, exempt = {}) {
  const leaks = [];
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const table of tables) {
    const cols = db.pragma(`table_info("${table}")`).map((c) => c.name);
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
      for (const col of cols) {
        const v = row[col];
        if (typeof v !== 'string') continue;
        const key = `${table}.${col}`;
        if (NATURAL_KEY_COLUMNS[key] !== undefined || exempt[key] !== undefined) continue;
        for (const id of leaksIn(v, sourceIds)) leaks.push(leak(key, v, id, sourceIds));
      }
    }
  }
  return leaks;
}

/** Row counts per table for `wsId` (the coverage a world reached, reported by the gate). */
export function populatedTables(db, wsId) {
  const out = {};
  for (const table of [...restoreLoadTables(db), 'audit_log']) {
    const where = workspaceRowsWhere(db, table, wsId);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where.clause}`).get(...where.params).n;
    if (n > 0) out[table] = n;
  }
  return out;
}
