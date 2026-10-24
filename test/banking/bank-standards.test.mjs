// D167 (spec A39 §13): the standard per counterparty, the two new ladder rungs (c2) standard and (d2)
// journal, and the two reduced-rate input codes. The money-path invariants are marked [INVARIANT ...] for
// the non-author critic: append-only, idempotent on ROWS, §H-TENANT. Each says in its comment which code
// it guards, so a mutation of that code fails it.
//
// SYNTHETIC DATA ONLY: every statement is spelled by hand in bank-inbox-support.mjs; the counterparty
// names are invented and the IBANs are the support module's invented numbers with correct check pairs.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  createBankAccount,
  listBankInbox,
  bookBankLine,
  setBankStandard,
  clearBankStandard,
  listBankStandards,
  vatCanApplyToAccount,
  lineNeedsReview,
  proposalContext,
  reviewBankTxn,
} from '../../dist/core/banking/index.js';
import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import { archiveAccount } from '../../dist/core/accounts/accounts.js';
import { deactivateTaxCode } from '../../dist/core/vat/taxCodes.js';
import { computeLineTax, buildVatLines } from '../../dist/core/vat/applyVat.js';
import { DEFAULT_TAX_CODES } from '../../dist/core/vat/enums.js';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { configureVat } from '../../dist/core/vat/index.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { seedRate } from '../payments/support.mjs';
import {
  world,
  secondWorkspace,
  importLines,
  issueInvoice,
  must,
  refused,
  legs,
  assertClaimInvariantHolds,
  excuseClaimInvariant,
  MAIN_IBAN,
  SAVINGS_IBAN,
  TELCO_IBAN,
} from './bank-inbox-support.mjs';
import { chainedOpening } from './e2-adapt.mjs';

afterEach(assertClaimInvariantHolds);

const lineOf = (inbox, id) => inbox.lines.find((l) => l.bankTxnId === id);
const proposalOf = (t, id, ctx = t.ctx) => lineOf(must(listBankInbox(ctx, { status: 'all' }), 'inbox'), id);
const standardRows = (t, ws = t.workspaceId) => t.store.db.prepare('SELECT * FROM bank_standard WHERE workspace_id = ? ORDER BY rowid').all(ws);

/** One debit line from the telco (IBAN and name), one from a stationer known by name only. */
function twoLines(t, statementId = 'BS-1', extra = []) {
  return importLines(t, {
    statementId,
    entries: [
      { ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' },
      { ref: 'PAP', amountMinor: 4320, cd: 'DBIT', name: 'Papeterie Lindenhof GmbH' },
      ...extra,
    ],
  }).lines;
}

// ================================================================================================
// 1. The table: append-only, one live standard per key and direction
// ================================================================================================

test('[INVARIANT append-only] bank_standard rows are never deleted and only the supersession stamp is written, once', () => {
  // Guards the two triggers `bank_standard_no_delete` and `bank_standard_supersede_only` (bankInboxSchema.ts).
  const t = world();
  const l = twoLines(t);
  const s = must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'a1' })).standard;
  const db = t.store.db;
  assert.throws(() => db.prepare('DELETE FROM bank_standard WHERE id = ?').run(s.id), /never deleted/);
  for (const [col, value] of [
    ['account_id', t.acc('6800')],
    ['tax_code', 'VST-I'],
    ['counterparty_key', 'iban:CH00'],
    ['counterparty_label', 'Andere AG'],
    ['direction', 'in'],
    ['set_by', 'someone_else'],
    ['set_at', '2020-01-01T00:00:00.000Z'],
  ]) {
    assert.throws(() => db.prepare(`UPDATE bank_standard SET ${col} = ? WHERE id = ?`).run(value, s.id), /only the supersession stamp/, `${col} is immutable`);
    // Riding a legitimate stamp does not smuggle a change through either: each column has its own guard.
    assert.throws(
      () => db.prepare(`UPDATE bank_standard SET superseded_at = '2026-07-21T00:00:00.000Z', superseded_by = 'u', ${col} = ? WHERE id = ?`).run(value, s.id),
      /only the supersession stamp/,
      `${col} is immutable beside a stamp`,
    );
  }
  // An UPDATE that leaves superseded_at NULL is refused too (a stamp is the only write).
  assert.throws(() => db.prepare('UPDATE bank_standard SET superseded_by = ? WHERE id = ?').run('x', s.id), /only the supersession stamp/);
  db.prepare('UPDATE bank_standard SET superseded_at = ?, superseded_by = ? WHERE id = ?').run('2026-07-21T00:00:00.000Z', 'u', s.id);
  assert.throws(
    () => db.prepare('UPDATE bank_standard SET superseded_at = ? WHERE id = ?').run('2026-07-22T00:00:00.000Z', s.id),
    /only the supersession stamp/,
    'a stamp is written once',
  );
});

test('[INVARIANT one-live] a new standard for the same key and direction supersedes the old one in the same write; the index refuses a second live row', () => {
  // Guards the supersede-then-insert in `setBankStandard` and the partial unique index `bank_standard_one_live`.
  const t = world();
  const l = twoLines(t);
  const first = must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'o1' }));
  assert.equal(first.supersededId, null);
  const second = must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6800'), taxCode: null, idempotencyKey: 'o2' }));
  assert.equal(second.supersededId, first.standard.id);
  const rows = standardRows(t);
  assert.equal(rows.length, 2, 'the old standard stays on record');
  assert.notEqual(rows[0].superseded_at, null, 'the old one is stamped');
  assert.equal(rows[0].superseded_by, 'user_1');
  assert.equal(rows[1].superseded_at, null);
  const live = must(listBankStandards(t.ctx, {})).standards;
  assert.deepEqual(
    live.map((s) => ({ id: s.id, accountNumber: s.accountNumber, taxCode: s.taxCode, direction: s.direction, key: s.counterpartyKey, label: s.counterpartyLabel })),
    [{ id: second.standard.id, accountNumber: '6800', taxCode: null, direction: 'out', key: `iban:${TELCO_IBAN}`, label: 'Fernmelde Ostschweiz AG' }],
  );
  assert.throws(
    () =>
      t.store.db
        .prepare(
          `INSERT INTO bank_standard (id, workspace_id, counterparty_key, counterparty_label, direction, account_id, set_at)
           VALUES ('raw', ?, ?, 'x', 'out', ?, '2026-07-20')`,
        )
        .run(t.workspaceId, `iban:${TELCO_IBAN}`, t.acc('6500')),
    /UNIQUE/,
  );
});

test('the same account and code as the live standard answers unchanged and writes nothing', () => {
  const t = world();
  const l = twoLines(t);
  const first = must(setBankStandard(t.ctx, { bankTxnId: l.PAP, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'u1' }));
  const again = must(setBankStandard(t.ctx, { bankTxnId: l.PAP, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'u2' }));
  assert.equal(again.unchanged, true);
  assert.equal(again.standard.id, first.standard.id);
  assert.equal(standardRows(t).length, 1);
  assert.equal(first.standard.counterpartyKey, 'name:papeterie lindenhof', 'no IBAN: the normalised name is the key');
});

// ================================================================================================
// 2. Idempotent on rows, and the tenant boundary
// ================================================================================================

test('[INVARIANT idempotent-on-rows] a replay under the same key adds no row and answers the stored result, for set and clear', () => {
  // Guards the recall/remember pair in `setBankStandard` and `clearBankStandard`.
  const t = world();
  const l = twoLines(t);
  const input = { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'i1' };
  const a = must(setBankStandard(t.ctx, input));
  // Between the call and its replay the person sets another standard: the replay must NOT write the first one again.
  must(setBankStandard(t.ctx, { ...input, accountId: t.acc('6800'), taxCode: null, idempotencyKey: 'i2' }));
  const before = standardRows(t);
  const b = setBankStandard(t.ctx, input);
  assert.deepEqual(b, a, 'the replay answers the first result');
  assert.deepEqual(standardRows(t), before, 'and moves no row');

  const live = must(listBankStandards(t.ctx, {})).standards[0];
  const c1 = must(clearBankStandard(t.ctx, { standardId: live.id, idempotencyKey: 'c1' }));
  assert.equal(c1.cleared, true);
  const afterClear = standardRows(t);
  assert.deepEqual(clearBankStandard(t.ctx, { standardId: live.id, idempotencyKey: 'c1' }), c1);
  assert.deepEqual(standardRows(t), afterClear);
  const c2 = must(clearBankStandard(t.ctx, { standardId: live.id, idempotencyKey: 'c2' }));
  assert.equal(c2.alreadyCleared, true, 'a second key on a cleared standard says so');
  assert.deepEqual(standardRows(t), afterClear);
  assert.deepEqual(must(listBankStandards(t.ctx, {})).standards, []);
});

test('[INVARIANT tenant] a standard never reaches another workspace; foreign ids are not_found and move nothing', () => {
  // Guards the `workspace_id = ?` binding in every query of bankStandards.ts and in `liveStandardsIndex`.
  const t = world();
  const b = secondWorkspace(t);
  const bBank = must(createBankAccount(b.ctx, { name: 'Konto B', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: b.acc('1020'), idempotencyKey: 'bb' })).bankAccountId;
  const la = twoLines(t);
  const lb = importLines(t, { statementId: 'B-1', entries: [{ ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }, { ctx: b.ctx, bankAccountId: bBank }).lines;
  const s = must(setBankStandard(t.ctx, { bankTxnId: la.TEL, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 't1' })).standard;

  const inB = proposalOf(t, lb.TEL, b.ctx);
  assert.equal(inB.standardId, null, 'the same IBAN in workspace B carries no standard of A');
  assert.notEqual(inB.proposal.reasonCode, 'standard');
  assert.equal(proposalOf(t, la.TEL).standardId, s.id);

  const beforeA = standardRows(t);
  refused(setBankStandard(b.ctx, { bankTxnId: la.TEL, accountId: b.acc('6500'), taxCode: null, idempotencyKey: 'x1' }), 'not_found');
  refused(setBankStandard(b.ctx, { bankTxnId: lb.TEL, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'x2' }), 'not_found');
  refused(clearBankStandard(b.ctx, { standardId: s.id, idempotencyKey: 'x3' }), 'not_found');
  assert.deepEqual(standardRows(t), beforeA, "A's standard is untouched");
  assert.deepEqual(standardRows(t, b.workspaceId), [], 'B wrote nothing');
  assert.deepEqual(must(listBankStandards(b.ctx, {})).standards, []);
});

// ================================================================================================
// 3. The refusals of set_bank_standard
// ================================================================================================

test('set_bank_standard refuses a line without counterparty, an invalid account, an unknown or archived code, and a code where VAT cannot apply', () => {
  const t = world();
  const l = twoLines(t, 'BS-R', [{ ref: 'ANON', amountMinor: 100, cd: 'DBIT' }]);
  refused(setBankStandard(t.ctx, { bankTxnId: l.ANON, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'r0' }), 'no_counterparty');
  refused(setBankStandard(t.ctx, { bankTxnId: 'nope', accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'r1' }), 'not_found');
  refused(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: 'nope', taxCode: null, idempotencyKey: 'r2' }), 'not_found');
  for (const [number, reason] of [
    ['1020', 'bank_ledger'],
    ['1100', 'control_account'],
    ['2000', 'control_account'],
    ['1170', 'vat_account'],
    ['2200', 'vat_account'],
  ]) {
    const r = refused(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc(number), taxCode: null, idempotencyKey: `acc-${number}` }), 'invalid_account');
    assert.equal(r.reason, reason, number);
  }
  must(archiveAccount(t.ctx, { accountId: t.acc('6800') }));
  assert.equal(refused(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6800'), taxCode: null, idempotencyKey: 'arch' }), 'invalid_account').reason, 'archived');
  refused(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: 'NOPE', idempotencyKey: 'c1' }), 'invalid_tax_code');
  must(deactivateTaxCode(t.ctx, { code: 'VST-I' }));
  refused(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: 'VST-I', idempotencyKey: 'c2' }), 'invalid_tax_code');
  const liability = t.store.db
    .prepare("SELECT number FROM account WHERE workspace_id = ? AND type = 'liability' AND archived = 0 AND number NOT IN ('2000', '2200', '2201') ORDER BY number LIMIT 1")
    .get(t.workspaceId).number;
  refused(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc(liability), taxCode: 'VST-M', idempotencyKey: 'v1' }), 'vat_not_applicable');
  must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc(liability), taxCode: null, idempotencyKey: 'v2' }), 'the same account without a code is fine');
  assert.equal(standardRows(t).length, 1, 'every refusal wrote nothing');
});

test('vatCanApplyToAccount: income, expense, asset 12xx and 14xx to 17xx; never VAT accounts, 10xx, 11xx, 13xx or a bank ledger', () => {
  const ledgers = new Set(['bank']);
  const yes = [
    { id: 'a', number: '3400', type: 'income' },
    { id: 'b', number: '6500', type: 'expense' },
    { id: 'c', number: '1200', type: 'asset' },
    { id: 'd', number: '1500', type: 'asset' },
    { id: 'e', number: '1799', type: 'asset' },
  ];
  const no = [
    { id: 'f', number: '1170', type: 'asset' },
    { id: 'g', number: '2200', type: 'liability' },
    { id: 'h', number: '1000', type: 'asset' },
    { id: 'i', number: '1100', type: 'asset' },
    { id: 'j', number: '1300', type: 'asset' },
    { id: 'bank', number: '6999', type: 'expense' },
    { id: 'k', number: '2800', type: 'equity' },
  ];
  for (const a of yes) assert.equal(vatCanApplyToAccount(a, ledgers), true, a.number);
  for (const a of no) assert.equal(vatCanApplyToAccount(a, ledgers), false, a.number);
});

// ================================================================================================
// 4. The standard rung (c2)
// ================================================================================================

test('(c2) a live standard proposes its account and code, sure, for every later line of that counterparty and direction, and only that direction', () => {
  const t = world();
  const l = twoLines(t);
  const s = must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'c2-1' })).standard;
  // D178 point 19 (re-cut): the next statement opens where the last one closed, as a bank's do.
  const later = importLines(t, {
    statementId: 'BS-2',
    seqNb: '2',
    openingMinor: chainedOpening(t),
    entries: [
      { ref: 'TEL2', amountMinor: 9120, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG (neu)', date: '2026-07-28' },
      { ref: 'REFUND', amountMinor: 500, cd: 'CRDT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG', date: '2026-07-28' },
    ],
  }).lines;
  const line = proposalOf(t, later.TEL2);
  assert.deepEqual(line.proposal, {
    target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 9120, taxCode: 'VST-M' }] },
    certainty: 'sure',
    reasonCode: 'standard',
    reasonParams: { standardId: s.id, accountId: t.acc('6500'), taxCode: 'VST-M' },
    vatCode: 'VST-M',
  });
  assert.equal(line.attention, 'sure', 'a standard line counts for the bulk button (owner pick 1A)');
  assert.equal(line.standardId, s.id);
  const refund = proposalOf(t, later.REFUND);
  assert.notEqual(refund.proposal.reasonCode, 'standard', 'money IN from the same IBAN is another direction');
  assert.equal(refund.standardId, null);
  // The proposal books as it stands, and the booking carries the standard's account and code.
  const booked = must(bookBankLine(t.ctx, { bankTxnId: later.TEL2, target: line.proposal.target, idempotencyKey: 'bk' }));
  const tax = computeLineTax(t.ctx, { amountMinor: 9120, amountIsGross: true, taxCode: 'VST-M', supplyDate: '2026-07-28' });
  const posted = legs(t.store, booked.entryId);
  assert.deepEqual(
    posted.map((g) => [g.number, g.debit, g.credit]),
    [['1020', 0, 9120], ['1170', tax.taxMinor, 0], ['6500', tax.netMinor, 0]],
  );
  assert.equal(posted.find((g) => g.number === '6500').taxCode, 'VST-M');
});

test('(c2) a stale standard (account archived, code archived) is silent and the line falls through; standardId still names it', () => {
  const t = world();
  const l = twoLines(t);
  const s = must(setBankStandard(t.ctx, { bankTxnId: l.PAP, accountId: t.acc('6800'), taxCode: null, idempotencyKey: 's1' })).standard;
  assert.equal(proposalOf(t, l.PAP).proposal.reasonCode, 'standard');
  must(archiveAccount(t.ctx, { accountId: t.acc('6800') }));
  const after = proposalOf(t, l.PAP);
  assert.notEqual(after.proposal.reasonCode, 'standard', 'an archived account is never proposed');
  assert.equal(after.standardId, s.id);

  const s2 = must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: 'VST-I', idempotencyKey: 's2' })).standard;
  assert.equal(proposalOf(t, l.TEL).proposal.reasonCode, 'standard');
  must(deactivateTaxCode(t.ctx, { code: 'VST-I' }));
  const stale = proposalOf(t, l.TEL);
  assert.notEqual(stale.proposal.reasonCode, 'standard', 'an archived code is never proposed');
  assert.equal(stale.standardId, s2.id);
});

test('(c2) a reversal-flagged line reads check, never sure', () => {
  const t = world();
  const l = importLines(t, { statementId: 'RV', entries: [{ ref: 'RV', amountMinor: 700, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG', reversal: true }] }).lines;
  must(setBankStandard(t.ctx, { bankTxnId: l.RV, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'rv' }));
  const p = proposalOf(t, l.RV).proposal;
  assert.equal(p.reasonCode, 'standard');
  assert.equal(p.certainty, 'check');
});

test('(c2) on a foreign-currency line a taxed standard drops its code and reads check; an untaxed one stays sure', () => {
  const t = world();
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-19' });
  const eur = must(createBankAccount(t.ctx, { name: 'EUR-Konto', iban: SAVINGS_IBAN, currency: 'EUR', ledgerAccountId: t.acc('1000'), idempotencyKey: 'eur' })).bankAccountId;
  const l = importLines(
    t,
    {
      statementId: 'EUR-1',
      iban: SAVINGS_IBAN,
      currency: 'EUR',
      entries: [
        { ref: 'A', amountMinor: 2000, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' },
        { ref: 'B', amountMinor: 3000, cd: 'DBIT', name: 'Papeterie Lindenhof GmbH' },
      ],
    },
    { bankAccountId: eur },
  ).lines;
  must(setBankStandard(t.ctx, { bankTxnId: l.A, accountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'f1' }));
  must(setBankStandard(t.ctx, { bankTxnId: l.B, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'f2' }));
  const a = proposalOf(t, l.A).proposal;
  assert.equal(a.reasonCode, 'standard');
  assert.equal(a.certainty, 'check', 'never bulk-booked gross');
  assert.equal(a.vatCode, null);
  assert.deepEqual(a.target.legs, [{ accountId: t.acc('6500'), amountMinor: 2000 }]);
  assert.equal(a.reasonParams.vatDropped, true);
  assert.equal(a.reasonParams.taxCode, 'VST-M', 'the standard itself is named as it is');
  const b = proposalOf(t, l.B).proposal;
  assert.equal(b.certainty, 'sure');
  must(bookBankLine(t.ctx, { bankTxnId: l.A, target: a.target, idempotencyKey: 'fa' }), 'the dropped-code proposal is bookable');
});

// ================================================================================================
// 5. The rung order: reference > standard > bank history > journal > open
// ================================================================================================

test('rung order: a reference-proven match beats the standard, the standard beats bank history, bank history beats the journal', () => {
  const t = world();
  // (b) beats (c2): a QR credit for an issued invoice, from a counterparty with a standard for money in.
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'ro' });
  const first = importLines(t, {
    statementId: 'RO-1',
    entries: [
      { ref: 'OLDIN', amountMinor: 1000, cd: 'CRDT', name: 'Muster AG' },
      { ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' },
      { ref: 'PAP', amountMinor: 4320, cd: 'DBIT', name: 'Papeterie Lindenhof GmbH' },
    ],
  }).lines;
  must(setBankStandard(t.ctx, { bankTxnId: first.OLDIN, accountId: t.acc('3400'), taxCode: null, idempotencyKey: 'in' }));
  const qr = importLines(t, {
    statementId: 'RO-2',
    seqNb: '2',
    entries: [{ ref: 'QR', amountMinor: 108100, cd: 'CRDT', qrr: buildQrrReference(inv.number), name: 'Muster AG', date: '2026-07-25' }],
  }).lines;
  const q = proposalOf(t, qr.QR);
  assert.equal(q.proposal.reasonCode, 'qr_reference_exact', 'the reference wins');
  assert.notEqual(q.standardId, null, 'while the standard is still named on the line');

  // (c2) beats (d): the telco was booked to 6800 before (bank history), the standard says 6500.
  must(bookBankLine(t.ctx, { bankTxnId: first.TEL, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 8650 }] }, idempotencyKey: 'h1' }));
  const next = importLines(t, {
    statementId: 'RO-3',
    seqNb: '3',
    entries: [
      { ref: 'TEL2', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG', date: '2026-07-29' },
      { ref: 'PAP2', amountMinor: 1200, cd: 'DBIT', name: 'Papeterie Lindenhof GmbH', date: '2026-07-29' },
    ],
  }).lines;
  assert.equal(proposalOf(t, next.TEL2).proposal.reasonCode, 'history', 'without a standard, bank history speaks');
  must(setBankStandard(t.ctx, { bankTxnId: first.TEL, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'st' }));
  const tel2 = proposalOf(t, next.TEL2).proposal;
  assert.equal(tel2.reasonCode, 'standard');
  assert.equal(tel2.target.legs[0].accountId, t.acc('6500'));

  // (d) beats (d2): the stationer booked through the inbox to 6800 (history), and a NEWER hand entry
  // naming it to 6500 on the bank ledger (journal).
  must(bookBankLine(t.ctx, { bankTxnId: first.PAP, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 4320 }] }, idempotencyKey: 'h2' }));
  must(postEntry(t.ctx, { date: '2026-07-27', source: 'manual', description: 'Papeterie Lindenhof Rechnung 88', idempotencyKey: 'je', lines: [{ account: t.acc('6500'), debit: 900 }, { account: t.acc('1020'), credit: 900 }] }));
  const pap2 = proposalOf(t, next.PAP2).proposal;
  assert.equal(pap2.reasonCode, 'history');
  assert.equal(pap2.target.legs[0].accountId, t.acc('6800'));
});

// ================================================================================================
// 6. The journal rung (d2)
// ================================================================================================

/** A hand entry on the bank ledger: money out (credit 1020) by default. */
function handEntry(t, key, { description, date = '2026-07-15', account = '6500', amountMinor = 1500, moneyIn = false, ledger = '1020' }) {
  const lines = moneyIn
    ? [{ account: t.acc(ledger), debit: amountMinor }, { account: t.acc(account), credit: amountMinor }]
    : [{ account: t.acc(account), debit: amountMinor }, { account: t.acc(ledger), credit: amountMinor }];
  return must(postEntry(t.ctx, { date, source: 'manual', description, idempotencyKey: key, lines }), key).entryId;
}

test('(d2) the newest posted entry on the bank ledger naming every token of the counterparty proposes its main leg, check', () => {
  const t = world();
  handEntry(t, 'old', { description: 'Papeterie Lindenhof, Büromaterial Mai', date: '2026-05-10', account: '6800' });
  const newest = handEntry(t, 'new', { description: 'Zahlung PAPETERIE  Lindenhöf Rechnung 12', date: '2026-06-10', account: '6500' });
  const l = twoLines(t);
  const p = proposalOf(t, l.PAP).proposal;
  assert.deepEqual(p, {
    target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 4320 }] },
    certainty: 'check',
    reasonCode: 'journal_history',
    reasonParams: { accountId: t.acc('6500'), taxCode: null, entryId: newest, date: '2026-06-10' },
    vatCode: null,
  });
  assert.equal(proposalOf(t, l.PAP).attention, 'needs', 'a journal suggestion is never bulk-booked');
});

test('(d2) every token must be there: a partial name, the other direction, another bank ledger, a reversed entry and a control-account main leg never match', () => {
  const t = world();
  must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: 'sav' }));
  handEntry(t, 'partial', { description: 'Papeterie Rosenhof', date: '2026-07-01' });
  handEntry(t, 'dir', { description: 'Gutschrift Papeterie Lindenhof', date: '2026-07-02', moneyIn: true, account: '3400' });
  handEntry(t, 'other-ledger', { description: 'Papeterie Lindenhof', date: '2026-07-03', ledger: '1000' });
  const reversed = handEntry(t, 'rev', { description: 'Papeterie Lindenhof', date: '2026-07-04' });
  must(reverseEntry(t.ctx, { entryId: reversed, idempotencyKey: 'rev-r' }));
  handEntry(t, 'control', { description: 'Papeterie Lindenhof Kreditor', date: '2026-07-05', account: '2000' });
  const l = twoLines(t);
  assert.notEqual(proposalOf(t, l.PAP).proposal.reasonCode, 'journal_history', 'nothing above may match');

  // The positive control in the same world: an older matching entry is found once it exists.
  const good = handEntry(t, 'good', { description: 'Lindenhof Papeterie GmbH Juni', date: '2026-06-01', account: '6800' });
  const p = proposalOf(t, l.PAP).proposal;
  assert.equal(p.reasonCode, 'journal_history');
  assert.equal(p.reasonParams.entryId, good, 'the control-account entry and the reversed one were skipped, the older good one found');
});

test('(d2) critic R2-2: a reversal entry never speaks, not even for a line of its own direction', () => {
  // The reversal of a money-out entry moves the bank ledger the other way, so only a money-IN line can
  // reach it: this is the case that makes `e.reverses_entry_id IS NULL` (and the anti-join) bite.
  const t = world();
  const original = handEntry(t, 'orig', { description: 'Papeterie Lindenhof Toner', date: '2026-07-04', account: '6500' });
  must(reverseEntry(t.ctx, { entryId: original, idempotencyKey: 'orig-r' }));
  const l = importLines(t, {
    statementId: 'R22',
    entries: [
      { ref: 'PIN', amountMinor: 1500, cd: 'CRDT', name: 'Papeterie Lindenhof GmbH' },
      { ref: 'POUT', amountMinor: 1500, cd: 'DBIT', name: 'Papeterie Lindenhof GmbH' },
    ],
  }).lines;
  assert.notEqual(proposalOf(t, l.PIN).proposal.reasonCode, 'journal_history', 'the reversal entry is not history');
  assert.notEqual(proposalOf(t, l.POUT).proposal.reasonCode, 'journal_history', 'the reversed entry is not history');
});

test('(d2) a money-in line matches an entry that debits the bank ledger, and a VAT entry proposes its main leg with its code', () => {
  const t = world();
  const vatLines = buildVatLines(t.ctx, {
    counterAccount: t.acc('1020'),
    revenueOrExpenseAccount: t.acc('6500'),
    amountMinor: 10810,
    amountIsGross: true,
    taxCode: 'VST-M',
    direction: 'input',
    supplyDate: '2026-06-20',
  });
  const vatEntry = must(postEntry(t.ctx, { date: '2026-06-20', source: 'manual', description: 'Papeterie Lindenhof Toner', idempotencyKey: 'vat', lines: vatLines })).entryId;
  handEntry(t, 'in', { description: 'Fernmelde Ostschweiz Gutschrift', date: '2026-06-21', moneyIn: true, account: '3400' });
  const l = importLines(t, {
    statementId: 'D2',
    entries: [
      { ref: 'PAP', amountMinor: 2160, cd: 'DBIT', name: 'Papeterie Lindenhof GmbH' },
      { ref: 'IN', amountMinor: 300, cd: 'CRDT', name: 'Fernmelde Ostschweiz AG' },
    ],
  }).lines;
  const pap = proposalOf(t, l.PAP).proposal;
  assert.equal(pap.reasonCode, 'journal_history');
  assert.deepEqual(pap.target.legs, [{ accountId: t.acc('6500'), amountMinor: 2160, taxCode: 'VST-M' }]);
  assert.equal(pap.reasonParams.entryId, vatEntry);
  assert.equal(pap.vatCode, 'VST-M');
  const inn = proposalOf(t, l.IN).proposal;
  assert.equal(inn.reasonCode, 'journal_history');
  assert.equal(inn.target.legs[0].accountId, t.acc('3400'));
});

test('(d2) critic D167-3: an archived or invalid main leg keeps the rung silent; a line outside the base currency drops the code', () => {
  // Guards the `suggestionTargetUsable` check and the `vatDropped` rule in `journalProposal`.
  const t = world();
  handEntry(t, 'arch', { description: 'Papeterie Lindenhof Mai', date: '2026-06-01', account: '6800' });
  const l = twoLines(t);
  assert.equal(proposalOf(t, l.PAP).proposal.reasonCode, 'journal_history', 'before the archive the rung speaks');
  must(archiveAccount(t.ctx, { accountId: t.acc('6800') }));
  assert.notEqual(proposalOf(t, l.PAP).proposal.reasonCode, 'journal_history', 'an archived account is never prefilled');

  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-19' });
  const eur = must(createBankAccount(t.ctx, { name: 'EUR-Konto', iban: SAVINGS_IBAN, currency: 'EUR', ledgerAccountId: t.acc('1000'), idempotencyKey: 'eur' })).bankAccountId;
  const vatLines = buildVatLines(t.ctx, {
    counterAccount: t.acc('1000'),
    revenueOrExpenseAccount: t.acc('6500'),
    amountMinor: 10810,
    amountIsGross: true,
    taxCode: 'VST-M',
    direction: 'input',
    supplyDate: '2026-06-20',
  });
  must(postEntry(t.ctx, { date: '2026-06-20', source: 'manual', description: 'Fernmelde Ostschweiz Router', idempotencyKey: 'eur-vat', lines: vatLines }));
  const e = importLines(t, { statementId: 'EUR-D2', iban: SAVINGS_IBAN, currency: 'EUR', entries: [{ ref: 'R', amountMinor: 2000, cd: 'DBIT', name: 'Fernmelde Ostschweiz AG' }] }, { bankAccountId: eur }).lines;
  const p = proposalOf(t, e.R).proposal;
  assert.equal(p.reasonCode, 'journal_history');
  assert.deepEqual(p.target.legs, [{ accountId: t.acc('6500'), amountMinor: 2000 }], 'no code on a EUR line');
  assert.equal(p.vatCode, null);
  assert.equal(p.reasonParams.vatDropped, true);
  assert.equal(p.reasonParams.taxCode, 'VST-M', 'the entry is named as it was booked');
  must(bookBankLine(t.ctx, { bankTxnId: e.R, target: p.target, idempotencyKey: 'eur-book' }), 'and the prefilled target books');
});

test('(d2) critic D167-5: a one-token name speaks only when two matching entries agree on the account (the P6 case stays silent)', () => {
  // Guards the corroboration rule for a one-token name in `journalProposal`.
  const t = world();
  handEntry(t, 'zins', { description: 'Migros Bank Hypothekarzins Q2', date: '2026-06-30', account: '6800' });
  const l = importLines(t, { statementId: 'P6', entries: [{ ref: 'M', amountMinor: 4590, cd: 'DBIT', name: 'MIGROS' }] }).lines;
  assert.notEqual(proposalOf(t, l.M).proposal.reasonCode, 'journal_history', 'P6: one stray text hit proposes nothing');
  handEntry(t, 'g1', { description: 'Migros Seefeld Einkauf', date: '2026-05-02', account: '6500' });
  assert.notEqual(proposalOf(t, l.M).proposal.reasonCode, 'journal_history', 'the two newest hits disagree (6800, 6500): silent');
  handEntry(t, 'g2', { description: 'Einkauf Migros Oerlikon', date: '2026-07-02', account: '6500' });
  handEntry(t, 'g3', { description: 'Migros Kaffee', date: '2026-07-05', account: '6500' });
  const p = proposalOf(t, l.M).proposal;
  assert.equal(p.reasonCode, 'journal_history', 'the two newest hits agree on 6500');
  assert.equal(p.target.legs[0].accountId, t.acc('6500'));
});

test('(d2) critic D167-1: a line whose only proposal is the journal still needs review; a standard line does not (owner pick 1A)', () => {
  // Guards BOTH halves in `lineNeedsReview` (camtReconcile.ts): the default context built without the
  // journal rung, and the belt that reads a `journal_history` proposal as needing review when a caller
  // hands in a full context.
  const t = world();
  handEntry(t, 'je', { description: 'Papeterie Lindenhof Toner', date: '2026-07-01' });
  const l = twoLines(t);
  const row = (id) => t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(id);
  assert.equal(proposalOf(t, l.PAP).proposal.reasonCode, 'journal_history', 'the inbox shows the journal suggestion');
  assert.equal(lineNeedsReview(t.ctx, row(l.PAP)), true, 'the default review read skips the journal rung');
  assert.equal(lineNeedsReview(t.ctx, row(l.PAP), undefined, proposalContext(t.ctx)), true, 'a full context: the belt');
  assert.equal(must(reviewBankTxn(t.ctx, { bankTxnId: l.PAP, idempotencyKey: 'rv1' })).needsReview, true);
  // A standard is `sure` because a person made it, so its line reads as placed (A39 §13.2).
  must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'st' }));
  assert.equal(lineNeedsReview(t.ctx, row(l.TEL)), false);
});

// ================================================================================================
// 7. VST-M26 and VST-M38
// ================================================================================================

test('VST-M26 and VST-M38 are default input codes on Ziffer 400 and book net plus 1170 at 2.6 and 3.8 percent', () => {
  const byCode = Object.fromEntries(DEFAULT_TAX_CODES.map((c) => [c.code, c]));
  assert.deepEqual({ ...byCode['VST-M26'], label: undefined }, { code: 'VST-M26', kind: 'input', rateBp: 260, formLine: '400', label: undefined });
  assert.deepEqual({ ...byCode['VST-M38'], label: undefined }, { code: 'VST-M38', kind: 'input', rateBp: 380, formLine: '400', label: undefined });
  const t = world();
  const l = importLines(t, {
    statementId: 'V',
    entries: [
      { ref: 'R', amountMinor: 10260, cd: 'DBIT', name: 'Bäckerei Seeblick' },
      { ref: 'H', amountMinor: 10380, cd: 'DBIT', name: 'Hotel Bergsicht' },
    ],
  }).lines;
  const r = must(bookBankLine(t.ctx, { bankTxnId: l.R, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 10260, taxCode: 'VST-M26' }] }, idempotencyKey: 'r' }));
  assert.deepEqual(
    legs(t.store, r.entryId).map((g) => [g.number, g.debit, g.credit]),
    [['1020', 0, 10260], ['1170', 260, 0], ['6500', 10000, 0]],
  );
  // The standard path: a standard on VST-M38, its proposal booked as it stands.
  must(setBankStandard(t.ctx, { bankTxnId: l.H, accountId: t.acc('6500'), taxCode: 'VST-M38', idempotencyKey: 'h' }));
  const p = proposalOf(t, l.H).proposal;
  assert.equal(p.certainty, 'sure');
  const h = must(bookBankLine(t.ctx, { bankTxnId: l.H, target: p.target, idempotencyKey: 'hb' }));
  assert.deepEqual(
    legs(t.store, h.entryId).map((g) => [g.number, g.debit, g.credit]),
    [['1020', 0, 10380], ['1170', 380, 0], ['6500', 10000, 0]],
  );
  const vatLeg = legs(t.store, h.entryId).find((g) => g.number === '6500');
  assert.equal(vatLeg.taxCode, 'VST-M38');
});

test('D167-4: VST-I26 and VST-I38 are default input codes on Ziffer 405 and book net plus 1171 at 2.6 and 3.8 percent', () => {
  const byCode = Object.fromEntries(DEFAULT_TAX_CODES.map((c) => [c.code, c]));
  assert.deepEqual(
    { ...byCode['VST-I26'] },
    { code: 'VST-I26', kind: 'input', rateBp: 260, formLine: '405', label: 'Vorsteuer Investitionen und übriger Betriebsaufwand 2.6% (reduziert)' },
  );
  assert.deepEqual(
    { ...byCode['VST-I38'] },
    { code: 'VST-I38', kind: 'input', rateBp: 380, formLine: '405', label: 'Vorsteuer Investitionen und übriger Betriebsaufwand 3.8% (Beherbergung)' },
  );
  const t = world();
  const l = importLines(t, {
    statementId: 'V405',
    entries: [
      { ref: 'R', amountMinor: 10260, cd: 'DBIT', name: 'Bäckerei Seeblick' },
      { ref: 'H', amountMinor: 10380, cd: 'DBIT', name: 'Hotel Bergsicht' },
    ],
  }).lines;
  const r = must(bookBankLine(t.ctx, { bankTxnId: l.R, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 10260, taxCode: 'VST-I26' }] }, idempotencyKey: 'r' }));
  assert.deepEqual(
    legs(t.store, r.entryId).map((g) => [g.number, g.debit, g.credit]),
    [['1020', 0, 10260], ['1171', 260, 0], ['6500', 10000, 0]],
  );
  // The standard path on VST-I38: a hotel night on a business trip.
  must(setBankStandard(t.ctx, { bankTxnId: l.H, accountId: t.acc('6500'), taxCode: 'VST-I38', idempotencyKey: 'h' }));
  const p = proposalOf(t, l.H).proposal;
  const h = must(bookBankLine(t.ctx, { bankTxnId: l.H, target: p.target, idempotencyKey: 'hb' }));
  assert.deepEqual(
    legs(t.store, h.entryId).map((g) => [g.number, g.debit, g.credit]),
    [['1020', 0, 10380], ['1171', 380, 0], ['6500', 10000, 0]],
  );
});

test('VST-M26, VST-M38, VST-I26 and VST-I38 price a pre-2024 supply at the old 2.5 and 3.7 percent (the stored rate names the class)', () => {
  const t = world();
  const old26 = computeLineTax(t.ctx, { amountMinor: 10250, amountIsGross: true, taxCode: 'VST-M26', supplyDate: '2023-06-01' });
  assert.equal(old26.ok, true);
  assert.deepEqual([old26.netMinor, old26.taxMinor], [10000, 250]);
  const old38 = computeLineTax(t.ctx, { amountMinor: 10370, amountIsGross: true, taxCode: 'VST-M38', supplyDate: '2023-06-01' });
  assert.deepEqual([old38.netMinor, old38.taxMinor], [10000, 370]);
  const now26 = computeLineTax(t.ctx, { amountMinor: 10260, amountIsGross: true, taxCode: 'VST-M26', supplyDate: '2026-06-01' });
  assert.deepEqual([now26.netMinor, now26.taxMinor], [10000, 260]);
  // D167-4: the Ziffer 405 twins price by the same class and era.
  const oldI26 = computeLineTax(t.ctx, { amountMinor: 10250, amountIsGross: true, taxCode: 'VST-I26', supplyDate: '2023-06-01' });
  assert.deepEqual([oldI26.netMinor, oldI26.taxMinor, oldI26.formLine], [10000, 250, '405']);
  const oldI38 = computeLineTax(t.ctx, { amountMinor: 10370, amountIsGross: true, taxCode: 'VST-I38', supplyDate: '2023-06-01' });
  assert.deepEqual([oldI38.netMinor, oldI38.taxMinor], [10000, 370]);
  const nowI38 = computeLineTax(t.ctx, { amountMinor: 10380, amountIsGross: true, taxCode: 'VST-I38', supplyDate: '2026-06-01' });
  assert.deepEqual([nowI38.netMinor, nowI38.taxMinor], [10000, 380]);
});

test('generation 11 gives a generation-10 book with tax codes the four input codes once, and leaves a book without codes and an own code alone', () => {
  excuseClaimInvariant();
  const dir = mkdtempSync(join(tmpdir(), 'd167-gen11-'));
  const file = join(dir, 'book.db');
  try {
    const clock = fixedClock('2026-07-20T10:00:00.000Z');
    const ids = sequenceIdGen();
    let store = new SqliteStore({ clock, location: file });
    const deps = { store, clock, ids };
    const withCodes = createWorkspace(deps, { name: 'Mit MWST GmbH' }).workspaceId;
    const ownCode = createWorkspace(deps, { name: 'Eigener Code AG' }).workspaceId;
    const noCodes = createWorkspace(deps, { name: 'Ohne MWST GmbH' }).workspaceId;
    for (const ws of [withCodes, ownCode]) {
      const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock, ids });
      must(configureVat(ctx, { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: `vat-${ws}` }));
    }
    store.close();

    // Turn the file back into a generation-10 book: the two codes did not exist then. The own-code
    // workspace carries a VST-M26 of its own (another label), which must survive.
    const raw = new Database(file);
    raw.prepare("DELETE FROM tax_code WHERE code IN ('VST-M26', 'VST-M38', 'VST-I26', 'VST-I38')").run();
    raw.prepare(
      "INSERT INTO tax_code (id, workspace_id, code, kind, rate_bp, esa_form_line, label, active) VALUES ('own', ?, 'VST-M26', 'input', 260, '400', 'Mein eigener Code', 1)",
    ).run(ownCode);
    raw.pragma('user_version = 10');
    raw.close();

    const D167 = ['VST-I26', 'VST-I38', 'VST-M26', 'VST-M38'];
    const codesOf = (db, ws) => db.prepare("SELECT code, kind, rate_bp AS rateBp, esa_form_line AS formLine, label FROM tax_code WHERE workspace_id = ? AND code IN ('VST-M26', 'VST-M38', 'VST-I26', 'VST-I38') ORDER BY code").all(ws);
    for (let round = 0; round < 2; round += 1) {
      store = new SqliteStore({ clock, location: file });
      assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
      assert.ok(SCHEMA_GENERATION >= 11);
      assert.deepEqual(
        codesOf(store.db, withCodes).map((c) => ({ ...c })),
        DEFAULT_TAX_CODES.filter((c) => D167.includes(c.code))
          .map((c) => ({ code: c.code, kind: c.kind, rateBp: c.rateBp, formLine: c.formLine, label: c.label }))
          .sort((a, b) => (a.code < b.code ? -1 : 1)),
        `round ${round}: seeded exactly once, as the seed writes them`,
      );
      assert.deepEqual(codesOf(store.db, noCodes), [], 'a book without MWST gets nothing');
      const own = codesOf(store.db, ownCode);
      assert.equal(own.find((c) => c.code === 'VST-M26').label, 'Mein eigener Code', 'an own code by that name is untouched');
      assert.equal(own.length, 4);
      store.close();
      // Replay the generation: a crash before the bump re-runs it, and it must change nothing.
      const again = new Database(file);
      again.pragma('user_version = 10');
      again.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
