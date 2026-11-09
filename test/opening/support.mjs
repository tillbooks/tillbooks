// Test support for the A04 suites (opening balances, migration import).
//
// It wires the REAL A03 ports through `ledgerPorts` and mints a real workspace through A00
// `createWorkspace`, so the KMU chart is the shipped one and a post honours period locks and stamps
// the hash-chained audit log. Nothing about an opening entry is faked: an opening position written
// straight into a table would not reconcile against the ledger and every §H-LEDGER claim about it
// would be empty.
//
// TWO THINGS THIS FIXTURE DOES NOT DO, both deliberate:
//
//  1. **It does not hand-add any account to the chart except 9100.** Eight hand-written fixture
//     account names were wrong in this repo recently while every `type` still matched, so the
//     assertions below read VALUES (names, numbers) out of the shipped seed rather than restating
//     them.
//  2. **9100 Eröffnungsbilanz is created explicitly, by A01's public verb, per test.** It is NOT in
//     A01's shipped KMU seed. A19 already resolves it by NUMBER and refuses with `needs_account`
//     when it is missing, and A04 keeps that contract rather than inventing the account, so
//     `seedOpeningContraAccount` opts a fixture in and the missing-account path stays testable by
//     simply not calling it.

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { createAccount } from '../../dist/core/accounts/index.js';

export const AT = '2026-07-19T00:00:00.000Z';

/**
 * A fresh store with one workspace (KMU chart seeded), a context wired with the real A03 ports, and
 * a `byNumber` map from account number to id.
 *
 * `store`, `clock` and `ids` come back too, because a §H-TENANT claim only means something when the
 * SECOND workspace lives in the SAME database: two separate stores would prove nothing about
 * scoping, and both would be minted `ws_1` by the fresh id sequence, which is how a tenant test
 * passes while enforcing nothing.
 */
export function setup({ fiscalYearStart = '01-01', actor = 'user_1', ctxOverrides = {} } = {}) {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  const ids = sequenceIdGen();
  const clock = fixedClock(AT);
  const deps = { store, clock, ids };

  const minted = createWorkspace(deps, { name: 'Acme GmbH', fiscalYearStart });
  if (!minted.ok) throw new Error(`createWorkspace failed: ${JSON.stringify(minted)}`);
  const workspaceId = minted.workspaceId;

  const ctx = makeContext(store, {
    workspaceId,
    actor,
    clock,
    ids,
    ...ledgerPorts({ store, workspaceId, ids }),
    ...ctxOverrides,
  });

  return { store, deps, ctx, workspaceId, ids, clock, byNumber: numbersOf(store, workspaceId) };
}

/** Account number to id, for one workspace. Re-read after `createAccount` adds one. */
export function numbersOf(store, workspaceId) {
  const map = {};
  for (const r of store.db.prepare('SELECT number, id FROM account WHERE workspace_id = ?').all(workspaceId)) {
    map[r.number] = r.id;
  }
  return map;
}

/**
 * A SECOND workspace inside the SAME database. Callers mint it FIRST, before the workspace under
 * test, and that ordering is the whole point: a neutralised `workspace_id` filter on a `.get()`
 * degenerates to "the first row that matches the rest of the WHERE clause", so a neighbour minted
 * SECOND would let a broken query pass by accident.
 */
export function neighbourWorkspace(deps, { name = 'Nachbar AG', actor = 'user_2', fiscalYearStart = '01-01' } = {}) {
  const minted = createWorkspace(deps, { name, fiscalYearStart });
  if (!minted.ok) throw new Error(`createWorkspace failed: ${JSON.stringify(minted)}`);
  const workspaceId = minted.workspaceId;
  const ctx = makeContext(deps.store, {
    workspaceId,
    actor,
    clock: deps.clock,
    ids: deps.ids,
    ...ledgerPorts({ store: deps.store, workspaceId, ids: deps.ids }),
  });
  return { ctx, workspaceId, byNumber: numbersOf(deps.store, workspaceId) };
}

/**
 * Create 9100 Eröffnungsbilanz through A01's public verb, returning its id.
 *
 * `equity` is the type A19's own conformance scenario uses for the same account, so the two
 * capabilities that book against 9100 agree on what it is.
 */
export function seedOpeningContraAccount(ctx, { number = '9100', name = 'Eröffnungsbilanz', type = 'equity' } = {}) {
  const created = createAccount(ctx, { number, name, type, idempotencyKey: `seed-${number}` });
  if (!created.ok) throw new Error(`createAccount failed: ${JSON.stringify(created)}`);
  return created.accountId;
}

/** Every journal line of an entry as `{ number, debit, credit }`, ordered by account number. */
export function legsOf(store, workspaceId, entryId) {
  return store.db
    .prepare(
      `SELECT a.number AS number, l.debit_minor AS debit, l.credit_minor AS credit
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND a.workspace_id = ?
        ORDER BY a.number`,
    )
    .all(entryId, workspaceId);
}

/** Net (debit - credit) in base Rappen for one account NUMBER, across posted entries only. */
export function balanceOf(store, workspaceId, number) {
  return store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS bal
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(workspaceId, number).bal;
}

/**
 * Row counts, so every §H-IDEMPOTENT and "writes nothing" claim is asserted on ROWS and never on a
 * return value. A verb can hand back `{ok:true}` and the right entry id twice while posting twice,
 * and only the row count can tell those two apart.
 */
export function rowCounts(store, workspaceId) {
  const one = (sql, ...args) => store.db.prepare(sql).get(...args).c;
  return {
    entries: one('SELECT COUNT(*) AS c FROM journal_entry WHERE workspace_id = ?', workspaceId),
    lines: one(
      `SELECT COUNT(*) AS c FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ?`,
      workspaceId,
    ),
  };
}

/** A capability port that denies exactly one capability, for the A24 delegation tests. */
export function denying(capability) {
  return {
    assert: (asked) =>
      asked === capability
        ? { ok: false, error: 'permission_denied', capability: asked }
        : { ok: true },
  };
}
