// D142 (A39 §11, OR 958f): a Beleg linked to a bank line is a retained voucher once the line is BOOKED or
// MATCHED. The ten years count from the end of the financial year of the later of the line's booking date
// and the dates of the entries its decision claims. It derives at the one decision writer (`writeLineLink`)
// for a Beleg attached while the line was open, and in `files_link` for one attached after; an open or an
// ignored line derives nothing; reopening a line never lowers a floor.
//
// Synthetic by construction: the A39 suite's hand-spelled statements, invented names and bytes.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { bookBankLine, ignoreBankLine, reopenBankLine } from '../../dist/core/banking/index.js';
import { uploadFile, linkFile, deleteFile, setFileRetention, listLinkedFiles } from '../../dist/core/files/index.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { assertClaimInvariantHolds, world, importLines, must } from '../banking/bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

let k = 0;
function beleg(t) {
  k += 1;
  return must(uploadFile(t.ctx, { contentBase64: Buffer.from(`synthetischer Beleg ${k}`).toString('base64'), filename: `beleg-${k}.pdf`, idempotencyKey: `up-${k}` }), 'upload').file;
}
const attach = (t, fileId, bankTxnId) => must(linkFile(t.ctx, { fileId, entityKind: 'bank_txn', entityId: bankTxnId, idempotencyKey: `ln-${fileId}-${bankTxnId}` }), 'link').file;
const floorOf = (t, fileId) => t.store.db.prepare('SELECT retention_statutory_until AS s, retention_until AS r FROM stored_file WHERE id = ?').get(fileId);
const toAccounts = (t, amountMinor) => ({ kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor }] });

function scene(date = '2026-07-20') {
  const t = world();
  const { lines } = importLines(t, {
    statementId: `FLOOR-${date}`,
    from: date.slice(0, 8) + '01',
    to: date,
    entries: [
      { ref: 'A', amountMinor: 700, cd: 'DBIT', name: 'Bürobedarf', date },
      { ref: 'B', amountMinor: 900, cd: 'DBIT', name: 'Porto', date },
    ],
  });
  return { t, lines };
}

test('a Beleg attached to an OPEN line derives nothing; booking the line derives the floor in the same step', () => {
  const { t, lines } = scene();
  const file = beleg(t);
  attach(t, file.id, lines.A);
  assert.deepEqual(floorOf(t, file.id), { s: null, r: null }, 'an open line is not posted evidence');
  must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: toAccounts(t, 700), idempotencyKey: 'bookA' }), 'book');
  assert.deepEqual(floorOf(t, file.id), { s: '2036-12-31', r: '2036-12-31' }, 'fiscal 2026 + ten years');
});

test('a Beleg attached AFTER booking derives the floor at the link', () => {
  const { t, lines } = scene();
  must(bookBankLine(t.ctx, { bankTxnId: lines.B, target: toAccounts(t, 900), idempotencyKey: 'bookB' }), 'book');
  const file = beleg(t);
  attach(t, file.id, lines.B);
  assert.equal(floorOf(t, file.id).s, '2036-12-31');
});

test('an IGNORED line is no posted evidence: its Beleg keeps no statutory lock', () => {
  const { t, lines } = scene();
  const file = beleg(t);
  attach(t, file.id, lines.A);
  must(ignoreBankLine(t.ctx, { bankTxnId: lines.A, reason: 'duplicate', idempotencyKey: 'ignA' }), 'ignore');
  assert.equal(floorOf(t, file.id).s, null);
  assert.equal(must(deleteFile(t.ctx, { fileId: file.id, confirmed: true }), 'delete').ok, true, 'an unposted voucher can be erased');
});

test('reopening a booked line lowers nothing: the floor stays, delete and a shorter retention are refused', () => {
  const { t, lines } = scene();
  const file = beleg(t);
  attach(t, file.id, lines.A);
  must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: toAccounts(t, 700), idempotencyKey: 'bookA2' }), 'book');
  must(reopenBankLine(t.ctx, { bankTxnId: lines.A, reason: 'synthetic: wrong account', idempotencyKey: 'reoA' }), 'reopen');
  assert.equal(floorOf(t, file.id).s, '2036-12-31', 'the recorded floor survives the reopen');
  const del = deleteFile(t.ctx, { fileId: file.id, confirmed: true });
  assert.equal(del.ok, false);
  assert.equal(del.error, 'retention_locked');
  const shorter = setFileRetention(t.ctx, { fileId: file.id, retentionUntil: '2030-12-31' });
  assert.equal(shorter.ok, false);
  assert.equal(shorter.error, 'retention_below_statutory');
  const listed = must(listLinkedFiles(t.ctx, { entityKind: 'bank_txn', entityId: lines.A }), 'linked').files;
  assert.equal(listed.find((f) => f.id === file.id).retentionLocked, true);
});

test('matched to an entry of the NEXT year: the ten years count from the later financial year', () => {
  const { t, lines } = scene('2026-12-30');
  const entry = must(
    postEntry(t.ctx, {
      date: '2027-01-02',
      source: 'manual',
      description: 'Synthetische Buchung im Folgejahr',
      lines: [
        { account: t.acc('6800'), debit: 700 },
        { account: t.bankId, credit: 700 },
      ],
      idempotencyKey: 'next-year',
    }),
    'post',
  );
  const file = beleg(t);
  attach(t, file.id, lines.A);
  must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: { kind: 'existing_entry', entryId: entry.entryId }, idempotencyKey: 'matchA' }), 'match');
  assert.equal(floorOf(t, file.id).s, '2037-12-31', 'the claimed entry of 2027 decides, not the line of 2026');
});

// --- Critic F5: the two clauses no test pinned (mutations M5 and M6 survived) --------------------------------

test('F5 (M5): a Beleg attached to a line that was booked and then reopened derives nothing: only a LIVE decision is posted evidence', () => {
  const { t, lines } = scene();
  must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: toAccounts(t, 700), idempotencyKey: 'm5-book' }), 'book');
  must(reopenBankLine(t.ctx, { bankTxnId: lines.A, reason: 'synthetic: wrong account', idempotencyKey: 'm5-reopen' }), 'reopen');
  const file = beleg(t);
  attach(t, file.id, lines.A);
  assert.deepEqual(floorOf(t, file.id), { s: null, r: null }, 'the superseded booking is no longer posted evidence');
});

test('F5 (M6): the anchor reads only the LIVE claims; a released claim on a later-year entry moves nothing', () => {
  const { t, lines } = scene('2026-12-30');
  const nextYear = must(
    postEntry(t.ctx, {
      date: '2027-01-02',
      source: 'manual',
      description: 'Synthetische Buchung im Folgejahr',
      lines: [
        { account: t.acc('6800'), debit: 700 },
        { account: t.bankId, credit: 700 },
      ],
      idempotencyKey: 'm6-next-year',
    }),
    'post',
  );
  // Matched to the 2027 entry, then reopened: that claim is released.
  must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: { kind: 'existing_entry', entryId: nextYear.entryId }, idempotencyKey: 'm6-match' }), 'match');
  must(reopenBankLine(t.ctx, { bankTxnId: lines.A, reason: 'synthetic: wrong entry', idempotencyKey: 'm6-reopen' }), 'reopen');
  // Booked again, to accounts, on the line's own day in 2026.
  must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: toAccounts(t, 700), idempotencyKey: 'm6-book' }), 'rebook');
  const file = beleg(t);
  attach(t, file.id, lines.A);
  assert.equal(floorOf(t, file.id).s, '2036-12-31', 'fiscal 2026 plus ten: the released 2027 claim is not read');
});
