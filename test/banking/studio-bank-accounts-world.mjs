/**
 * The worlds behind the A19 Studio fixtures in `app/src/surfaces/BankAccounts/*.fixture.json`.
 *
 * Shared by the capture script (`capture-studio-bank-accounts.mjs`) and by the drift guard
 * (`studio-bank-accounts-fixture.test.mjs`), so the fixtures are a RECORDING of these functions and
 * the guard replays exactly the same functions. Two copies of the world would let the recording and
 * the assertion drift apart.
 *
 * THE IBANS ARE REAL AND THEY ARE CHECKED HERE. `createBankAccount` runs the ISO 13616 mod-97 check
 * and derives the QR flag from the QR-IID range itself (SIX §1.3.2, 30000 to 31999), so a made-up
 * IBAN would be refused at seeding rather than captured. `CH44 3199 9123 0008 8901 2` carries IID
 * 31999 and is therefore a QR-IBAN; `CH93 0076 2011 6238 5295 7` carries IID 00762 and is a plain
 * one. The engine, not this file, decides which is which: the assertions below read `isQrIban` back.
 *
 * WHY 9100 IS CREATED IN ONE WORLD AND NOT THE OTHER. `9100 Eröffnungsbilanz` is in NO shipped
 * chart (`kmuSeed.ts` has no 9100), and `setBankOpeningBalance` refuses with `needs_account` rather
 * than inventing an equity account. Both halves are states the surface has to render, so both are
 * recorded: the register world creates 9100 the way an operator would, through A01's own
 * `createAccount`, and posts a real opening balance against it; the chart fixture for the missing
 * case is A01's shipped seed, which has no 9100 in it at all.
 */

import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createAccount, listAccounts } from '../../dist/core/accounts/index.js';
import {
  createBankAccount,
  setBankOpeningBalance,
  previewBankOpeningBalance,
  archiveBankAccount,
  listBankAccounts,
  getBankAccount,
} from '../../dist/core/banking/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';

export const AT = '2026-07-19T00:00:00.000Z';
export const DATE = '2026-07-19';

/** SIX's own QR-IBAN example: QR-IID 31999, the top of the reserved range. */
export const QR_IBAN = 'CH4431999123000889012';
/** A plain Swiss IBAN, IID 00762, outside the QR-IID range. */
export const PLAIN_IBAN = 'CH9300762011623852957';
/** A second plain IBAN, for the archived row. */
export const ARCHIVED_IBAN = 'CH5604835012345678009';

/** The opening balance the register world posts, in Rappen. */
export const OPENING_MINOR = 1250000;

function context() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Muster Grafik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  const accountId = (number) => {
    const row = store.db
      .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
      .get(workspaceId, number);
    assert.ok(row !== undefined, `the shipped chart has no account ${number}`);
    return row.id;
  };
  return { store, ctx, workspaceId, accountId };
}

/** Register one Bankkonto and hand back the id, failing loudly on any rejection. */
function register(ctx, { name, iban, currency, ledgerAccountId, key }) {
  const created = createBankAccount(ctx, {
    name,
    iban,
    ledgerAccountId,
    idempotencyKey: key,
    ...(currency !== undefined ? { currency } : {}),
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created;
}

/**
 * The populated register: a QR-IBAN account carrying a posted opening balance, a plain EUR account
 * with none at all, and an archived account behind the toggle.
 *
 * All three rows exist together on purpose. The list has to render a posted figure that links to its
 * entry, the "noch keiner" cell, and the dimmed archived row carrying the word Archiviert, and a
 * fixture holding only one of the three would leave the other two branches rendered against nothing.
 */
export function liveBankAccounts() {
  const { ctx, accountId } = context();

  // 9100 the way an operator would create it, through A01's own verb. It is NOT in the shipped seed,
  // which is precisely why the missing-9100 refusal is a designed state on the opening-balance step.
  const equity = createAccount(ctx, {
    number: '9100',
    name: 'Eröffnungsbilanz',
    type: 'equity',
    idempotencyKey: 'acc-9100',
  });
  assert.equal(equity.ok, true, JSON.stringify(equity));

  const bank = accountId('1020');
  const qr = register(ctx, { name: 'PostFinance QR', iban: QR_IBAN, ledgerAccountId: bank, key: 'bank-qr' });
  assert.equal(qr.isQrIban, true, 'the engine must read CH44 3199 ... as a QR-IBAN');

  const eur = register(ctx, {
    name: 'Raiffeisen EUR',
    iban: PLAIN_IBAN,
    currency: 'EUR',
    ledgerAccountId: bank,
    key: 'bank-eur',
  });
  assert.equal(eur.isQrIban, false, 'the engine must read CH93 0076 ... as a plain IBAN');

  const retired = register(ctx, {
    name: 'Altes Kontokorrent',
    iban: ARCHIVED_IBAN,
    ledgerAccountId: bank,
    key: 'bank-old',
  });

  const opening = setBankOpeningBalance(ctx, {
    bankAccountId: qr.bankAccountId,
    amountMinor: OPENING_MINOR,
    date: DATE,
    idempotencyKey: 'opening-qr',
  });
  assert.equal(opening.ok, true, JSON.stringify(opening));
  assert.equal(opening.posted, true, 'a non-zero opening balance must post a real entry');

  const archived = archiveBankAccount(ctx, {
    bankAccountId: retired.bankAccountId,
    idempotencyKey: 'archive-old',
  });
  assert.equal(archived.ok, true, JSON.stringify(archived));

  const active = listBankAccounts(ctx, {});
  assert.equal(active.ok, true, JSON.stringify(active));
  assert.equal(active.bankAccounts.length, 2, 'the archived row must be hidden by default');

  const withArchived = listBankAccounts(ctx, { includeArchived: true });
  assert.equal(withArchived.ok, true, JSON.stringify(withArchived));
  assert.equal(withArchived.bankAccounts.length, 3);

  const one = getBankAccount(ctx, { bankAccountId: eur.bankAccountId });
  assert.equal(one.ok, true, JSON.stringify(one));

  // The chart the editor's picker and its 9100 probe read, WITH archived rows, which is what the
  // probe asks for so an archived 9100 is never reported as missing.
  const chart = listAccounts(ctx, { includeArchived: true });
  assert.equal(chart.ok, true, JSON.stringify(chart));
  assert.ok(
    chart.accounts.some((a) => a.number === '9100'),
    'this world creates 9100, so the chart capture must carry it',
  );

  return { active, withArchived, one, chart };
}

/** The rate the preview world prices its EUR opening balance at, and the amount it previews. */
export const PREVIEW_RATE = '0.943712';
export const PREVIEW_AMOUNT_MINOR = 1234567;

/**
 * `preview_bank_opening_balance` on a FOREIGN-currency account, which is the payload the Studio's
 * readout renders (owner decision D43/B2).
 *
 * A foreign account on purpose: a franc preview echoes its own input, so a recording of one could
 * not tell the engine's conversion apart from no conversion at all, and the Studio's whole claim is
 * that the figure below is not the amount multiplied in the browser. `0.943712` against
 * CHF 12'345.67 does not round cleanly, so the recorded `baseAmountMinor` is a figure only the
 * engine's own rounding produces.
 *
 * The rate is RECORDED through A03's `record_exchange_rate` rather than passed as an explicit one,
 * so the capture also exercises the resolution path the Studio hits when the step prefills the rate
 * from `get_exchange_rate`, and the recorded `fxRateAsOf` / `fxRateSource` are real stored values.
 */
export function livePreviewOpeningBalance() {
  const { ctx, accountId } = context();

  const equity = createAccount(ctx, {
    number: '9100',
    name: 'Eröffnungsbilanz',
    type: 'equity',
    idempotencyKey: 'acc-9100',
  });
  assert.equal(equity.ok, true, JSON.stringify(equity));

  const rate = recordExchangeRate(ctx, {
    baseCurrency: 'EUR',
    rate: PREVIEW_RATE,
    asOf: DATE,
    source: 'manual',
    method: 'daily',
    provenance: 'A19 Studio fixture',
    idempotencyKey: 'rate-eur',
  });
  assert.equal(rate.ok, true, JSON.stringify(rate));

  const eur = register(ctx, {
    name: 'Raiffeisen EUR',
    iban: PLAIN_IBAN,
    currency: 'EUR',
    ledgerAccountId: accountId('1020'),
    key: 'bank-eur',
  });

  const preview = previewBankOpeningBalance(ctx, {
    bankAccountId: eur.bankAccountId,
    amountMinor: PREVIEW_AMOUNT_MINOR,
    currency: 'EUR',
    date: DATE,
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.notEqual(
    preview.baseAmountMinor,
    PREVIEW_AMOUNT_MINOR,
    'a foreign preview that equalled its own input would not be recording a conversion at all',
  );
  return preview;
}

/**
 * A register holding ONE QR-IBAN and nothing else, which is the completeness note's whole predicate.
 *
 * SIX §3.1: "there must always be an IBAN in addition to a QR-IBAN". A workspace in this state can
 * receive but cannot initiate, and nobody finds out until A18's debit picker comes up empty. It is
 * recorded as its own world because adding a plain IBAN to the register world would extinguish it.
 */
export function liveQrOnlyRegister() {
  const { ctx, accountId } = context();
  const qr = register(ctx, {
    name: 'PostFinance QR',
    iban: QR_IBAN,
    ledgerAccountId: accountId('1020'),
    key: 'bank-qr-only',
  });
  assert.equal(qr.isQrIban, true);

  const list = listBankAccounts(ctx, {});
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.bankAccounts.length, 1);
  assert.equal(list.bankAccounts[0].receiveOnly, true, 'the note is derived from receiveOnly');
  return list;
}
