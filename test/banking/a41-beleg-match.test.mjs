// A41.1 (D184), the Beleg-Abgleich: captured receipts paired with the bank lines they pay, as a read-model
// field (`belegCandidates` on the inbox line, `bankLineCandidates` on a capture). The pool, the three match
// rules, the grouping of an invoice with its receipt, the receipt guard, the setting, §H-TENANT, and the
// `files_link` closure of the capture.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, IBANs, amounts and dates (a41-beleg-support.mjs).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { listBankInbox } from '../../dist/core/banking/index.js';
import { bookBankLine, ignoreBankLine, reopenBankLine } from '../../dist/core/banking/bankBooking.js';
import { amountMatch } from '../../dist/core/banking/belegMatch.js';
import { recordExchangeRate } from '../../dist/core/fx/rates.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { getFileContent, linkFile, uploadFile } from '../../dist/core/files/index.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { must, world, secondWorkspace, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { receipt, lines, VENDOR_IBAN } from './a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const lineOf = (t, id, ctx = t.ctx) => must(listBankInbox(ctx, { bankTxnId: id, status: 'all' })).lines[0];
const candidates = (t, id, ctx) => lineOf(t, id, ctx).belegCandidates;
const setting = (t, key, value) => must(settingsSet(t.ctx, { key, value, reason: 'A41 test', idempotencyKey: `s-${key}-${value}` }));
const bookTo6570 = (t, id, amount) =>
  must(bookBankLine(t.ctx, { bankTxnId: id, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: amount }] }, idempotencyKey: `b-${id}` }));
const captureStatus = (t, captureId) => t.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(captureId).status;

test('happy: a receipt with the amount, a near date and the sender name is the open line\'s one candidate', () => {
  const t = world();
  const r = receipt(t, { amount: 8990, date: '2026-07-18' });
  const [line] = lines(t, [{ amount: 8990, date: '2026-07-20' }]);
  const groups = candidates(t, line);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].files.map((f) => f.fileId), [r.fileId]);
  assert.equal(groups[0].files[0].captureId, r.captureId);
  assert.deepEqual(groups[0].match, { amount: 'exact', days: 2, counterparty: 'name' });
  assert.equal(groups[0].amountMinor, 8990);
  assert.equal(groups[0].currency, 'CHF');
});

test('empty and boundary: another amount, another sender, a date beyond the window, a credit: nothing', () => {
  const t = world();
  receipt(t, { amount: 8990, date: '2026-07-10' });
  const [wrongAmount, wrongSender, credit] = lines(t, [
    { amount: 8991, date: '2026-07-11' },
    { amount: 8990, date: '2026-07-12', name: 'Druckhaus Beispiel GmbH' },
    { amount: 8990, date: '2026-07-13', cd: 'CRDT' },
  ]);
  assert.deepEqual(candidates(t, wrongAmount), []);
  assert.deepEqual(candidates(t, wrongSender), []);
  assert.deepEqual(candidates(t, credit), [], 'a captured receipt is purchase evidence: debits only');
  // The window: 7 days by default. Day 7 fits, day 8 does not.
  const [day7] = lines(t, [{ amount: 8990, date: '2026-07-17' }]);
  const [day8] = lines(t, [{ amount: 8990, date: '2026-07-18' }]);
  assert.equal(candidates(t, day7).length, 1);
  assert.deepEqual(candidates(t, day8), []);
  setting(t, 'belege.match_date_window_days', 8);
  assert.equal(candidates(t, day8).length, 1, 'the window is the setting');
});

test('the due date counts as well as the invoice date; the IBAN alone identifies the sender', () => {
  const t = world();
  receipt(t, { amount: 45000, vendor: null, date: '2026-06-01', due: '2026-07-01', iban: VENDOR_IBAN });
  const [line] = lines(t, [{ amount: 45000, date: '2026-07-02', name: 'Unbekannt', iban: VENDOR_IBAN }]);
  const [g] = candidates(t, line);
  assert.equal(g.match.counterparty, 'iban');
  assert.equal(g.match.days, 1);
});

test('the sender may be named in the remittance text, and an umlaut may arrive in its two-letter spelling', () => {
  const t = world();
  receipt(t, { amount: 1250, vendor: 'Bäckerei Müller GmbH', date: '2026-07-05' });
  const [line] = lines(t, [{ amount: 1250, date: '2026-07-05', name: 'SUMUP *KARTENZAHLUNG', ustrd: 'BAECKEREI MUELLER 8001' }]);
  assert.equal(candidates(t, line).length, 1);
  // A legal form alone is never the sender.
  receipt(t, { amount: 1251, vendor: 'Gmbh', date: '2026-07-05' });
  const [other] = lines(t, [{ amount: 1251, date: '2026-07-06', name: 'IRGENDWAS GMBH' }]);
  assert.deepEqual(candidates(t, other), []);
});

test('an invoice and its receipt from one vendor, same amount, close dates, are ONE group of two files', () => {
  const t = world();
  const invoice = receipt(t, { amount: 1900, currency: 'CHF', date: '2026-07-01' });
  const paid = receipt(t, { amount: 1900, currency: 'CHF', date: '2026-07-02' });
  const [line] = lines(t, [{ amount: 1900, date: '2026-07-02' }]);
  const groups = candidates(t, line);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].files.map((f) => f.fileId).sort(), [invoice.fileId, paid.fileId].sort());
  assert.equal(groups[0].groupKey, [invoice.fileId, paid.fileId].sort().join('+'));
  // A second month's invoice of the same amount is ANOTHER group.
  receipt(t, { amount: 1900, date: '2026-07-12' });
  const [later] = lines(t, [{ amount: 1900, date: '2026-07-08' }]);
  assert.equal(candidates(t, later).length, 2);
});

test('foreign currency: the stored rate within the tolerance, and the statement\'s own transaction amount exactly', () => {
  const t = world();
  must(recordExchangeRate(t.ctx, { baseCurrency: 'EUR', asOf: '2026-07-01', rate: '0.95', idempotencyKey: 'fx-eur' }), 'rate');
  receipt(t, { amount: 2000, currency: 'EUR', date: '2026-07-03' });
  // EUR 20.00 x 0.95 = CHF 19.00; 19.50 is 2.6 % away (fits 3 %), 19.70 is 3.6 % away (does not).
  const [near, far] = lines(t, [
    { amount: 1950, date: '2026-07-03' },
    { amount: 1970, date: '2026-07-04' },
  ]);
  assert.equal(candidates(t, near)[0]?.match.amount, 'fx_tolerance');
  assert.deepEqual(candidates(t, far), []);
  setting(t, 'belege.match_fx_tolerance_pct', 4);
  assert.equal(candidates(t, far).length, 1, 'the tolerance is the setting');
  // The statement's transaction amount in the receipt's currency wins over any rate, and is exact.
  const line = { row: { amount_minor: 1970, currency: 'CHF' }, facts: { transactionAmount: { amountMinor: 2000, currency: 'EUR' }, instructed: null } };
  assert.equal(amountMatch(t.ctx, { fxTolerancePct: 0 }, line, { amountMinor: 2000, currency: 'EUR', date: '2026-07-03' }), 'transaction_currency');
  assert.equal(amountMatch(t.ctx, { fxTolerancePct: 50 }, line, { amountMinor: 2001, currency: 'EUR', date: '2026-07-03' }), null);
  // No rate for the currency: no match.
  receipt(t, { amount: 2600, currency: 'USD', date: '2026-07-30' });
  const [usd] = lines(t, [{ amount: 2600, date: '2026-07-30' }]);
  assert.deepEqual(candidates(t, usd), []);
});

test('a booked line without its receipt gets candidates; a booked line with one, or a matched receipt, does not', () => {
  const t = world();
  const r = receipt(t, { amount: 3200, date: '2026-07-21' });
  const [line] = lines(t, [{ amount: 3200, date: '2026-07-21' }]);
  bookTo6570(t, line, 3200);
  const booked = lineOf(t, line);
  assert.equal(booked.needsReceipt, true);
  assert.equal(booked.belegCandidates.length, 1);
  // One click: files_link onto the bank line. The receipt is attached, the capture leaves the queue.
  const linked = getAction('files_link').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, fileId: r.fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: 'lk' });
  assert.equal(linked.ok, true, JSON.stringify(linked));
  assert.equal(linked.settledCaptureId, r.captureId);
  assert.equal(captureStatus(t, r.captureId), 'committed');
  const after = lineOf(t, line);
  assert.equal(after.needsReceipt, false);
  assert.equal(after.receiptCount, 1);
  assert.deepEqual(after.belegCandidates, []);
  const settled = t.store.db.prepare('SELECT entity_kind, entity_id FROM capture_settlement WHERE capture_id = ?').all(r.captureId);
  assert.deepEqual(settled, [{ entity_kind: 'bank_txn', entity_id: line }]);
});

test('files.capture_on_attach = keep leaves the capture waiting; a link to a record that is not a bank Beleg closes nothing', () => {
  const t = world();
  setting(t, 'files.capture_on_attach', 'keep');
  const r = receipt(t, { amount: 3300, date: '2026-07-22' });
  const [line] = lines(t, [{ amount: 3300, date: '2026-07-22' }]);
  bookTo6570(t, line, 3300);
  must(linkFile(t.ctx, { fileId: r.fileId, entityKind: 'bank_txn', entityId: line }));
  assert.equal(captureStatus(t, r.captureId), 'needs_review');
});

test('the receipt guard: bytes that already evidence a live booking are never a candidate', () => {
  const t = world();
  const r = receipt(t, { amount: 7700, date: '2026-07-23' });
  const [first, second] = lines(t, [
    { amount: 7700, date: '2026-07-23' },
    { amount: 7700, date: '2026-07-24' },
  ]);
  must(bookBankLine(t.ctx, { bankTxnId: first, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 7700 }] }, idempotencyKey: 'b1', attach: undefined }));
  assert.equal(candidates(t, second).length, 1, 'before the receipt is booked, both lines may take it');
  // The booking takes the receipt (book_bank_line attach): it is now held, and offered to no other line.
  const booked = getAction('book_bank_line').run({ ...t.deps, actor: 'user_1' }, {
    workspaceId: t.workspaceId,
    bankTxnId: second,
    target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 7700 }] },
    attach: [{ fileId: r.fileId }],
    idempotencyKey: 'b2',
  });
  assert.equal(booked.ok, true, JSON.stringify(booked).slice(0, 400));
  assert.equal(captureStatus(t, r.captureId), 'committed', 'the attach seam closed the capture');
  assert.deepEqual(candidates(t, first), []);
});

test('the receipt guard (critic r1 B2): bytes a posted entry holds through ANOTHER filing row are never a candidate', () => {
  const t = world();
  const r = receipt(t, { amount: 7300, date: '2026-07-23' });
  const [line] = lines(t, [{ amount: 7300, date: '2026-07-23' }]);
  assert.equal(candidates(t, line).length, 1, 'before: the receipt fits');
  // The capture stays under review and its own document unlinked: only the holder check can take it out.
  const content = must(getFileContent(t.ctx, { fileId: r.fileId }));
  const twin = must(uploadFile(t.ctx, { contentBase64: content.contentBase64, mime: 'image/png', filename: 'zwilling.png', title: 'Zwilling' })).file.id;
  const entry = must(postEntry(t.ctx, { date: '2026-02-02', source: 'manual', description: 'Zwilling', idempotencyKey: 'b2-entry', lines: [{ account: t.acc('6570'), debit: 7300 }, { account: t.acc('1020'), credit: 7300 }] })).entryId;
  must(linkFile(t.ctx, { fileId: twin, entityKind: 'journal_entry', entityId: entry }));
  assert.equal(captureStatus(t, r.captureId), 'needs_review');
  assert.deepEqual(candidates(t, line), [], 'the same bytes evidence a posted entry: never offered (R1)');
});

test('belege.match_mode = off: no line carries a candidate', () => {
  const t = world();
  receipt(t, { amount: 990, date: '2026-07-25' });
  const [line] = lines(t, [{ amount: 990, date: '2026-07-25' }]);
  assert.equal(candidates(t, line).length, 1);
  setting(t, 'belege.match_mode', 'off');
  assert.deepEqual(candidates(t, line), []);
});

test('§H-TENANT: another workspace\'s receipt never pairs with this workspace\'s line', () => {
  const t = world();
  const b = secondWorkspace(t);
  receipt(t, { amount: 4100, date: '2026-07-26', ctx: b.ctx });
  const [line] = lines(t, [{ amount: 4100, date: '2026-07-26' }]);
  assert.deepEqual(candidates(t, line), []);
});

test('the capture side: list_captures names the bank line a captured receipt fits', () => {
  const t = world();
  const r = receipt(t, { amount: 5600, date: '2026-07-27' });
  const lonely = receipt(t, { amount: 5601, date: '2026-07-27' });
  const [line] = lines(t, [{ amount: 5600, date: '2026-07-28' }]);
  const listed = getAction('list_captures').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId });
  assert.equal(listed.ok, true, JSON.stringify(listed).slice(0, 300));
  const mine = listed.captures.find((c) => c.id === r.captureId);
  assert.deepEqual(mine.bankLineCandidates.map((c) => [c.bankTxnId, c.state, c.amountMinor, c.bookingDate]), [[line, 'open', -5600, '2026-07-28']]);
  assert.deepEqual(listed.captures.find((c) => c.id === lonely.captureId).bankLineCandidates, []);
});

test('critic r2 R2: a reopen takes the capture back to pending on the line; booking again closes it again, the history kept', () => {
  const t = world();
  const r = receipt(t, { amount: 4700, date: '2026-07-27' });
  const [line] = lines(t, [{ amount: 4700, date: '2026-07-27' }]);
  must(getAction('book_bank_line').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 4700 }] }, attach: [{ fileId: r.fileId }], idempotencyKey: 'r2-a' }));
  assert.equal(captureStatus(t, r.captureId), 'committed');
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'falsch gebucht', idempotencyKey: 'r2-re' }));
  assert.equal(captureStatus(t, r.captureId), 'needs_review', 'no posting holds it any more');
  assert.equal(lineOf(t, line).receiptCount, 1, 'attached and pending on the reopened line');
  bookTo6570(t, line, 4700);
  assert.equal(captureStatus(t, r.captureId), 'committed', 'the new booking holds it again');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM capture_settlement WHERE capture_id = ?').get(r.captureId).n, 2, 'both closings stay on record');
});

test('critic r1 P4: a receipt filed on an OPEN line keeps its capture open until the line is booked; an ignore frees it', () => {
  const t = world();
  const r = receipt(t, { amount: 4400, date: '2026-07-23' });
  const [line, other] = lines(t, [
    { amount: 4400, date: '2026-07-23' },
    { amount: 4400, date: '2026-07-24' },
  ]);
  const link = (id, fileId, key) => getAction('files_link').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, fileId, entityKind: 'bank_txn', entityId: id, idempotencyKey: key });
  const linked = link(line, r.fileId, 'lk-open');
  assert.equal(linked.ok, true, JSON.stringify(linked));
  assert.equal(linked.settledCaptureId, null);
  assert.equal(captureStatus(t, r.captureId), 'needs_review', 'attached, pending: no posting holds it yet');
  // The booking of that line closes it, in its own transaction.
  bookTo6570(t, line, 4400);
  assert.equal(captureStatus(t, r.captureId), 'committed');
  assert.deepEqual(t.store.db.prepare('SELECT entity_kind, entity_id FROM capture_settlement WHERE capture_id = ?').all(r.captureId), [{ entity_kind: 'bank_txn', entity_id: line }]);
  // Ignore path: a receipt filed on an open line that is then ignored stays in the queue and is a candidate again.
  const r2 = receipt(t, { amount: 4400, date: '2026-07-24' });
  must(link(other, r2.fileId, 'lk-other'));
  const [third] = lines(t, [{ amount: 4400, date: '2026-07-25' }]);
  assert.deepEqual(candidates(t, third), [], 'filed on an open line: not offered elsewhere');
  must(ignoreBankLine(t.ctx, { bankTxnId: other, reason: 'booked_elsewhere', note: 'Test', idempotencyKey: 'ign-p4' }));
  assert.equal(captureStatus(t, r2.captureId), 'needs_review');
  assert.deepEqual(candidates(t, third).map((g) => g.files[0].fileId), [r2.fileId], 'free again after the ignore');
});
