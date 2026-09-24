/**
 * The three money-path invariant DETECTORS (D85), extracted so they have exactly one definition.
 *
 * `conformance.test.mjs` rules 10 to 12 drive these over every write verb in `ACTIONS`.
 * `invariant-mutation.test.mjs` drives the SAME functions over deliberately corrupted stores and
 * proves each one goes red. That shared definition is the point: a mutation test written against a
 * copy of the detector proves the copy works and says nothing about the gate. Two callers, one
 * implementation, so "the detector bites" and "the gate uses the detector that bites" are the same
 * fact rather than two hopes.
 *
 * Each detector returns an array of human-readable violations, empty when the invariant holds.
 *
 * WHAT IS NOT HERE, and why. CLAUDE.md names five invariants. Idempotency-on-rows is conformance
 * rule 8, which already calls every write verb twice and diffs the database row by row. Balance
 * (debits equal credits) is structural in `postEntry.ts`, the single door every posting verb goes
 * through, so it cannot be violated by a capability and a detector could only re-observe the
 * impossible. Restating either here would buy a second copy, not a second guarantee.
 */

/** Every table carrying a `workspace_id` column, so a tenant filter can be written generically. */
export function tenantTables(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  return tables.filter((t) =>
    store.db.prepare(`PRAGMA table_info("${t}")`).all().some((col) => col.name === 'workspace_id'),
  );
}

/** Every row belonging to ONE tenant, across every table that scopes by tenant, as a comparable string. */
export function tenantSnapshot(store, workspaceId) {
  const out = {};
  for (const t of tenantTables(store)) {
    out[t] = store.db.prepare(`SELECT * FROM "${t}" WHERE workspace_id = ? ORDER BY rowid`).all(workspaceId);
  }
  return JSON.stringify(out);
}

/**
 * Posted entries and their lines, keyed by id.
 *
 * Keyed rather than snapshotted whole, because that is what distinguishes a MUTATION from an
 * INSERT. Append-only forbids the first and is the entire mechanism behind the second: a snapshot
 * comparison would report a legitimate new entry as a change and be useless.
 */
export function postedRows(store) {
  const entries = store.db.prepare("SELECT * FROM journal_entry WHERE status = 'posted'").all();
  const byId = {};
  for (const e of entries) {
    const lines = store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ? ORDER BY id').all(e.id);
    byId[e.id] = JSON.stringify({ entry: e, lines });
  }
  return byId;
}

/** APPEND-ONLY: no posted entry that existed in `before` may have been changed or removed. */
export function appendOnlyViolations(before, after) {
  const out = [];
  for (const [id, row] of Object.entries(before)) {
    if (after[id] === undefined) {
      out.push(`DELETED posted entry ${id}; a posted entry is immutable`);
    } else if (after[id] !== row) {
      out.push(`MUTATED posted entry ${id}; a correction must be a reversing entry, never an edit`);
    }
  }
  return out;
}

/**
 * REVERSAL SYMMETRY: every entry carrying `reverses_entry_id` exactly negates what it reverses.
 *
 * Derived from the DATA rather than from verb names. Any entry with that column set is a reversal,
 * however it was produced, so a capability that invents its own reversal path is covered without
 * anyone knowing the path exists. Name-matching on `reverse_*` could never do that.
 *
 * The measure is net movement per account in BASE minor units over the original and its reversal
 * together. A true reversal sums every account back to zero. A partial one, a re-signed one, or one
 * that reverses at a different FX rate does not.
 */
export function reversalViolations(store) {
  const out = [];
  const reversals = store.db
    .prepare('SELECT id, reverses_entry_id FROM journal_entry WHERE reverses_entry_id IS NOT NULL')
    .all();
  for (const r of reversals) {
    const net = new Map();
    for (const which of [r.reverses_entry_id, r.id]) {
      for (const l of store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ?').all(which)) {
        net.set(l.account_id, (net.get(l.account_id) ?? 0) + l.base_debit_minor - l.base_credit_minor);
      }
    }
    const offending = [...net.entries()].filter(([, sum]) => sum !== 0);
    if (offending.length > 0) {
      out.push(
        `reversal ${r.id} does NOT negate ${r.reverses_entry_id}; accounts left moved: ` +
          offending.map(([acc, sum]) => `${acc}=${sum}`).join(', '),
      );
    }
  }
  return out;
}

/** §H-TENANT: tenant A's rows are byte-identical before and after whatever was done as tenant B. */
export function tenantViolations(before, after, label) {
  return before === after ? [] : [`${label}: a call made AS another tenant changed this tenant's rows`];
}
