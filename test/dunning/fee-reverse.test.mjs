// A15 money path: `dunning_fee_reverse` (D169, the D141.3 follow-up, owner decision 14.10.2026).
//
// Before D169 a dunning run's Mahngebühr had no undo verb. The raw `reverse_entry` reversed the fee
// entry and nothing else knew: an UNSENT letter still mailed the fee as demanded, and the run gave no
// sign the fee was gone. Each assertion here fails if the owning verb, the row-backed ownership in
// `OWNED_REVERSAL_SOURCES`, the settled-fee refusal, the chain walk, the send guard or the row
// idempotency is removed. All fixtures are synthetic (invented names, addresses and amounts).

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { reverseOwnedEntry } from '../../dist/core/ledger/reverseEntry.js';
import { freshDeps, mintWorkspace, recordingRelay } from '../api/support.mjs';

const TODAY = '2026-07-16';
const FEE = 3000;
const call = (deps, name, input) => getAction(name).run(deps, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

/** A VAT-seeded workspace, a QR-IBAN creditor, a level-1 fee of CHF 30 booking to 3600. */
function world() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat_seed_defaults');
  must(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }), 'set_vat_method');
  must(
    call(deps, 'set_creditor_profile', {
      workspaceId,
      creditorName: 'Beispiel Treuhand AG',
      address: { street: 'Seeweg', buildingNo: '7', zip: '6000', town: 'Luzern', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    }),
    'set_creditor_profile',
  );
  must(
    call(deps, 'set_dunning_config', {
      workspaceId,
      levels: [
        { level: 1, daysOverdue: 10, feeMinor: FEE, bookFee: true, feeIncomeAccountId: accId('3600') },
        { level: 2, daysOverdue: 20, feeMinor: 0 },
        { level: 3, daysOverdue: 30, feeMinor: 0 },
      ],
      idempotencyKey: 'cfg',
    }),
    'set_dunning_config',
  );
  return { deps, workspaceId, accId };
}

function debtorWithInvoice(w, tag) {
  const { deps, workspaceId } = w;
  const customerId = must(
    call(deps, 'create_contact', {
      workspaceId,
      partyRole: 'customer',
      name: `Kundin ${tag}`,
      address: { street: 'Dorfstrasse', houseNo: '3', zip: '4000', city: 'Basel', country: 'CH' },
      email: `${tag.toLowerCase()}@kundin.example`,
      idempotencyKey: `contact-${tag}`,
    }),
    'create_contact',
  ).contact.id;
  const documentId = must(
    call(deps, 'create_document', {
      workspaceId,
      type: 'invoice',
      contactId: customerId,
      currency: 'CHF',
      dueDate: '2026-06-01',
      lines: [{ description: 'Gartenpflege', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: `doc-${tag}`,
    }),
    'create_document',
  ).document.id;
  must(call(deps, 'issue_invoice', { workspaceId, invoiceId: documentId, idempotencyKey: `issue-${tag}` }), 'issue_invoice');
  return { customerId, documentId };
}

/** An issued run with one fee-bearing letter; returns the run, its fee entry and the item. */
function issuedRun(w, tag = 'A') {
  const debtor = debtorWithInvoice(w, tag);
  const proposed = must(call(w.deps, 'propose_dunning_run', { workspaceId: w.workspaceId, idempotencyKey: `p-${tag}` }), 'propose');
  const issued = must(call(w.deps, 'issue_dunning_run', { workspaceId: w.workspaceId, runId: proposed.runId, confirmed: true, idempotencyKey: `i-${tag}` }), 'issue');
  const run = w.deps.store.db.prepare('SELECT * FROM dunning_run WHERE id = ?').get(proposed.runId);
  assert.ok(run.fee_entry_id, 'premise: the fee booked');
  const item = issued.items.find((i) => i.documentId === debtor.documentId);
  return { runId: proposed.runId, feeEntryId: run.fee_entry_id, item, ...debtor };
}

function counts(w) {
  const db = w.deps.store.db;
  const n = (sql) => db.prepare(sql).get(w.workspaceId).n;
  return {
    entries: n('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?'),
    lines: n('SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?'),
    runs: n('SELECT COUNT(*) AS n FROM dunning_run WHERE workspace_id = ?'),
    items: n('SELECT COUNT(*) AS n FROM dunning_item WHERE workspace_id = ?'),
  };
}

function balance(w, number) {
  return w.deps.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS b FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND a.number = ?`,
    )
    .get(w.workspaceId, number).b;
}

function lines(w, entryId) {
  return w.deps.store.db
    .prepare('SELECT a.number AS n, l.base_debit_minor AS d, l.base_credit_minor AS c, l.tax_code AS tc, l.tax_amount_minor AS ta FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY a.number')
    .all(entryId);
}

function ctxOf(w) {
  return makeContext(w.deps.store, {
    workspaceId: w.workspaceId,
    actor: 'user_1',
    clock: w.deps.clock,
    ids: w.deps.ids,
    ...ledgerPorts({ store: w.deps.store, workspaceId: w.workspaceId, ids: w.deps.ids }),
  });
}

/** The raw Storno a book written before D169 could carry, simulated under the owner token. */
function legacyRawReverse(w, entryId, key) {
  const r = reverseOwnedEntry(ctxOf(w), { entryId, idempotencyKey: key }, 'dunning_fee_reverse');
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.reversalId;
}

const reverse = (w, runId, key, reason = 'Gebühr erlassen') =>
  call(w.deps, 'dunning_fee_reverse', { workspaceId: w.workspaceId, runId, reason, idempotencyKey: key });

test('D169: an issued run\'s fee is mirrored by one owned A02 entry dated today; the run and its letters stand', () => {
  const w = world();
  const r = issuedRun(w);
  assert.equal(balance(w, '3600') !== 0, true, 'premise: fee income booked');
  const before = counts(w);

  const res = reverse(w, r.runId, 'rev-1');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(typeof res.reversalEntryId, 'string');
  assert.equal(res.feeEntryId, r.feeEntryId);

  const mirror = w.deps.store.db.prepare('SELECT source, reverses_entry_id, date, description FROM journal_entry WHERE id = ?').get(res.reversalEntryId);
  assert.equal(mirror.source, 'reversal');
  assert.equal(mirror.reverses_entry_id, r.feeEntryId);
  assert.equal(mirror.date, TODAY, 'dated today (OR 957a)');
  assert.match(mirror.description, /Gebühr erlassen/);

  // Line by line the mirror swaps debit and credit and negates the VAT trace (D69's split rides back).
  const original = lines(w, r.feeEntryId).map((l) => ({ n: l.n, d: l.c, c: l.d, tc: l.tc, ta: l.ta === null ? null : -l.ta }));
  assert.deepEqual(lines(w, res.reversalEntryId).map((l) => ({ n: l.n, d: l.d, c: l.c, tc: l.tc, ta: l.ta })), original);
  assert.ok(lines(w, r.feeEntryId).some((l) => l.ta !== null && l.ta !== 0), 'premise: the fee carried output VAT');
  assert.equal(balance(w, '3600'), 0, 'fee income nets to zero');

  const run = w.deps.store.db.prepare('SELECT status, fee_entry_id FROM dunning_run WHERE id = ?').get(r.runId);
  assert.equal(run.status, 'issued', 'the run stays issued: the letter exists');
  assert.equal(run.fee_entry_id, r.feeEntryId, 'the fee entry id is untouched');
  const after = counts(w);
  assert.equal(after.entries, before.entries + 1, 'exactly one mirror');
  assert.equal(after.items, before.items, 'no dunning row added or removed');

  // The fee leaves A16 (the open item no longer carries it) and the run read names the reversal.
  const open = must(call(w.deps, 'list_open_items', { workspaceId: w.workspaceId }), 'list_open_items');
  const row = open.items.find((i) => i.documentId === r.documentId);
  assert.equal(row.dunningFeeMinor, 0);
  const view = must(call(w.deps, 'get_dunning_run', { workspaceId: w.workspaceId, runId: r.runId }), 'get_dunning_run');
  assert.equal(view.feeReversalEntryId, res.reversalEntryId);
});

test('D169: idempotent on ROWS: the same key replays, a new key refuses already_reversed, nothing is written twice', () => {
  const w = world();
  const r = issuedRun(w);
  const first = must(reverse(w, r.runId, 'idem-1'), 'first');
  const once = counts(w);
  const replay = reverse(w, r.runId, 'idem-1');
  assert.equal(replay.ok, true);
  assert.equal(replay.reversalEntryId, first.reversalEntryId);
  assert.deepEqual(counts(w), once, 'a replay writes no row');
  const again = reverse(w, r.runId, 'idem-2');
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_reversed');
  assert.equal(again.reversalEntryId, first.reversalEntryId);
  assert.deepEqual(counts(w), once, 'a second reverse writes no row');
  assert.equal(balance(w, '3600'), 0);
});

test('D169: a fee a payment SETTLED refuses fee_settled naming the payment; after reverse_payment it reverses', () => {
  const w = world();
  const r = issuedRun(w);
  const paid = must(call(w.deps, 'record_payment', {
    workspaceId: w.workspaceId,
    direction: 'incoming',
    date: TODAY,
    amountMinor: FEE,
    bankAccountId: w.accId('1020'),
    counterpartyKind: 'customer',
    counterpartyId: r.customerId,
    allocations: [{ dunningItemId: r.item.id, amountMinor: FEE }],
    intent: 'post_payment',
    idempotencyKey: 'pay-fee',
  }), 'record_payment');
  const before = counts(w);
  const refused = reverse(w, r.runId, 'paid-rev');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'fee_settled');
  assert.deepEqual(refused.paymentIds, [paid.paymentId]);
  assert.match(refused.hint, /reverse_payment/);
  assert.deepEqual(counts(w), before, 'the refusal wrote nothing');

  must(call(w.deps, 'reverse_payment', { workspaceId: w.workspaceId, paymentId: paid.paymentId, date: TODAY, intent: 'reverse_payment', idempotencyKey: 'pay-fee-rev' }), 'reverse_payment');
  const res = reverse(w, r.runId, 'paid-rev-2');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(balance(w, '3600'), 0);
});

test('D169: a proposed run, a run with no fee, and a deferred (period-locked) fee each refuse and write nothing', () => {
  const w = world();
  debtorWithInvoice(w, 'P');
  const proposed = must(call(w.deps, 'propose_dunning_run', { workspaceId: w.workspaceId, idempotencyKey: 'pp' }), 'propose');
  const before = counts(w);
  const p = reverse(w, proposed.runId, 'pp-rev');
  assert.equal(p.error, 'invalid_transition');
  assert.match(p.hint, /discard_dunning_run/);

  // Lock the period, issue: the fee is skipped and named, so there is no fee entry to reverse.
  must(call(w.deps, 'lock_period', { workspaceId: w.workspaceId, period: '2026-07', kind: 'hard', idempotencyKey: 'lk' }), 'lock');
  must(call(w.deps, 'issue_dunning_run', { workspaceId: w.workspaceId, runId: proposed.runId, confirmed: true, idempotencyKey: 'pp-i' }), 'issue');
  const nf = reverse(w, proposed.runId, 'pp-rev-2');
  assert.equal(nf.error, 'no_fee_booked');
  assert.equal(nf.feeSkippedReason, 'period_locked');
  assert.equal(counts(w).entries, before.entries);
});

test('D169: a locked period refuses period_locked before any write', () => {
  const w = world();
  const r = issuedRun(w);
  must(call(w.deps, 'lock_period', { workspaceId: w.workspaceId, period: '2026-07', kind: 'hard', idempotencyKey: 'lk2' }), 'lock');
  const before = counts(w);
  const res = reverse(w, r.runId, 'lk-rev');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked');
  assert.deepEqual(counts(w), before);
});

test('D169: a reason is required, dun AND post are required, and another tenant sees not_found', () => {
  const w = world();
  const r = issuedRun(w);
  const before = counts(w);
  assert.equal(reverse(w, r.runId, 'g-1', '   ').error, 'reason_required');
  const other = mintWorkspace(w.deps, 'Fremd GmbH', 'ws-2');
  const foreign = call(w.deps, 'dunning_fee_reverse', { workspaceId: other.workspaceId, runId: r.runId, reason: 'x', idempotencyKey: 'g-2' });
  assert.equal(foreign.error, 'not_found');
  assert.deepEqual(counts(w), before);
  const { CAPABILITY_FOR_ACTION } = getCaps();
  assert.deepEqual(CAPABILITY_FOR_ACTION.dunning_fee_reverse, ['dun', 'post']);
});

import { CAPABILITY_FOR_ACTION as CAPS } from '../../dist/core/access/actionCapabilities.js';
function getCaps() {
  return { CAPABILITY_FOR_ACTION: CAPS };
}

test('D169 ownership: raw reverse_entry on a run\'s fee entry refuses owned_by dunning_fee_reverse, and so does its mirror', () => {
  const w = world();
  const r = issuedRun(w);
  const before = counts(w);
  const raw = call(w.deps, 'reverse_entry', { workspaceId: w.workspaceId, entryId: r.feeEntryId, idempotencyKey: 'raw' });
  assert.equal(raw.ok, false, `the raw Storno must not bypass the run: ${JSON.stringify(raw)}`);
  assert.equal(raw.error, 'owned_by');
  assert.equal(raw.verb, 'dunning_fee_reverse');
  assert.deepEqual(counts(w), before);

  const res = must(reverse(w, r.runId, 'own-rev'), 'reverse');
  const rawMirror = call(w.deps, 'reverse_entry', { workspaceId: w.workspaceId, entryId: res.reversalEntryId, idempotencyKey: 'raw-mirror' });
  assert.equal(rawMirror.ok, false);
  assert.equal(rawMirror.verb, 'dunning_fee_reverse');
});

test('D169 as amended by D174: an UNSENT letter is re-issued without the reversed fee and sent; a sent run reverses and records it', () => {
  const w = world();
  const a = issuedRun(w, 'A');
  must(reverse(w, a.runId, 'unsent-rev'), 'reverse');
  const view = must(call(w.deps, 'get_dunning_run', { workspaceId: w.workspaceId, runId: a.runId }), 'get');
  assert.equal(view.items[0].changeSinceIssue, null, 'D174: re-frozen without the fee, so no longer held');
  assert.equal(view.items[0].demandedFeeMinor, 0);
  assert.equal(view.items[0].reissuedWithoutFee, true);
  const relay = recordingRelay();
  w.deps.emailRelay = relay;
  const sent = must(call(w.deps, 'send_dunning_run', { workspaceId: w.workspaceId, runId: a.runId, confirmed: true, idempotencyKey: 'unsent-send' }), 'send');
  assert.equal(relay.sent.length, 1, 'the re-issued letter, which no longer demands the fee, leaves');
  assert.equal(sent.outcomes[0].outcome, 'sent');

  // A run whose letter already went out: the fee reverses (a waiver after the letter), the letter stands.
  const w2 = world();
  const b = issuedRun(w2, 'B');
  const relay2 = recordingRelay();
  w2.deps.emailRelay = relay2;
  must(call(w2.deps, 'send_dunning_run', { workspaceId: w2.workspaceId, runId: b.runId, confirmed: true, idempotencyKey: 'b-send' }), 'send');
  assert.equal(relay2.sent.length, 1);
  const res = must(reverse(w2, b.runId, 'sent-rev'), 'reverse sent');
  assert.equal(res.lettersSent, 1, 'the result records that the letter already went out');
  assert.equal(w2.deps.store.db.prepare('SELECT status FROM dunning_run WHERE id = ?').get(b.runId).status, 'sent');
});

test('critic lesson (D168 r1): a legacy raw-reversed fee answers already_reversed naming that mirror, nothing posted', () => {
  const w = world();
  const r = issuedRun(w);
  const mirror = legacyRawReverse(w, r.feeEntryId, 'legacy');
  const before = counts(w);
  const res = reverse(w, r.runId, 'adopt-rev');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'already_reversed');
  assert.equal(res.reversalEntryId, mirror);
  assert.deepEqual(counts(w), before);
  // ...and the forward act refuses: the unsent letter no longer demands a fee that is gone.
  const view = must(call(w.deps, 'get_dunning_run', { workspaceId: w.workspaceId, runId: r.runId }), 'get');
  assert.equal(view.feeReversalEntryId, mirror);
  assert.equal(view.items[0].changeSinceIssue, 'fee_reversed');
});

test('critic lesson (D168 r1): a double-reversed chain (the fee stands again) posts a fresh mirror of the LAST link', () => {
  const w = world();
  const r = issuedRun(w);
  const r1 = legacyRawReverse(w, r.feeEntryId, 'l1');
  const r2 = legacyRawReverse(w, r1, 'l2');
  assert.notEqual(balance(w, '3600'), 0, 'premise: the fee stands again');
  const view = must(call(w.deps, 'get_dunning_run', { workspaceId: w.workspaceId, runId: r.runId }), 'get');
  assert.equal(view.feeReversalEntryId, null, 'an even chain: the fee stands');
  const before = counts(w);
  const res = must(reverse(w, r.runId, 'chain-rev'), 'reverse');
  const mirror = w.deps.store.db.prepare('SELECT reverses_entry_id FROM journal_entry WHERE id = ?').get(res.reversalEntryId);
  assert.equal(mirror.reverses_entry_id, r2);
  assert.equal(counts(w).entries, before.entries + 1);
  assert.equal(balance(w, '3600'), 0, 'fee income nets to zero');
});

test('critic L1 (D169): an EVEN legacy chain (F, R1, R2) keeps the fee live in the Debitorenbuch; an odd one drops it', () => {
  const w = world();
  const r = issuedRun(w);
  const r1 = legacyRawReverse(w, r.feeEntryId, 'l1-a');
  const odd = must(call(w.deps, 'list_open_items', { workspaceId: w.workspaceId }), 'odd');
  assert.equal(odd.items.find((i) => i.documentId === r.documentId).dunningFeeMinor, 0, 'odd chain: the fee is gone');
  legacyRawReverse(w, r1, 'l1-b');
  const even = must(call(w.deps, 'list_open_items', { workspaceId: w.workspaceId }), 'even');
  assert.equal(even.items.find((i) => i.documentId === r.documentId).dunningFeeMinor, FEE, 'even chain: the ledger carries the fee, so does A16');
  assert.equal(even.reconciled, true, 'open items tie to 1100');
});
