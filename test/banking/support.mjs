// Test support for A19 (bank accounts).
//
// A19 registers a bank account and posts its opening balance through A02's REAL `postEntry`, so
// nothing about the opening entry is faked here: an opening balance written straight into a column
// would not reconcile against the ledger and every §H-LEDGER claim about it would be empty.
//
// TWO THINGS THIS FIXTURE DOES NOT DO, both deliberate:
//
//  1. **It does not add 1020 or any bank account to the chart.** 1020 Bankkonto is in A01's shipped
//     seed and A19 links to it by id. Adding accounts by hand is what let the A14 suite pass against
//     a chart no user has, so `assertChartHasNoHandAddedBankAccounts` below pins the liquidity block
//     to the seed.
//  2. **9100 Eröffnungsbilanz is created explicitly, by A01's public verb, per test.** It is NOT in
//     the shipped KMU seed and A04 (opening balances), which owns it, is not built yet. A19
//     therefore resolves it by NUMBER and refuses with `needs_account` when it is missing, exactly
//     the way A14 resolves its posting roles. `seedOpeningBalanceAccount` opts a fixture in, so the
//     `needs_account` path is testable by simply not calling it.

import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { createAccount } from '../../dist/core/accounts/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { OPENING_BALANCE_ACCOUNT_NUMBER } from '../../dist/core/banking/index.js';
import { ok as okResult, err as errResult } from '../../dist/core/result.js';

export const AT = '2026-07-19T00:00:00.000Z';

/** A published Swiss IBAN sample: PostFinance, IID 00762, a plain IID and NOT a QR-IID. */
export const PLAIN_IBAN = 'CH93 0076 2011 6238 5295 7';
/** The SIX QR-bill sample QR-IBAN: IID 31999, the TOP of the reserved QR-IID range 30000 to 31999. */
export const QR_IBAN = 'CH44 3199 9123 0008 8901 2';

/**
 * IID boundary fixtures, constructed (not published) and check-digit-correct, so the QR-IID range
 * is pinned at both edges rather than only in the middle. SIX, "Technical information about the
 * QR-IID and QR-IBAN" v1.1 §1.3.2: "QR-IIDs consist exclusively of numbers from 30000 to 31999."
 * 29999 and 32000 are therefore plain IBANs; 30000 and 31999 are QR-IBANs.
 */
export const IID_BOUNDARY = {
  29999: 'CH5029999000000000000',
  30000: 'CH5830000000000000000',
  31999: 'CH4531999000000000000',
  32000: 'CH5332000000000000000',
};

function accountId(store, workspaceId, number) {
  return store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(workspaceId, number)?.id;
}

/**
 * A workspace with the KMU chart. `realPeriods` swaps the permissive default port for A03's real
 * lock check, which the `period_locked` case needs.
 */
export function setup({ at = AT, realPeriods = false, baseCurrency } = {}) {
  const clock = fixedClock(at);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, {
    name: 'Muster Grafik GmbH',
    ...(baseCurrency !== undefined ? { baseCurrency } : {}),
  }).workspaceId;
  const ctx = makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    ...(realPeriods ? ledgerPorts({ store, workspaceId, ids }) : {}),
  });

  assertChartHasNoHandAddedBankAccounts(store, workspaceId);

  const acc = (number) => accountId(store, workspaceId, number);
  return {
    store,
    deps,
    ctx,
    clock,
    ids,
    workspaceId,
    acc,
    bankLedgerId: acc('1020'),
    cashLedgerId: acc('1000'),
    revenueLedgerId: acc('3000'),
    at: (iso, opts = {}) =>
      makeContext(store, {
        workspaceId,
        actor: 'user_1',
        clock: fixedClock(iso),
        ids,
        ...(opts.realPeriods ? ledgerPorts({ store, workspaceId, ids }) : {}),
      }),
  };
}

/**
 * The same workspace seen by an actor A24 has NOT granted one capability, with everything else
 * granted, which is what makes an asymmetry between two verbs measurable rather than argued.
 *
 * Wave-0's default port grants everything, so a suite that never swaps it cannot tell a verb that
 * asserts a capability from one that does not.
 */
export function withoutCapability(t, denied, { at = AT } = {}) {
  return makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: fixedClock(at),
    ids: t.ids,
    capabilities: {
      assert: (capability) =>
        capability === denied ? errResult('permission_denied', { capability }) : okResult(),
    },
  });
}

/**
 * Create 9100 Eröffnungsbilanz through A01's public verb, returning its id.
 *
 * A19 never creates it: inventing an equity account the Treuhänder never approved is exactly the
 * silent substitution `needs_account` exists to prevent. A04 will own seeding it for real.
 */
export function seedOpeningBalanceAccount(ctx, key = 'ob-account') {
  const res = createAccount(ctx, {
    number: OPENING_BALANCE_ACCOUNT_NUMBER,
    name: 'Eröffnungsbilanz',
    type: 'equity',
    idempotencyKey: key,
  });
  if (!res.ok) throw new Error(`opening-balance account failed: ${JSON.stringify(res)}`);
  return res.accountId;
}

/** Record a §H-FX rate (never a second rate mechanism of A19's own). */
export function seedRate(ctx, { currency, rate, asOf, key }) {
  const res = recordExchangeRate(ctx, {
    baseCurrency: currency,
    rate,
    asOf,
    source: 'manual',
    method: 'daily',
    provenance: 'test fixture',
    idempotencyKey: key ?? `rate-${currency}-${asOf}`,
  });
  if (!res.ok) throw new Error(`rate failed: ${JSON.stringify(res)}`);
  return res;
}

/**
 * A SECOND workspace inside the SAME database, which is the only shape in which a §H-TENANT claim
 * means anything: two separate stores would prove nothing about scoping.
 */
export function secondWorkspace(t, name = 'Nachbar AG') {
  const workspaceId = createWorkspace(t.deps, { name }).workspaceId;
  const ctx = makeContext(t.store, { workspaceId, actor: 'user_2', clock: t.clock, ids: t.ids });
  const acc = (number) => accountId(t.store, workspaceId, number);
  return { ctx, workspaceId, acc, bankLedgerId: acc('1020') };
}

/** Every journal line of an entry, as `{ number, debit, credit }`, for reconciling a posting. */
export function legsOf(store, workspaceId, entryId) {
  return store.db
    .prepare(
      `SELECT a.number AS number, l.debit_minor AS debit, l.credit_minor AS credit,
              l.base_debit_minor AS baseDebit, l.base_credit_minor AS baseCredit
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND a.workspace_id = ?
        ORDER BY a.number`,
    )
    .all(entryId, workspaceId);
}

/** The net movement on one account number across every posted entry, in BASE currency. */
export function accountBalance(store, workspaceId, number) {
  return store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(workspaceId, number).net;
}

/**
 * Row counts, so every §H-IDEMPOTENT claim is asserted on ROWS and never on a return value.
 *
 * A verb can return `{ok:true}` twice while writing twice; only the row count can tell those apart.
 */
export function counts(store, workspaceId) {
  const one = (sql, ...params) => store.db.prepare(sql).get(...params).n;
  return {
    bankAccounts: one('SELECT COUNT(*) AS n FROM bank_account WHERE workspace_id = ?', workspaceId),
    entries: one('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId),
    lines: one(
      `SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ?`,
      workspaceId,
    ),
  };
}

/**
 * Every row of every table, as one comparable string: the ONLY honest way to assert "this changed
 * nothing".
 *
 * `counts` above is scoped to the three tables A19 writes, which is enough for an idempotency claim
 * about a POST. It is not enough for a claim about a READ. `audit_log` and `audit_head` are an
 * append-only hash chain with no uniqueness constraint of any kind, so a verb that stamped an audit
 * row would leave every count untouched and still not be a read. The table list comes from
 * `sqlite_master`, so a table added by a future migration is covered without touching this helper.
 */
export function snapshot(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const out = {};
  for (const table of tables) out[table] = store.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  return JSON.stringify(out);
}

/**
 * The liquidity block is EXACTLY what A01 seeds. A19 links a bank account to a chart account by id,
 * so a fixture that quietly adds a "1021" of its own would let a wrong link look right.
 */
function assertChartHasNoHandAddedBankAccounts(store, workspaceId) {
  const rows = store.db
    .prepare(
      `SELECT number FROM account
        WHERE workspace_id = ? AND number >= '1000' AND number < '1100'
        ORDER BY number`,
    )
    .all(workspaceId)
    .map((r) => r.number);
  assert.deepEqual(
    rows,
    ['1000', '1020', '1060'],
    'the A19 fixture liquidity block must be the shipped seed and nothing else',
  );
}
