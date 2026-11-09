/**
 * The A19 STUDIO fixture-versus-engine drift guard.
 *
 * Same three halves as its A16 twin, and the same reason: a fixture more generous than the engine
 * agrees with the consumer's bug rather than with the product.
 *
 *  1. PRESENT: the recordings are the live answers, VALUE for value.
 *  2. ABSENT: `BankAccountView` carries no `qrIban`, no `bankName`, no `balanceMinor` and no
 *     `canArchive`. The last one matters most: three phantom permission fields (`canPost`,
 *     `canManage`, `canUnlock`) were found in this Studio read off responses that have never carried
 *     them, each tested `x !== false`, so an absent field meant permanently `true`. The register
 *     surface must not grow a fourth.
 *  3. LOAD-BEARING: the register fixture holds all three row shapes the list branches on (a posted
 *     opening balance, none at all, archived), and the QR-only fixture really is a register that
 *     cannot initiate a payment, which is the completeness note's entire predicate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  liveBankAccounts,
  liveQrOnlyRegister,
  livePreviewOpeningBalance,
  QR_IBAN,
  PLAIN_IBAN,
  OPENING_MINOR,
  PREVIEW_RATE,
  PREVIEW_AMOUNT_MINOR,
} from './studio-bank-accounts-world.mjs';

const DIR = new URL('../../app/src/surfaces/BankAccounts/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));

const ACTIVE = read('list-bank-accounts.fixture.json');
const ARCHIVED = read('list-bank-accounts.archived.fixture.json');
const ONE = read('get-bank-account.fixture.json');
const CHART = read('list-accounts-with-9100.fixture.json');
const QR_ONLY = read('list-bank-accounts.qr-only.fixture.json');
const PREVIEW = read('preview-bank-opening-balance.fixture.json');

test('every fixture is the live answer, value for value', () => {
  const live = liveBankAccounts();
  assert.deepEqual(ACTIVE, JSON.parse(JSON.stringify(live.active)));
  assert.deepEqual(ARCHIVED, JSON.parse(JSON.stringify(live.withArchived)));
  assert.deepEqual(ONE, JSON.parse(JSON.stringify(live.one)));
  assert.deepEqual(CHART, JSON.parse(JSON.stringify(live.chart)));
  assert.deepEqual(QR_ONLY, JSON.parse(JSON.stringify(liveQrOnlyRegister())));
  assert.deepEqual(PREVIEW, JSON.parse(JSON.stringify(livePreviewOpeningBalance())));
});

test('a bank account row carries exactly the keys the engine emits', () => {
  const expected = [
    'archived',
    'createdAt',
    'currency',
    'iban',
    'id',
    'isQrIban',
    'ledgerAccountId',
    'ledgerAccountNumber',
    'name',
    'openingBalanceDate',
    'openingBalanceMinor',
    'openingEntryId',
    'receiveOnly',
  ];
  assert.ok(ARCHIVED.bankAccounts.length > 0);
  for (const row of ARCHIVED.bankAccounts) {
    assert.deepEqual(Object.keys(row).sort(), expected, JSON.stringify(row));
  }
  assert.deepEqual(Object.keys(ONE.bankAccount).sort(), expected);
});

test('the engine sends NO permission field, so no affordance may be gated on one', () => {
  // `canPost`, `canManage` and `canUnlock` were all read off payloads that never carried them, each
  // as `x !== false`, so absent meant permanently true. A fourth would be the same defect again.
  for (const row of ARCHIVED.bankAccounts) {
    for (const phantom of ['canArchive', 'canEdit', 'canPost', 'qrIban', 'bankName', 'balanceMinor']) {
      assert.equal(phantom in row, false, `the engine does not send ${phantom}`);
    }
  }
});

test('the register holds all three row shapes the list branches on', () => {
  const rows = ARCHIVED.bankAccounts;
  const posted = rows.find((r) => r.openingEntryId !== null);
  const none = rows.find((r) => r.openingBalanceMinor === null && !r.archived);
  const retired = rows.find((r) => r.archived);
  assert.ok(posted !== undefined, 'no posted opening balance: the journal link renders against nothing');
  assert.ok(none !== undefined, 'no account without an opening balance: "noch keiner" is untested');
  assert.ok(retired !== undefined, 'no archived account: the toggle renders against nothing');
  assert.equal(posted.openingBalanceMinor, OPENING_MINOR);
  assert.equal(posted.iban, QR_IBAN);
  assert.equal(none.iban, PLAIN_IBAN);
});

test('archived rows are hidden by default and revealed by the flag, which is what the toggle maps to', () => {
  assert.equal(ACTIVE.bankAccounts.length, ARCHIVED.bankAccounts.length - 1);
  assert.ok(ACTIVE.bankAccounts.every((r) => r.archived === false));
  assert.ok(ARCHIVED.bankAccounts.some((r) => r.archived === true));
});

test('the QR flag and receiveOnly are the ENGINE’s reading of the IID, not a fixture claim', () => {
  const qr = ARCHIVED.bankAccounts.find((r) => r.iban === QR_IBAN);
  const plain = ARCHIVED.bankAccounts.find((r) => r.iban === PLAIN_IBAN);
  assert.equal(qr.isQrIban, true);
  assert.equal(qr.receiveOnly, true);
  assert.equal(plain.isQrIban, false);
  assert.equal(plain.receiveOnly, false);
});

test('the QR-only register really cannot initiate a payment, which is SIX §3.1 made visible', () => {
  const rows = QR_ONLY.bankAccounts;
  assert.ok(rows.length > 0);
  assert.ok(rows.some((r) => r.isQrIban === true));
  assert.equal(
    rows.some((r) => r.isQrIban === false),
    false,
    'a plain IBAN in this fixture would extinguish the very state it records',
  );
});

test('the linked account resolves to a NUMBER, so no raw id reaches the screen', () => {
  for (const row of ARCHIVED.bankAccounts) {
    assert.equal(typeof row.ledgerAccountNumber, 'string');
    assert.notEqual(row.ledgerAccountNumber, row.ledgerAccountId);
  }
});

test('the preview capture carries exactly the keys the Studio readout reads', () => {
  // The readout renders `baseAmountMinor`, `baseCurrency`, `posts` and `fxRate`, and `model.ts`
  // refuses the payload outright when any of the first three is missing or of the wrong type. This
  // pins the four to the live answer, so a rename in the engine reddens here rather than rendering
  // an empty readout under an irreversible button.
  assert.deepEqual(Object.keys(PREVIEW).sort(), [
    'amountMinor',
    'bankAccountId',
    'baseAmountMinor',
    'baseCurrency',
    'currency',
    'fxRate',
    'fxRateAsOf',
    'fxRateSource',
    'lines',
    'ok',
    'posts',
  ]);
  assert.equal(typeof PREVIEW.baseCurrency, 'string');
  assert.equal(Number.isInteger(PREVIEW.baseAmountMinor), true);
  assert.equal(PREVIEW.posts, true);
});

test('the previewed base amount is the ENGINE’s rounding of the rate, not the amount echoed back', () => {
  // The whole point of the verb. If this fixture ever recorded `baseAmountMinor === amountMinor` on a
  // foreign account, the Studio test that proves the browser does not multiply would be proving it
  // against a recording that never converted anything.
  assert.equal(PREVIEW.currency, 'EUR');
  assert.equal(PREVIEW.baseCurrency, 'CHF');
  assert.equal(PREVIEW.amountMinor, PREVIEW_AMOUNT_MINOR);
  assert.equal(PREVIEW.fxRate, PREVIEW_RATE);
  assert.notEqual(PREVIEW.baseAmountMinor, PREVIEW_AMOUNT_MINOR);
  // Recomputed here from the rate, half away from zero, purely as a sanity check on the recording:
  // 12'345.67 at 0.943712 is 11'650.7639..., so 11'650.76 and never 11'650.77.
  assert.equal(PREVIEW.baseAmountMinor, 1165076);
});

test('the preview names BOTH legs, so the readout can say where the money lands', () => {
  const numbers = PREVIEW.lines.map((line) => line.accountNumber).sort();
  assert.deepEqual(numbers, ['1020', '9100']);
  // §H-LEDGER in base currency: the two sides of the entry that WOULD be posted foot to zero.
  const net = PREVIEW.lines.reduce((n, l) => n + l.baseDebitMinor - l.baseCreditMinor, 0);
  assert.equal(net, 0);
});

test('the chart capture carries 9100 and the asset accounts the picker offers', () => {
  const equity = CHART.accounts.find((a) => a.number === '9100');
  assert.ok(equity !== undefined, 'without 9100 the happy opening-balance path renders the refusal');
  assert.equal(equity.type, 'equity');
  assert.ok(CHART.accounts.filter((a) => a.type === 'asset' && !a.archived).length > 1);
});
