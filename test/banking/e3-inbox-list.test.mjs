// @ts-check
/**
 * D178 E3 (A39 §17.6): `list_bank_inbox` counts honestly under every filter and pages past the 200 cap.
 *
 * SYNTHETIC BY CONSTRUCTION: 250 invented lines in one hand-spelled statement.
 *
 * Held: `total` respects the date range, the direction, the state and the search together, across all
 * pages; `directionCounts` counts the same filters without the direction; the cursor and the offset walk
 * the SAME stable order and together see every line exactly once; bad paging input is refused; a contact
 * booking's decision names its contact.
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { world, importLines, must, refused, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { bookBankLine, listBankInbox } from '../../dist/core/banking/index.js';

afterEach(assertClaimInvariantHolds);

/** 250 lines over July: every third one money in, dates spread over the month. */
function manyLines(t) {
  const entries = [];
  for (let i = 0; i < 250; i += 1) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    entries.push({
      ref: `L${String(i).padStart(3, '0')}`,
      amountMinor: 1000 + i,
      cd: i % 3 === 0 ? 'CRDT' : 'DBIT',
      date: `2026-07-${day}`,
      name: i % 5 === 0 ? 'Papeterie Seeblick' : 'Muster AG',
    });
  }
  return importLines(t, { statementId: 'e3l', entries });
}

test('total and directionCounts respect every filter; the direction narrows total and the page', () => {
  const t = world();
  manyLines(t);
  const all = must(listBankInbox(t.ctx, { limit: 1 }), 'all');
  assert.equal(all.total, 250);
  assert.deepEqual(all.directionCounts, { in: 84, out: 166 });
  const inOnly = must(listBankInbox(t.ctx, { direction: 'in', limit: 200 }), 'in');
  assert.equal(inOnly.total, 84);
  assert.equal(inOnly.lines.length, 84);
  assert.ok(inOnly.lines.every((l) => l.creditDebit === 'CRDT'));
  assert.deepEqual(inOnly.directionCounts, { in: 84, out: 166 }, 'the chips count without the direction');
  // Date range plus direction plus search, counted against the rows themselves.
  const narrow = must(listBankInbox(t.ctx, { from: '2026-07-10', to: '2026-07-20', direction: 'out', query: 'seeblick', limit: 200 }), 'narrow');
  const expected = [];
  for (let i = 0; i < 250; i += 1) {
    const day = 1 + (i % 28);
    if (day >= 10 && day <= 20 && i % 3 !== 0 && i % 5 === 0) expected.push(i);
  }
  assert.equal(narrow.total, expected.length);
  assert.equal(narrow.lines.length, expected.length);
  const narrowIn = must(listBankInbox(t.ctx, { from: '2026-07-10', to: '2026-07-20', query: 'seeblick', limit: 1 }), 'narrow counts');
  assert.equal(narrowIn.directionCounts.in + narrowIn.directionCounts.out, narrowIn.total);
  // A decided line leaves the open state's count, and the counts follow it.
  must(bookBankLine(t.ctx, { bankTxnId: inOnly.lines[0].bankTxnId, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'b1' }), 'book one');
  assert.equal(must(listBankInbox(t.ctx, { direction: 'in', limit: 1 }), 'after').total, 83);
  const booked = must(listBankInbox(t.ctx, { status: 'booked', limit: 10 }), 'booked');
  assert.equal(booked.total, 1);
  assert.equal(booked.lines[0].decision.targetKind, 'contact');
  assert.equal(booked.lines[0].decision.contactId, t.customerId);
});

test('cursor and offset page past 200 through ONE stable order and see every line exactly once', () => {
  const t = world();
  manyLines(t);
  const first = must(listBankInbox(t.ctx, { limit: 200 }), 'page 1');
  assert.equal(first.lines.length, 200);
  assert.notEqual(first.nextCursor, null);
  const second = must(listBankInbox(t.ctx, { limit: 200, cursor: first.nextCursor }), 'page 2');
  assert.equal(second.lines.length, 50);
  assert.equal(second.nextCursor, null);
  const byCursor = [...first.lines, ...second.lines].map((l) => l.bankTxnId);
  assert.equal(new Set(byCursor).size, 250, 'every line once');
  const byOffset = [
    ...must(listBankInbox(t.ctx, { limit: 200, offset: 0 }), 'o1').lines,
    ...must(listBankInbox(t.ctx, { limit: 200, offset: 200 }), 'o2').lines,
  ].map((l) => l.bankTxnId);
  assert.deepEqual(byOffset, byCursor, 'the offset walks the same order as the cursor');
  // Small pages by offset agree with the big one.
  const small = [];
  for (let off = 0; off < 250; off += 37) small.push(...must(listBankInbox(t.ctx, { limit: 37, offset: off }), `o${off}`).lines.map((l) => l.bankTxnId));
  assert.deepEqual(small, byCursor);
  // Newest first.
  const dates = byCursor.map((id) => [...first.lines, ...second.lines].find((l) => l.bankTxnId === id).bookingDate);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('bad paging and direction input is refused', () => {
  const t = world();
  manyLines(t);
  const first = must(listBankInbox(t.ctx, { limit: 10 }), 'page');
  refused(listBankInbox(t.ctx, { direction: 'sideways' }), 'invalid_input');
  refused(listBankInbox(t.ctx, { offset: -1 }), 'invalid_input');
  refused(listBankInbox(t.ctx, { offset: 1.5 }), 'invalid_input');
  refused(listBankInbox(t.ctx, { offset: 10, cursor: first.nextCursor }), 'invalid_input');
});
