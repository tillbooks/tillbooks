// A15 money path: D174 (owner decision Q1, 15.10.2026, amends D73 for UNSENT letters only).
// When a run's fee is reversed, every letter that has not left is re-frozen WITHOUT the fee and is
// sendable; a letter already sent (or whose transport outcome is unknown) stays exactly as it went.
// The helpers below are copied from fee-reverse.test.mjs, whose D169 header follows.
//
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

function debtorWithInvoice(w, tag, { email = true } = {}) {
  const { deps, workspaceId } = w;
  const customerId = must(
    call(deps, 'create_contact', {
      workspaceId,
      partyRole: 'customer',
      name: `Kundin ${tag}`,
      address: { street: 'Dorfstrasse', houseNo: '3', zip: '4000', city: 'Basel', country: 'CH' },
      ...(email ? { email: `${tag.toLowerCase()}@kundin.example` } : {}),
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


const item = (w, id) => w.deps.store.db.prepare('SELECT * FROM dunning_item WHERE id = ?').get(id);
const itemsOf = (w, runId) => w.deps.store.db.prepare('SELECT * FROM dunning_item WHERE run_id = ? ORDER BY debtor_id, id').all(runId);
const refreezeAudits = (w) => w.deps.store.db
  .prepare("SELECT entity_id FROM audit_log WHERE workspace_id = ? AND entity_kind = 'dunning_item' AND action = 'refreeze_without_fee' ORDER BY rowid")
  .all(w.workspaceId).map((r) => r.entity_id);
const pdfOf = (w, runId, debtorId) => must(call(w.deps, 'get_dunning_pdf', { workspaceId: w.workspaceId, runId, debtorId }), 'pdf').pdf;

/** Two debtors on ONE run: A with an email, B with or without one. */
function twoDebtorRun(w, { bEmail = false } = {}) {
  const a = debtorWithInvoice(w, 'A');
  const b = debtorWithInvoice(w, 'B', { email: bEmail });
  const proposed = must(call(w.deps, 'propose_dunning_run', { workspaceId: w.workspaceId, idempotencyKey: 'p-ab' }), 'propose');
  const issued = must(call(w.deps, 'issue_dunning_run', { workspaceId: w.workspaceId, runId: proposed.runId, confirmed: true, idempotencyKey: 'i-ab' }), 'issue');
  const itemA = issued.items.find((i) => i.documentId === a.documentId);
  const itemB = issued.items.find((i) => i.documentId === b.documentId);
  assert.equal(itemA.demandedFeeMinor, FEE, 'premise: A demands the fee');
  assert.equal(itemB.demandedFeeMinor, FEE, 'premise: B demands the fee');
  return { runId: proposed.runId, a, b, itemA, itemB };
}

test('D174: an UNSENT letter is re-frozen without the fee in the reverse itself, and send mails it', () => {
  const w = world();
  const r = issuedRun(w, 'A');
  const before = item(w, r.item.id);
  const pdfBefore = pdfOf(w, r.runId, r.customerId);
  assert.equal(pdfBefore.qrParts[0].amountMinor, before.overdue_minor + FEE, 'premise: the QR asks for the fee');

  const res = must(reverse(w, r.runId, 'rf-1'), 'reverse');
  assert.deepEqual(res.lettersReissuedItemIds, [r.item.id]);
  const after = item(w, r.item.id);
  assert.equal(after.demanded_fee_minor, 0, 'the fee line leaves the frozen demand');
  // Nothing else moves: every other frozen figure is the issue-time one.
  assert.deepEqual({ ...after, demanded_fee_minor: FEE }, before, 'only demanded_fee_minor changed');
  assert.equal(after.fee_minor, FEE, 'the superseded demand stays reconstructible from fee_minor');
  assert.deepEqual(refreezeAudits(w), [r.item.id], 'one append-only audit row records the superseded freeze');

  const pdf = pdfOf(w, r.runId, r.customerId);
  assert.equal(pdf.qrParts[0].amountMinor, before.overdue_minor, 'the QR amount drops the fee');
  assert.equal(pdf.qrParts[0].reference, pdfBefore.qrParts[0].reference, 'the QRR reference is unchanged');

  const view = must(call(w.deps, 'get_dunning_run', { workspaceId: w.workspaceId, runId: r.runId }), 'get');
  assert.equal(view.items[0].changeSinceIssue, null, 'no longer held');
  assert.equal(view.items[0].reissuedWithoutFee, true);
  assert.equal(view.debtors[0].reissuedWithoutFee, true);
  assert.equal(view.debtors[0].totalsByCurrency.CHF, before.overdue_minor);

  const relay = recordingRelay();
  w.deps.emailRelay = relay;
  const sent = must(call(w.deps, 'send_dunning_run', { workspaceId: w.workspaceId, runId: r.runId, confirmed: true, idempotencyKey: 'rf-send' }), 'send');
  assert.equal(relay.sent.length, 1, 'the re-issued letter leaves');
  assert.equal(sent.outcomes[0].outcome, 'sent');
  assert.equal(w.deps.store.db.prepare('SELECT status FROM dunning_run WHERE id = ?').get(r.runId).status, 'sent');
});

test('D174: a SENT letter is untouched (row and PDF identical); a mixed run re-freezes only the unsent letter', () => {
  const w = world();
  const r = twoDebtorRun(w, { bEmail: false });
  const relay = recordingRelay();
  w.deps.emailRelay = relay;
  const first = must(call(w.deps, 'send_dunning_run', { workspaceId: w.workspaceId, runId: r.runId, confirmed: true, idempotencyKey: 'mix-1' }), 'send');
  assert.equal(relay.sent.length, 1, 'premise: A sent, B has no email');
  assert.ok(first.outcomes.some((o) => o.debtorId === r.b.customerId && o.outcome === 'no_email'));
  const aBefore = item(w, r.itemA.id);
  const aPdfBefore = pdfOf(w, r.runId, r.a.customerId).base64;
  assert.notEqual(aBefore.sent_at, null);

  const res = must(reverse(w, r.runId, 'mix-rev'), 'reverse');
  assert.equal(res.lettersSent, 1);
  assert.deepEqual(res.lettersReissuedItemIds, [r.itemB.id], 'only the unsent letter');
  assert.deepEqual(item(w, r.itemA.id), aBefore, 'the sent letter row is identical (D73)');
  assert.equal(pdfOf(w, r.runId, r.a.customerId).base64, aPdfBefore, 'the sent letter reprints byte-identically');
  assert.equal(item(w, r.itemB.id).demanded_fee_minor, 0);
  assert.deepEqual(refreezeAudits(w), [r.itemB.id]);

  // B gets an address; the re-issued letter goes out, A is not sent again.
  w.deps.store.db.prepare("UPDATE contact SET email = 'b@kundin.example' WHERE id = ?").run(r.b.customerId);
  const second = must(call(w.deps, 'send_dunning_run', { workspaceId: w.workspaceId, runId: r.runId, confirmed: true, idempotencyKey: 'mix-2' }), 'send');
  assert.equal(relay.sent.length, 2);
  assert.deepEqual(second.outcomes.map((o) => o.outcome).sort(), ['already_sent', 'sent']);
});

test('D174: a letter whose transport outcome is unknown (dispatching) counts as sent and is never re-frozen', () => {
  const w = world();
  const r = issuedRun(w, 'A');
  w.deps.store.db.prepare("UPDATE dunning_item SET send_error = 'dispatching' WHERE id = ?").run(r.item.id);
  const before = item(w, r.item.id);
  const res = must(reverse(w, r.runId, 'disp-rev'), 'reverse');
  assert.deepEqual(res.lettersReissuedItemIds, []);
  assert.deepEqual(item(w, r.item.id), before);
  assert.deepEqual(refreezeAudits(w), []);
  const view = must(call(w.deps, 'get_dunning_run', { workspaceId: w.workspaceId, runId: r.runId }), 'get');
  assert.equal(view.items[0].changeSinceIssue, 'fee_reversed', 'the hold remains for the one case that cannot be re-frozen');
});

test('D174: idempotent on ROWS: a replay and a new key write no second re-freeze or audit row', () => {
  const w = world();
  const r = issuedRun(w, 'A');
  must(reverse(w, r.runId, 'id-1'), 'reverse');
  const rows = itemsOf(w, r.runId);
  const audits = refreezeAudits(w);
  assert.equal(audits.length, 1);
  assert.equal(reverse(w, r.runId, 'id-1').ok, true);
  assert.equal(reverse(w, r.runId, 'id-2').error, 'already_reversed');
  // A send under the lazy path finds nothing left to re-freeze either.
  w.deps.emailRelay = recordingRelay();
  must(call(w.deps, 'send_dunning_run', { workspaceId: w.workspaceId, runId: r.runId, confirmed: true, idempotencyKey: 'id-send' }), 'send');
  assert.deepEqual(refreezeAudits(w), audits, 'exactly one audit row per item');
  const strip = (i) => ({ ...i, sent_at: null, send_error: null });
  assert.deepEqual(itemsOf(w, r.runId).map(strip), rows.map(strip));
});

test('D174 legacy: a fee raw-reversed before D169 is re-frozen lazily at send, and the letter leaves without it', () => {
  const w = world();
  const r = issuedRun(w, 'A');
  legacyRawReverse(w, r.feeEntryId, 'legacy-rf');
  const held = must(call(w.deps, 'get_dunning_run', { workspaceId: w.workspaceId, runId: r.runId }), 'get');
  assert.equal(held.items[0].changeSinceIssue, 'fee_reversed', 'a read writes nothing: still flagged until send');
  const relay = recordingRelay();
  w.deps.emailRelay = relay;
  const sent = must(call(w.deps, 'send_dunning_run', { workspaceId: w.workspaceId, runId: r.runId, confirmed: true, idempotencyKey: 'legacy-send' }), 'send');
  assert.equal(sent.outcomes[0].outcome, 'sent');
  assert.equal(relay.sent.length, 1);
  assert.equal(item(w, r.item.id).demanded_fee_minor, 0);
  assert.deepEqual(refreezeAudits(w), [r.item.id]);
  assert.equal(sent.items[0].reissuedWithoutFee, true);
});

test('D174: an even legacy chain (the fee stands again) re-freezes nothing at send', () => {
  const w = world();
  const r = issuedRun(w, 'A');
  const r1 = legacyRawReverse(w, r.feeEntryId, 'e1');
  legacyRawReverse(w, r1, 'e2');
  w.deps.emailRelay = recordingRelay();
  must(call(w.deps, 'send_dunning_run', { workspaceId: w.workspaceId, runId: r.runId, confirmed: true, idempotencyKey: 'even-send' }), 'send');
  assert.equal(item(w, r.item.id).demanded_fee_minor, FEE, 'the fee stands, so the letter demands it');
  assert.deepEqual(refreezeAudits(w), []);
});

test('D174: tenant scope: another workspace can neither reverse nor send the run, and nothing is re-frozen', () => {
  const w = world();
  const r = issuedRun(w, 'A');
  const other = mintWorkspace(w.deps, 'Fremd GmbH', 'ws-2');
  const before = item(w, r.item.id);
  assert.equal(call(w.deps, 'dunning_fee_reverse', { workspaceId: other.workspaceId, runId: r.runId, reason: 'x', idempotencyKey: 't-1' }).error, 'not_found');
  w.deps.emailRelay = recordingRelay();
  assert.equal(call(w.deps, 'send_dunning_run', { workspaceId: other.workspaceId, runId: r.runId, confirmed: true, idempotencyKey: 't-2' }).error, 'not_found');
  assert.deepEqual(item(w, r.item.id), before);
  assert.deepEqual(refreezeAudits(w), []);
});

test('D174 x D165: the lazy legacy re-freeze in send is bookkeeping, never a commit mark saying the send ran', () => {
  const w = world();
  const r = issuedRun(w, 'A');
  legacyRawReverse(w, r.feeEntryId, 'legacy-mark');
  // The relay refuses: nothing leaves, so every write of this send is its own bookkeeping.
  w.deps.emailRelay = recordingRelay({ ok: false, reason: 'relay_down' });
  const marks = [];
  const res = w.deps.store.withCommitMark((ran) => marks.push(ran), () =>
    call(w.deps, 'send_dunning_run', { workspaceId: w.workspaceId, runId: r.runId, confirmed: true, idempotencyKey: 'legacy-mark-send' }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.outcomes[0].outcome, 'send_failed', 'premise: nothing left');
  assert.equal(item(w, r.item.id).demanded_fee_minor, 0, 'premise: the lazy re-freeze wrote');
  assert.ok(marks.length > 0, 'premise: the writes were seen by the armed mark');
  assert.equal(marks.includes(true), false, `the re-freeze must not mark the send as run: ${JSON.stringify(marks)}`);
});

test('D174 tenant: the re-freeze called with another workspace\'s context never touches this run', async () => {
  const { refreezeUnsentWithoutFee } = await import('../../dist/core/dunning/run.js');
  const w = world();
  const r = issuedRun(w, 'A');
  legacyRawReverse(w, r.feeEntryId, 'tenant-legacy');
  const other = mintWorkspace(w.deps, 'Fremd GmbH', 'ws-3');
  const before = item(w, r.item.id);
  const foreign = ctxOf({ ...w, workspaceId: other.workspaceId });
  const done = w.deps.store.tx(() => refreezeUnsentWithoutFee(foreign, r.runId));
  assert.deepEqual(done, []);
  assert.deepEqual(item(w, r.item.id), before, 'the item is untouched');
  assert.equal(w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'refreeze_without_fee'").get().n, 0, 'no audit row in any workspace');
});
