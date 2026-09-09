// @ts-check
// Test support for the A03 suites (audit trail, period locks, year-close).
//
// Unlike the A02 support, this wires the REAL PeriodPort + AuditPort (via `ledgerPorts`) so posting
// honours locks and stamps the hash-chained log, and it mints a real workspace through A00
// `createWorkspace` so the full KMU chart (incl. 2979 / 2970 and typed income/expense accounts) is
// present for the year-close. Not production code.

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { row, rows, num, str, okOf } from '../support/narrow.mjs';

const AT = '2026-07-16T00:00:00.000Z';

/**
 * A fresh store with one workspace (KMU chart seeded), a context wired with the real A03 ports, and a
 * `byNumber` map from account number to id. `fiscalYearStart` defaults to '01-01'.
 *
 * `baseCurrency` is left to A00's own default unless a caller names one. A workspace's base currency
 * is a SETTING, not a synonym for CHF, so a suite that wants to prove something about the currency of
 * a base figure has to be able to run in a book that is not Swiss.
 *
 * @param {{
 *   fiscalYearStart?: string,
 *   actor?: string,
 *   baseCurrency?: string,
 *   ctxOverrides?: Record<string, unknown>,
 * }} [opts]
 */
export function setup({ fiscalYearStart = '01-01', actor = 'user_1', baseCurrency, ctxOverrides = {} } = {}) {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  const ids = sequenceIdGen();
  const clock = fixedClock(AT);

  const minted = createWorkspace(
    { store, clock, ids },
    { name: 'Acme GmbH', fiscalYearStart, ...(baseCurrency === undefined ? {} : { baseCurrency }) },
  );
  const workspaceId = str(okOf(minted, 'createWorkspace').workspaceId, 'createWorkspace.workspaceId');

  const seeded = rows(
    store.db.prepare('SELECT number, id, type FROM account WHERE workspace_id = ?').all(workspaceId),
    'seeded chart',
  );
  /** @type {Record<string, string>} */
  const byNumber = {};
  /** @type {Record<string, string>} */
  const typeOf = {};
  for (const r of seeded) {
    byNumber[str(r.number, 'account.number')] = str(r.id, 'account.id');
    typeOf[str(r.number, 'account.number')] = str(r.type, 'account.type');
  }

  const ctx = makeContext(store, {
    workspaceId,
    actor,
    clock,
    ids,
    ...ledgerPorts({ store, workspaceId, ids }),
    ...ctxOverrides,
  });

  return { store, ctx, workspaceId, byNumber, typeOf, ids, clock, AT };
}

/**
 * The id A00 seeded for a KMU chart account number.
 *
 * `byNumber` is built from whatever `createWorkspace` actually seeded, so it cannot be a record with
 * declared keys the way A02's four-account map is. Under `noUncheckedIndexedAccess` that makes
 * `byNumber['2979']` a `string | undefined`, and the honest answer is not to shrug it off but to
 * say so out loud: if the KMU chart stops carrying a number a suite names, this throws HERE, at the
 * lookup, instead of posting an `undefined` account id and failing somewhere downstream.
 *
 * @param {Record<string, string>} byNumber the map from `setup()`
 * @param {string} number a KMU account number, e.g. '2979'
 * @returns {string}
 */
export function idOf(byNumber, number) {
  const id = byNumber[number];
  if (id === undefined) throw new Error(`the seeded KMU chart has no account ${number}`);
  return id;
}

/**
 * Balanced posting: debit `debitNo`, credit `creditNo`, `amount` Rappen, on `date`.
 *
 * @param {Record<string, string>} byNumber
 * @param {{
 *   debitNo: string,
 *   creditNo: string,
 *   amount: number,
 *   date: string,
 *   idempotencyKey: string,
 *   source?: string,
 * }} spec
 */
export function entry(byNumber, { debitNo, creditNo, amount, date, idempotencyKey, source = 'manual' }) {
  return {
    date,
    source,
    idempotencyKey,
    lines: [
      { account: idOf(byNumber, debitNo), debit: amount },
      { account: idOf(byNumber, creditNo), credit: amount },
    ],
  };
}

/**
 * Net (debit - credit) balance in base Rappen for an account, across posted entries only.
 *
 * @param {import('../../dist/core/store/sqlite-store.js').SqliteStore} store
 * @param {string} workspaceId
 * @param {string} accountId
 * @returns {number}
 */
export function balanceOf(store, workspaceId, accountId) {
  const balance = row(
    store.db
      .prepare(
        `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS bal
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND l.account_id = ?`,
      )
      .get(workspaceId, accountId),
    `balanceOf(${accountId})`,
  );
  return num(balance.bal, `balanceOf(${accountId}).bal`);
}
