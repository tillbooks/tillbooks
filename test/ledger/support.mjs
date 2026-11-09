// @ts-check
// Test support for the A02 ledger suites: a fresh in-memory store seeded with a workspace and a few
// accounts, plus a default (permissive) context. Not production code.

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

const AT = '2026-07-16T00:00:00.000Z';

export function setup(ctxOverrides = {}) {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  const workspaceId = 'ws_1';

  store.db
    .prepare(
      'INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(workspaceId, 'Acme GmbH', 'CHF', '01-01', AT);

  /**
   * Account number to the id the seed mints for it.
   *
   * Written as a literal rather than accumulated into a `Record<string, string>`, and that is not
   * cosmetic: under `noUncheckedIndexedAccess` a string-keyed record makes `accounts['6500']`
   * `string | undefined`, which every suite would then have to answer at ~94 call sites for a key
   * that is right here in this file. Four declared properties instead, so a suite naming a fifth
   * number is a compile error rather than an `undefined` account id posted into the ledger.
   */
  const accounts = {
    '1000': 'acc_kasse',
    '1020': 'acc_bank',
    '6500': 'acc_buero',
    '3000': 'acc_ertrag',
  };
  /**
   * @param {keyof typeof accounts} number
   * @param {string} name
   * @param {string} type
   */
  const acct = (number, name, type) => {
    store.db
      .prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)')
      .run(accounts[number], workspaceId, number, name, type);
  };
  acct('1000', 'Kasse', 'asset');
  acct('1020', 'Bank', 'asset');
  acct('6500', 'Büromaterial', 'expense');
  acct('3000', 'Dienstleistungsertrag', 'income');

  const ctx = makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock: fixedClock(AT),
    ids: sequenceIdGen(),
    ...ctxOverrides,
  });

  return { store, ctx, workspaceId, accounts, AT };
}

/**
 * A balanced two-line entry input: debit `expense`, credit `cash`, for `amount` Rappen.
 *
 * @param {ReturnType<typeof setup>['accounts']} accounts the `accounts` map from `setup()`
 * @param {number} [amount] in Rappen
 * @param {string} [idempotencyKey]
 */
export function simpleEntry(accounts, amount = 5000, idempotencyKey = 'k1') {
  return {
    date: '2026-03-01',
    description: 'Büromaterial bar bezahlt',
    source: 'manual',
    idempotencyKey,
    lines: [
      { account: accounts['6500'], debit: amount },
      { account: accounts['1000'], credit: amount },
    ],
  };
}

/**
 * Register the minimal VAT surface the B2 post-boundary gate needs for a tagged line to post: the
 * input code `V81` (Vorsteuer 8.1%) plus the KMU VAT accounts 1170 (Vorsteuer) and 2200
 * (Umsatzsteuer). Deliberately NOT added to the `accounts` map: the property suites pick random
 * accounts from that map, and random movements on a VAT account would (correctly) fail the gate.
 *
 * @param {import('../../dist/core/store/sqlite-store.js').SqliteStore} store
 * @param {string} [workspaceId]
 */
export function withVat(store, workspaceId = 'ws_1') {
  store.db
    .prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)')
    .run('acc_vorsteuer', workspaceId, '1170', 'Vorsteuer', 'asset');
  store.db
    .prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)')
    .run('acc_umsatzsteuer', workspaceId, '2200', 'Umsatzsteuer', 'liability');
  store.db
    .prepare('INSERT INTO tax_code (id, workspace_id, code, kind, rate_bp, esa_form_line, label, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
    .run('tax_v81', workspaceId, 'V81', 'input', 810, '400', 'Vorsteuer 8.1%');
  return { code: 'V81', vorsteuer: 'acc_vorsteuer', umsatzsteuer: 'acc_umsatzsteuer' };
}
