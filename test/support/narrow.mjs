// @ts-check
/**
 * Runtime-checked narrowing at the two boundaries where the root suites receive `unknown`.
 *
 * BOUNDARY ONE, raw sqlite. The suites reach past the engine into the database constantly, and they
 * are right to: "the row the ledger actually wrote" is the only honest witness for append-only
 * posting, for idempotency, and for the FX stamping. But `Statement.get()` is typed `unknown` and
 * `Statement.all()` is typed `unknown[]`.
 *
 * BOUNDARY TWO, and this one is a finding rather than a fact of life: THE ENGINE'S OWN SUCCESS
 * PAYLOAD. `src/core/result.ts` used to declare `Ok` as one open shape, `{ readonly ok: true;
 * readonly [key: string]: unknown }`, and every declared verb returned it with not one narrowing it.
 * So `postEntry(...).entryId`, `createWorkspace(...).workspaceId` and every other field any verb has
 * ever returned were `unknown` to every consumer: these suites, the MCP layer, and the Studio alike.
 * Nothing in the type system said what a verb returns, which is precisely why "the Studio assumed a
 * shape the engine never sends" kept happening.
 *
 * `Ok<T>` / `Result<T>` now let a verb DECLARE its payload, and `postEntry` is the first that does
 * (`Result<PostEntryOk>`). That is a per-verb conversion, so this boundary is closing one verb at a
 * time and everything below still has to work for both halves: `okOf` passes a declared payload
 * through and hands back the same open `Ok` for a verb that has not declared one yet. Against an
 * undeclared verb these runtime narrowers remain the only thing pinning the payload at all.
 *
 * WHY NARROWERS AND NOT CASTS. The cheap answer to both boundaries is a JSDoc cast,
 * `/** @type {{bal: number}} *\/ (stmt.get(...))`. It is the `as unknown as` of JSDoc: it asserts a
 * shape and checks nothing, so a column renamed in a migration reads as `undefined` at runtime while
 * the compiler reports a clean bill of health. That is the failure the app's quarantine was hiding,
 * rebuilt by hand.
 *
 * So these narrow with a RUNTIME check and THROW, the way `app/src/lib/test-support.ts`'s
 * `recordedOk()` does. A row that is not there, a payload field the engine stopped sending, or a
 * column that came back with the wrong kind, fails at the assertion that depended on it WITH THE
 * FIELD NAMED, instead of silently comparing `undefined` to `undefined` and passing. Against an
 * engine whose success payload is untyped, that runtime check is not a workaround for the type
 * checker: it is the only thing actually pinning the payload at all.
 */

/**
 * A value the suite believes is present. The generic one, for anything already typed.
 *
 * The motivating case is `getAction(name)`, declared `ActionDef | undefined` and called 69 times
 * across 27 suites. A suite naming an action that does not exist currently dies on "Cannot read
 * properties of undefined (reading 'run')", which names neither the action nor the suite's
 * intention. This says which one was missing.
 *
 * @template T
 * @param {T | undefined | null} value
 * @param {string} what
 * @returns {T}
 */
export function defined(value, what) {
  if (value === undefined || value === null) throw new Error(`${what}: expected to be present, got ${show(value)}`);
  return value;
}

/**
 * An element the suite believes is there: `at(rows, 1, 'the audit chain')`.
 *
 * `noUncheckedIndexedAccess` makes `rows[1]` a `T | undefined`, and it is right to: an assertion on
 * `rows[1].prev_hash` where the query returned one row is not a failing assertion, it is a
 * TypeError with no mention of the chain. This says which index was missing and how long the list
 * actually was, which is the fact the assertion was reaching for anyway.
 *
 * @template T
 * @param {readonly T[]} list
 * @param {number} index
 * @param {string} [what]
 * @returns {T}
 */
export function at(list, index, what = 'list') {
  const value = list[index];
  if (value === undefined) throw new Error(`${what}: no element at index ${index}, length is ${list.length}`);
  return value;
}

/** @param {unknown} v */
function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return `${v}n`;
  if (v === null || v === undefined || typeof v !== 'object') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

/**
 * One row that must exist. Use for `SELECT ... WHERE id = ?` where the suite's whole point is that
 * the row is there.
 *
 * @param {unknown} value the result of `stmt.get(...)`
 * @param {string} [what] what was being read, for the failure message
 * @returns {Record<string, unknown>}
 */
export function row(value, what = 'row') {
  if (value === undefined) throw new TypeError(`${what}: no row came back, the query matched nothing`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${what}: expected a row object, got ${show(value)}`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * One row that may be absent. Use where absence is the thing under test.
 *
 * @param {unknown} value
 * @param {string} [what]
 * @returns {Record<string, unknown> | undefined}
 */
export function maybeRow(value, what = 'row') {
  if (value === undefined || value === null) return undefined;
  return row(value, what);
}

/**
 * Every row of a `stmt.all(...)`.
 *
 * @param {unknown} value
 * @param {string} [what]
 * @returns {Record<string, unknown>[]}
 */
export function rows(value, what = 'rows') {
  if (!Array.isArray(value)) throw new TypeError(`${what}: expected an array of rows, got ${show(value)}`);
  return value.map((r, i) => row(r, `${what}[${i}]`));
}

/**
 * A TEXT column. Rejects `null`, which is the point: `str(row.currency)` says the suite believes the
 * column is populated, and finds out here if it is not.
 *
 * @param {unknown} value
 * @param {string} [what]
 * @returns {string}
 */
export function str(value, what = 'value') {
  if (typeof value !== 'string') throw new TypeError(`${what}: expected a string, got ${show(value)}`);
  return value;
}

/**
 * A nullable TEXT column, where NULL is a meaningful state (an unset `fx_rate`, an open period).
 *
 * @param {unknown} value
 * @param {string} [what]
 * @returns {string | null}
 */
export function strOrNull(value, what = 'value') {
  if (value === null) return null;
  return str(value, what);
}

/**
 * An INTEGER or REAL column. Rejects `bigint` deliberately: this codebase holds money in Rappen as
 * JS numbers, and a column that starts arriving as `bigint` is a schema change the suite must see.
 *
 * @param {unknown} value
 * @param {string} [what]
 * @returns {number}
 */
export function num(value, what = 'value') {
  if (typeof value !== 'number') throw new TypeError(`${what}: expected a number, got ${show(value)}`);
  return value;
}

/**
 * A nullable numeric column.
 *
 * @param {unknown} value
 * @param {string} [what]
 * @returns {number | null}
 */
export function numOrNull(value, what = 'value') {
  if (value === null) return null;
  return num(value, what);
}

/**
 * One TEXT column of one row that must exist: `strCol(stmt.get(id), 'base_currency')`.
 *
 * The `SELECT one column WHERE id = ?` read is the single commonest shape in these suites, and
 * spelling it out as `str(row(stmt.get(id), ...).base_currency, ...)` at every site buries the
 * question being asked.
 *
 * @param {unknown} value the result of `stmt.get(...)`
 * @param {string} name the column
 * @param {string} [what] the query, for the failure message
 * @returns {string}
 */
export function strCol(value, name, what = 'row') {
  return str(row(value, what)[name], `${what}.${name}`);
}

/**
 * One numeric column of one row that must exist. Counts, sums and Rappen.
 *
 * @param {unknown} value
 * @param {string} name
 * @param {string} [what]
 * @returns {number}
 */
export function numCol(value, name, what = 'row') {
  return num(row(value, what)[name], `${what}.${name}`);
}

/**
 * `SELECT COUNT(*) AS c ...`, the single most repeated read in these suites (62 sites) and the one
 * that most often carries the whole assertion: "nothing was written", "exactly one entry", "the
 * replay did not post a second close".
 *
 * The alias must be `c`, which is what every existing call already spells.
 *
 * @param {import('better-sqlite3').Database} db usually `store.db`
 * @param {string} sql
 * @param {...(string | number | bigint | null)} params
 * @returns {number}
 */
export function countOf(db, sql, ...params) {
  return num(row(db.prepare(sql).get(...params), sql).c, `${sql}: the c column`);
}

/**
 * A boolean-ish column. sqlite has no BOOLEAN, so 0/1 is the honest storage and both spellings are
 * accepted here; anything else is a schema surprise the suite should hear about.
 *
 * @param {unknown} value
 * @param {string} [what]
 * @returns {boolean}
 */
export function bool(value, what = 'value') {
  if (typeof value === 'boolean') return value;
  if (value === 0) return false;
  if (value === 1) return true;
  throw new TypeError(`${what}: expected a boolean or 0/1, got ${show(value)}`);
}

/**
 * An object-valued field of an engine payload: `obj(res.entry).lines`, where `res.entry` is
 * `unknown` because `Ok` has an index signature and nothing more.
 *
 * The same check as `row`, under the name that reads correctly away from sqlite.
 *
 * @param {unknown} value
 * @param {string} [what]
 * @returns {Record<string, unknown>}
 */
export function obj(value, what = 'object') {
  return row(value, what);
}

/**
 * An array-valued field of an engine payload, each element narrowed to an object.
 *
 * @param {unknown} value
 * @param {string} [what]
 * @returns {Record<string, unknown>[]}
 */
export function objs(value, what = 'array') {
  return rows(value, what);
}

/**
 * An array-valued field whose elements are NOT objects (ids, codes, numbers).
 *
 * @param {unknown} value
 * @param {string} [what]
 * @returns {unknown[]}
 */
export function arr(value, what = 'array') {
  if (!Array.isArray(value)) throw new TypeError(`${what}: expected an array, got ${show(value)}`);
  return value;
}

/**
 * The success branch of an engine `Result`, with the rejection's own error code in the failure
 * message. Replaces `assert.ok(res.ok, JSON.stringify(res))` where the suite then reads fields off
 * the payload: this narrows the union so `res.error` is gone, and reports WHICH rejection came back.
 *
 * It PASSES THE PAYLOAD THROUGH. For the verbs that still return the open `Ok` that is `unknown` per
 * field, exactly as the header describes, and `str`/`num`/`obj` are the way to read one. For a verb
 * that has declared its payload (`postEntry` is the first, `Result<PostEntryOk>`) the declaration
 * survives the narrowing, so `okOf(posted, 'postEntry').entryId` is a `string` here and a renamed
 * field is TS2339 in this file. Passing it through is the whole reason this is generic: a narrower
 * that returned the bare `Ok` would throw the declaration away at the door.
 *
 * @template {import('../../dist/core/result.js').OkFields} T
 * @param {import('../../dist/core/result.js').Result<T>} result
 * @param {string} [what]
 * @returns {import('../../dist/core/result.js').Ok<T>}
 */
export function okOf(result, what = 'verb') {
  if (!result.ok) throw new Error(`${what} was rejected: ${result.error} ${show(result)}`);
  return result;
}

/**
 * A string id off an engine payload: `id(posted, 'entryId')`.
 *
 * By far the most common read in these suites, and the one the untyped `Ok` costs the most: an
 * `entryId` the engine stopped returning would flow on as `undefined` and be handed to the next verb
 * as an entry id, which then fails somewhere with no mention of where the `undefined` came from.
 * This asserts the success branch AND the field in one place, naming the verb.
 *
 * The field is a STRING, which is the one place a renamed payload could still slip past a declared
 * verb: `id(posted, 'entryId')` is not a property access, so TS2339 has nothing to fire on. Keying
 * `K` to `keyof T` closes that. For a verb that has declared its payload, a suite naming a field it
 * does not carry is TS2345 HERE, at the call site, in all 48 of these reads. For a verb that has
 * not, `keyof Record<string, unknown>` is `string` and nothing changes.
 *
 * @template {import('../../dist/core/result.js').OkFields} T
 * @template {keyof T & string} K
 * @param {import('../../dist/core/result.js').Result<T>} result
 * @param {K} field
 * @param {string} [what] the verb, for the failure message
 * @returns {string}
 */
export function id(result, field, what = 'verb') {
  return str(okOf(result, what)[field], `${what}.${field}`);
}

/**
 * The rejection branch, for the suites whose subject IS the refusal.
 *
 * Once a verb declares its success payload this stops being optional. `blocked.error` off an
 * un-narrowed `Result<PostEntryOk>` is TS2339, because the success half no longer carries an index
 * signature that answers for every field. That is the check working: a suite reading a rejection
 * code has to prove the call WAS rejected first, and if it succeeded instead, this says so with the
 * payload rather than comparing `undefined` to the expected code.
 *
 * @template {import('../../dist/core/result.js').OkFields} T
 * @param {import('../../dist/core/result.js').Result<T>} result
 * @param {string} [what]
 * @returns {import('../../dist/core/result.js').Err}
 */
export function errOf(result, what = 'verb') {
  if (result.ok) throw new Error(`${what} was expected to be rejected, but it succeeded: ${show(result)}`);
  return result;
}
