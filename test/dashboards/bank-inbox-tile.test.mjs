// D142, the `bank_inbox` tile (the Übersicht's Bankeingang band): one registry entry, and the anti-drift
// claim every F00 tile makes, here in its strongest form: the band's needs / sure / noReceipt counts are
// the SAME lines `list_bank_inbox` marks with `attention` and `needsReceipt`, because both call the one
// definition in `bankInbox.ts` (A39 §11). Counted on the lines, never on a second predicate.
//
// Synthetic by construction: the A39 suite's hand-spelled statements and invented names.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox, bookBankLine, reopenBankLine } from '../../dist/core/banking/index.js';
import { dashboardOverview, dashboardTile, TILE_REGISTRY, DASHBOARD_TILES } from '../../dist/core/dashboards/index.js';
import { enqueueDraftedAction } from '../../dist/core/agent/index.js';
import { uploadFile, linkFile } from '../../dist/core/files/index.js';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { getAction } from '../../dist/api/registry.js';
import { listAccounts, updateAccount, STATEMENT_VOUCHER_DEFAULT_NUMBERS } from '../../dist/core/accounts/index.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';
import { assertClaimInvariantHolds, world, importLines, must, issueInvoice, SAVINGS_IBAN } from '../banking/bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const RANGE = { from: '2026-07-01', to: '2026-07-31' };
const GROSS = 108100;

function band(t) {
  return must(dashboardTile(t.ctx, { tile: 'bank_inbox', ...RANGE }), 'tile').tile;
}

function allLines(t, status) {
  return must(listBankInbox(t.ctx, { status, limit: 200 }), `inbox ${status}`).lines;
}

/** Open: one sure (QR reference + exact amount), one needs (no proposal), one needs (own transfer, check). */
function scene() {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'tile1' });
  const imported = importLines(t, {
    statementId: 'TILE-A',
    entries: [
      { ref: 'Q1', amountMinor: GROSS, cd: 'CRDT', qrr: buildQrrReference(inv.number), name: 'Muster AG' },
      { ref: 'FEE', amountMinor: 500, cd: 'DBIT', name: 'Kontoführung', ustrd: 'Preis für die Kontoführung Juli' },
      { ref: 'SAV', amountMinor: 20000, cd: 'DBIT', iban: SAVINGS_IBAN, name: 'Übertrag' },
    ],
  });
  return { t, inv, lines: imported.lines };
}

test('the registry carries bank_inbox with the source verbs\' own gates and the /bank drill', () => {
  const def = TILE_REGISTRY.find((d) => d.tile === 'bank_inbox');
  assert.ok(DASHBOARD_TILES.includes('bank_inbox'));
  assert.deepEqual([...def.requires], ['read_sales', 'read_books']);
  assert.equal(def.studioRoute, '/bank');
  assert.equal(def.mcpTool, 'list_bank_inbox');
});

test('an empty workspace answers the zero state, never an error', () => {
  const t = world();
  const tile = band(t);
  assert.equal(tile.ok, true);
  assert.deepEqual([tile.open, tile.needs, tile.sure, tile.noReceipt], [0, 0, 0, 0]);
  assert.equal(tile.lastSyncAt, null);
  assert.equal(tile.autoMode, null, 'no channel: no automatic fetch to speak of');
  assert.deepEqual(tile.channels, []);
  assert.equal(tile.accounts.length, 1, 'the registered Bankkonto, with nothing open');
});

test('the band counts exactly the lines the inbox marks: needs, sure, and the per-account money in and out', () => {
  const { t, lines } = scene();
  const open = allLines(t, 'open');
  const tile = band(t);
  assert.equal(tile.open, open.length);
  assert.equal(tile.needs, open.filter((l) => l.attention === 'needs').length);
  assert.equal(tile.sure, open.filter((l) => l.attention === 'sure').length);
  assert.deepEqual([tile.open, tile.needs, tile.sure], [3, 2, 1]);
  assert.equal(open.find((l) => l.bankTxnId === lines.Q1).attention, 'sure');
  assert.equal(open.find((l) => l.bankTxnId === lines.FEE).attention, 'needs');
  assert.equal(open.find((l) => l.bankTxnId === lines.SAV).attention, 'needs', 'an own transfer is never sure (D139)');
  const acc = tile.accounts[0];
  assert.deepEqual([acc.open, acc.inMinor, acc.outMinor], [3, GROSS, 20500]);
  // The overview carries the same tile.
  const overview = must(dashboardOverview(t.ctx, RANGE), 'overview');
  const fromOverview = overview.tiles.find((x) => x.tile === 'bank_inbox');
  assert.deepEqual([fromOverview.open, fromOverview.needs, fromOverview.sure], [3, 2, 1]);
});

test('a pending agent Vorschlag on a sure line makes it one that needs you, in the inbox and in the band alike', () => {
  const { t, lines } = scene();
  must(enqueueDraftedAction(t.ctx, { actionTool: 'book_bank_line', payload: { bankTxnId: lines.Q1, target: { kind: 'accounts', legs: [] } }, dialCapability: 'post', idempotencyKey: 'v1' }), 'draft');
  const q1 = allLines(t, 'open').find((l) => l.bankTxnId === lines.Q1);
  assert.equal(q1.attention, 'needs');
  const tile = band(t);
  assert.deepEqual([tile.needs, tile.sure], [3, 0]);
});

test('noReceipt counts the lines booked to accounts without a Beleg; a Beleg on the line or its entry clears it', () => {
  const { t, lines } = scene();
  const fee = allLines(t, 'open').find((l) => l.bankTxnId === lines.FEE);
  must(bookBankLine(t.ctx, { bankTxnId: fee.bankTxnId, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 500 }] }, idempotencyKey: 'fee' }), 'book fee');
  const q1 = allLines(t, 'open').find((l) => l.bankTxnId === lines.Q1);
  must(bookBankLine(t.ctx, { bankTxnId: q1.bankTxnId, target: q1.proposal.target, idempotencyKey: 'q1' }), 'book q1');
  let booked = allLines(t, 'booked');
  assert.equal(booked.find((l) => l.bankTxnId === lines.FEE).needsReceipt, true, 'booked to accounts, no Beleg');
  assert.equal(booked.find((l) => l.bankTxnId === lines.Q1).needsReceipt, false, 'an invoice settlement has its document');
  assert.equal(band(t).noReceipt, 1);
  assert.equal(band(t).noReceipt, booked.filter((l) => l.needsReceipt).length);

  const file = must(uploadFile(t.ctx, { contentBase64: Buffer.from('synthetischer Beleg').toString('base64'), filename: 'beleg.pdf', mime: 'application/pdf', idempotencyKey: 'up1' }), 'upload').file;
  must(linkFile(t.ctx, { fileId: file.id, entityKind: 'bank_txn', entityId: lines.FEE, idempotencyKey: 'ln1' }), 'link');
  booked = allLines(t, 'booked');
  const feeBooked = booked.find((l) => l.bankTxnId === lines.FEE);
  assert.deepEqual([feeBooked.receiptCount, feeBooked.needsReceipt], [1, false]);
  assert.equal(band(t).noReceipt, 0);

  // A Beleg filed on the booked ENTRY (the Journal's paperclip) counts for the line too.
  must(reopenBankLine(t.ctx, { bankTxnId: lines.FEE, reason: 'synthetic: rebook', idempotencyKey: 'reo' }), 'reopen');
  must(bookBankLine(t.ctx, { bankTxnId: lines.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 500 }] }, idempotencyKey: 'fee2' }), 'rebook');
  const rebooked = allLines(t, 'booked').find((l) => l.bankTxnId === lines.FEE);
  assert.equal(rebooked.receiptCount, 1, 'the Beleg stays on the line through the rebooking');
  const file2 = must(uploadFile(t.ctx, { contentBase64: Buffer.from('zweiter Beleg').toString('base64'), filename: 'b2.pdf', idempotencyKey: 'up2' }), 'upload2').file;
  must(linkFile(t.ctx, { fileId: file2.id, entityKind: 'journal_entry', entityId: rebooked.decision.entryId, idempotencyKey: 'ln2' }), 'link entry');
  assert.equal(allLines(t, 'booked').find((l) => l.bankTxnId === lines.FEE).receiptCount, 2);
});

test('the dashboard verb adds autoAvailable at the process boundary (no scheduler in a suite)', () => {
  const { t } = scene();
  const res = getAction('dashboard_tile').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, { workspaceId: t.workspaceId, tile: 'bank_inbox', ...RANGE });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.tile.autoAvailable, false);
});

// --- D142 amendment (owner, 28.09.2026): "Beleg = Kontoauszug" -------------------------------------------------

test('Beleg = Kontoauszug: 6900 Finanzaufwand carries the flag by default; other seeded accounts do not', () => {
  const t = world();
  const accounts = must(listAccounts(t.ctx, {}), 'accounts').accounts;
  const byNumber = (n) => accounts.find((a) => a.number === n);
  assert.equal(byNumber('6900').statementIsVoucher, true);
  assert.equal(byNumber('6500').statementIsVoucher, false);
  assert.equal(byNumber('1020').statementIsVoucher, false);
  assert.deepEqual([...STATEMENT_VOUCHER_DEFAULT_NUMBERS], ['6900'], 'the seed ships exactly one bank-fee and interest account');
});

test('Beleg = Kontoauszug: a fee line booked to a flagged account is not "ohne Beleg"; a mixed split still is; toggling moves the count', () => {
  const { t, lines } = scene();
  // FEE (5.00 out) to 6900 alone; SAV (200.00 out) split 6900 + 6500.
  must(bookBankLine(t.ctx, { bankTxnId: lines.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 500 }] }, idempotencyKey: 'fee' }), 'book fee');
  must(
    bookBankLine(t.ctx, {
      bankTxnId: lines.SAV,
      target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 1_000 }, { accountId: t.acc('6500'), amountMinor: 19_000 }] },
      idempotencyKey: 'sav',
    }),
    'book split',
  );
  const lineOf = (id) => allLines(t, 'booked').find((l) => l.bankTxnId === id);
  assert.equal(lineOf(lines.FEE).needsReceipt, false, 'the statement is the voucher of a bank fee');
  assert.equal(lineOf(lines.SAV).needsReceipt, true, 'a split with an unflagged leg still needs its Beleg');
  assert.equal(band(t).noReceipt, 1);

  must(updateAccount(t.ctx, { accountId: t.acc('6500'), statementIsVoucher: true }), 'flag 6500');
  assert.equal(lineOf(lines.SAV).needsReceipt, false);
  assert.equal(band(t).noReceipt, 0);

  must(updateAccount(t.ctx, { accountId: t.acc('6900'), statementIsVoucher: false }), 'unflag 6900');
  assert.equal(lineOf(lines.FEE).needsReceipt, true, 'an explicit setting wins over the seed default');
  assert.equal(lineOf(lines.SAV).needsReceipt, true);
  assert.equal(band(t).noReceipt, 2);
  assert.equal(band(t).noReceipt, allLines(t, 'booked').filter((l) => l.needsReceipt).length);
});

test('Beleg = Kontoauszug is changed with update_account, gated by its own edit right', () => {
  const t = world();
  const action = getAction('update_account');
  assert.equal(typeof action.inputSchema.properties.statementIsVoucher, 'object');
  const res = action.run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, { workspaceId: t.workspaceId, accountId: t.acc('6700'), statementIsVoucher: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(must(listAccounts(t.ctx, {}), 'accounts').accounts.find((a) => a.number === '6700').statementIsVoucher, true);
  assert.deepEqual(requiredCapabilitiesFor('update_account', {}), requiredCapabilitiesFor('update_account', { statementIsVoucher: true }), 'no new right');
});
