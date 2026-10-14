/**
 * A SQL TRACE for the structural pin test (critic N1 round 2): which tables a verb READS and which it
 * WRITES while it runs, observed on the driver itself rather than declared by hand.
 *
 * The store's write chokepoint looks up the driver's statement methods on the prototype at CALL time
 * (`driverMethod` in `src/core/store/sqlite-store.ts`), so wrapping the prototype sees every statement,
 * including ones a module prepared once and cached. The table names are read off the SQL text: every
 * identifier after FROM or JOIN is a read, every target of INSERT, UPDATE, DELETE or REPLACE is a write.
 * Common-table-expression names are dropped, since they are not tables.
 */

/** @type {{ reads: Set<string>, writes: Set<string>, mutates: Set<string>, readSql: Map<string, Set<string>>, mutateSql: Map<string, Set<string>> } | null} */
let active = null;
let installed = false;

const READ = /\b(?:FROM|JOIN)\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi;
const WRITE = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi;
const CTE = /\b(?:WITH(?:\s+RECURSIVE)?|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s+AS\s*\(/gi;
const NOT_TABLES = new Set(['json_each', 'json_tree', 'pragma_table_info', 'sqlite_master', 'sqlite_schema', 'select', 'values', 'set']);
/** A write that can change a row already there: UPDATE, DELETE, REPLACE, or an INSERT that upserts. */
const MUTATES = /^\s*(?:UPDATE|DELETE|REPLACE|INSERT\s+OR\s+REPLACE)\b|\bON\s+CONFLICT\b[^;]*\bDO\s+UPDATE\b/i;

/** The tables one SQL text reads and writes. */
export function tablesOf(sql) {
  const ctes = new Set([...sql.matchAll(CTE)].map((m) => m[1].toLowerCase()));
  const keep = (name) => !ctes.has(name) && !NOT_TABLES.has(name);
  const writes = [...sql.matchAll(WRITE)].map((m) => m[1].toLowerCase()).filter(keep);
  const forReads = sql.replace(/\bDELETE\s+FROM\s+["`]?[A-Za-z_][A-Za-z0-9_]*["`]?/gi, ' ');
  const reads = [...forReads.matchAll(READ)].map((m) => m[1].toLowerCase()).filter(keep);
  return { reads, writes, mutates: MUTATES.test(sql) ? writes : [] };
}

/** Wrap the driver's statement prototype once (idempotent), reached through any open connection. */
function install(db) {
  if (installed) return;
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1'));
  for (const name of ['run', 'get', 'all', 'iterate']) {
    const original = proto[name];
    proto[name] = function traced(...params) {
      if (active !== null) {
        const { reads, writes, mutates } = tablesOf(String(this.source));
        // The statement text per table, so a column-scoped classification can ask WHICH columns.
        const sql = String(this.source);
        for (const t of reads) {
          active.reads.add(t);
          if (!active.readSql.has(t)) active.readSql.set(t, new Set());
          active.readSql.get(t).add(sql);
        }
        for (const t of writes) active.writes.add(t);
        for (const t of mutates) {
          active.mutates.add(t);
          if (!active.mutateSql.has(t)) active.mutateSql.set(t, new Set());
          active.mutateSql.get(t).add(sql);
        }
      }
      return original.apply(this, params);
    };
  }
  installed = true;
}

/**
 * Run `fn` and answer the tables it read, wrote, and MUTATED (changed rows that were already there) on
 * `db` (and on any other connection meanwhile), with the statement text per table read and mutated.
 */
export function traceTables(db, fn) {
  install(db);
  const previous = active;
  active = { reads: new Set(), writes: new Set(), mutates: new Set(), readSql: new Map(), mutateSql: new Map() };
  try {
    const result = fn();
    return { result, reads: active.reads, writes: active.writes, mutates: active.mutates, readSql: active.readSql, mutateSql: active.mutateSql };
  } finally {
    active = previous;
  }
}
