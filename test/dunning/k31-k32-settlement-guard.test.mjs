/**
 * K-31 + K-32: the dunning settlement re-validation is broadened and made reachable.
 *
 * THREE defects, one money-path fix, proven here BEFORE the implementation (test-first, money-path):
 *
 *  - K-32: a letter is skipped whole when ANY invoice it names took a payment (partial OR full)
 *    since issue, not only when the invoice fully settled. D73 forbids shrinking the frozen letter,
 *    so the whole letter is held and its residual rides the next escalation.
 *  - K-31 f1: the re-validation runs on the MANUAL/DOWNLOAD evaluation path (the read model the
 *    Studio renders and downloads from), not only behind the never-present email relay. A settled or
 *    changed named invoice is marked on `get_dunning_run` with NO relay wired at all.
 *  - K-31 f2: the reason is distinct (paid / partially_paid / cancelled / credited), never a blanket
 *    'settled_since_issue' that overstates a partial payment or a cancellation as a settlement.
 *
 * Money figures are read back from the db with an INDEPENDENT connection is not needed here (the
 * engine's own read verbs are the witness), but the frozen row is asserted verbatim to prove D73.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, recordingRelay } from '../api/support.mjs';

const TODAY = '2026-07-16';
const call = (deps, name, input) => getAction(name).run(deps, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

/** A VAT-seeded workspace with a QR-IBAN creditor profile. Debtors and invoices are added per test. */
function baseWorld() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat_seed_defaults');
  must(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }), 'set_vat_method');
  must(
    call(deps, 'set_creditor_profile', {
      workspaceId,
      creditorName: 'Treuhand Muster GmbH',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    }),
    'set_creditor_profile',
  );
  return { deps, workspaceId, accId };
}

/** One customer with a postal address plus email, and one issued overdue CHF invoice (gross 108100). */
function debtorWithInvoice(deps, workspaceId, tag, email) {
  const customerId = must(
    call(deps, 'create_contact', {
      workspaceId,
      partyRole: 'customer',
      name: `Kunde ${tag}`,
      address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
      email,
      idempotencyKey: `contact-${tag}`,
    }),
    `create_contact ${tag}`,
  ).contact.id;
  const documentId = must(
    call(deps, 'create_document', {
      workspaceId,
      type: 'invoice',
      contactId: customerId,
      currency: 'CHF',
      dueDate: '2026-06-01',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: `doc-${tag}`,
    }),
    `create_document ${tag}`,
  ).document.id;
  must(call(deps, 'issue_invoice', { workspaceId, invoiceId: documentId, idempotencyKey: `issue-${tag}` }), `issue_invoice ${tag}`);
  return { customerId, documentId };
}

function payDocument(deps, workspaceId, accId, customerId, documentId, amountMinor, tag) {
  must(
    call(deps, 'record_payment', {
      workspaceId,
      direction: 'incoming',
      date: TODAY,
      amountMinor,
      bankAccountId: accId('1020'),
      counterpartyKind: 'customer',
      counterpartyId: customerId,
      allocations: [{ documentId, amountMinor }],
      intent: 'post_payment',
      idempotencyKey: `pay-${tag}`,
    }),
    `record_payment ${tag}`,
  );
}

// --- K-32: a PARTIAL payment holds the whole letter; an untouched debtor still sends ---------------

test('K-32: a partial payment since issue skips the whole letter; a non-touched debtor still sends', () => {
  const { deps, workspaceId, accId } = baseWorld();
  const a = debtorWithInvoice(deps, workspaceId, 'A', 'a@kunde.example'); // will take a partial payment
  const b = debtorWithInvoice(deps, workspaceId, 'B', 'b@kunde.example'); // untouched, must send

  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'k32-p' }), 'propose');
  assert.equal(run.items.length, 2);
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'k32-i' }), 'issue');

  // A PARTIAL payment (not a settlement): the old guard, which only skipped a FULLY settled invoice,
  // would have let this letter go. It names an invoice that has since taken money, and D73 forbids
  // reprinting it smaller, so the whole letter is held.
  payDocument(deps, workspaceId, accId, a.customerId, a.documentId, 50000, 'k32');

  const relay = recordingRelay();
  deps.emailRelay = relay;
  const sent = must(call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'k32-s' }), 'send');

  assert.equal(relay.sent.length, 1, 'exactly the untouched debtor letter left the building');
  assert.equal(relay.sent[0].to, 'b@kunde.example');
  assert.equal(sent.transmitted, 1);

  const held = sent.outcomes.find((o) => o.debtorId === a.customerId);
  assert.equal(held.outcome, 'partially_paid', 'a partial payment is named partially_paid, never a blanket settlement');
  assert.deepEqual(held.settledDocumentIds, [a.documentId]);
  assert.deepEqual(held.changedItems, [{ documentId: a.documentId, reason: 'partially_paid' }]);
  assert.ok(sent.skippedSettled.includes(a.documentId));

  const wentOut = sent.outcomes.find((o) => o.debtorId === b.customerId);
  assert.equal(wentOut.outcome, 'sent');
  assert.equal(sent.status, 'issued', 'not every letter went, so the run never claims sent');

  // D73: the frozen row is evidence, never a live figure. The partial payment did not shrink it.
  const view = must(call(deps, 'get_dunning_run', { workspaceId, runId: run.runId }), 'get_dunning_run');
  const frozen = view.items.find((i) => i.documentId === a.documentId);
  assert.equal(frozen.overdueMinor, 108100, 'the frozen demand is untouched by the payment (D73)');
});

// --- K-31 f1: the guard is reachable on the MANUAL/DOWNLOAD read path, with NO relay wired ---------

test('K-31 f1: get_dunning_run marks a changed invoice with NO relay, so the manual/download path is guarded', () => {
  const { deps, workspaceId, accId } = baseWorld();
  const a = debtorWithInvoice(deps, workspaceId, 'A', 'a@kunde.example');
  const b = debtorWithInvoice(deps, workspaceId, 'B', 'b@kunde.example');

  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'f1-p' }), 'propose');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'f1-i' }), 'issue');

  payDocument(deps, workspaceId, accId, a.customerId, a.documentId, 50000, 'f1');

  // NO relay is wired: this is the MIT core, where the only working send path is the manual PDF
  // download the Studio drives from get_dunning_run. The re-validation must be reachable HERE, not
  // only behind the never-present relay send path.
  assert.equal(deps.emailRelay, undefined, 'no transport is wired: the manual path is the only path');

  const view = must(call(deps, 'get_dunning_run', { workspaceId, runId: run.runId }), 'get_dunning_run');
  const changed = view.items.find((i) => i.documentId === a.documentId);
  const untouched = view.items.find((i) => i.documentId === b.documentId);
  assert.equal(changed.changeSinceIssue, 'partially_paid', 'the changed invoice is marked on the read model');
  assert.equal(untouched.changeSinceIssue, null, 'an unchanged invoice is not marked');

  const changedGroup = view.debtors.find((d) => d.debtorId === a.customerId);
  const untouchedGroup = view.debtors.find((d) => d.debtorId === b.customerId);
  assert.equal(changedGroup.changedSinceIssue, true, 'the debtor group warns before a manual download');
  assert.equal(changedGroup.changeReason, 'partially_paid');
  assert.deepEqual(changedGroup.changedDocumentIds, [a.documentId]);
  assert.equal(untouchedGroup.changedSinceIssue, false);
  assert.equal(untouchedGroup.changeReason, null);
});

// --- K-31 f2: the reason is distinct per cause, never a blanket 'settled_since_issue' --------------

test('K-31 f2: paid / partially_paid / cancelled / credited are named distinctly, not lumped', () => {
  const { deps, workspaceId, accId } = baseWorld();
  const paid = debtorWithInvoice(deps, workspaceId, 'PAID', 'paid@kunde.example');
  const partial = debtorWithInvoice(deps, workspaceId, 'PART', 'part@kunde.example');
  const cancelled = debtorWithInvoice(deps, workspaceId, 'CANC', 'canc@kunde.example');
  const credited = debtorWithInvoice(deps, workspaceId, 'CRED', 'cred@kunde.example');
  const open = debtorWithInvoice(deps, workspaceId, 'OPEN', 'open@kunde.example');

  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'f2-p' }), 'propose');
  assert.equal(run.items.length, 5);
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'f2-i' }), 'issue');

  // Four distinct changes since issue, one per debtor.
  payDocument(deps, workspaceId, accId, paid.customerId, paid.documentId, 108100, 'f2-paid'); // full
  payDocument(deps, workspaceId, accId, partial.customerId, partial.documentId, 40000, 'f2-part'); // partial
  must(
    call(deps, 'transition_document', { workspaceId, documentId: cancelled.documentId, to: 'cancelled', idempotencyKey: 'f2-cancel' }),
    'cancel',
  );
  const cn = must(
    call(deps, 'create_credit_note', { workspaceId, fromInvoiceId: credited.documentId, mode: 'full', idempotencyKey: 'f2-cn' }),
    'create_credit_note',
  ).document.id;
  must(call(deps, 'issue_credit_note', { workspaceId, creditNoteId: cn, idempotencyKey: 'f2-cn-i' }), 'issue_credit_note');

  // 1) The read/download path names each cause distinctly.
  const view = must(call(deps, 'get_dunning_run', { workspaceId, runId: run.runId }), 'get_dunning_run');
  const reasonOf = (documentId) => view.items.find((i) => i.documentId === documentId).changeSinceIssue;
  assert.equal(reasonOf(paid.documentId), 'paid');
  assert.equal(reasonOf(partial.documentId), 'partially_paid');
  assert.equal(reasonOf(cancelled.documentId), 'cancelled');
  assert.equal(reasonOf(credited.documentId), 'credited');
  assert.equal(reasonOf(open.documentId), null, 'the untouched invoice is not marked');

  // 2) The send path skips each with the SAME distinct reason, and only the open debtor transmits.
  const relay = recordingRelay();
  deps.emailRelay = relay;
  const sent = must(call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'f2-s' }), 'send');

  const outcomeOf = (customerId) => sent.outcomes.find((o) => o.debtorId === customerId).outcome;
  assert.equal(outcomeOf(paid.customerId), 'paid');
  assert.equal(outcomeOf(partial.customerId), 'partially_paid');
  assert.equal(outcomeOf(cancelled.customerId), 'cancelled');
  assert.equal(outcomeOf(credited.customerId), 'credited');
  assert.equal(outcomeOf(open.customerId), 'sent');

  // Not one of the four distinct reasons is the old blanket string.
  for (const o of sent.outcomes) assert.notEqual(o.outcome, 'settled_since_issue');

  assert.equal(relay.sent.length, 1, 'only the untouched debtor letter left the building');
  assert.equal(relay.sent[0].to, 'open@kunde.example');
  assert.equal(sent.status, 'issued');
});

// --- The guard stays idempotent and §H-TENANT: a foreign workspace sees none of this --------------

test('K-31/K-32: a changed-since-issue skip is invisible from a foreign workspace (H-TENANT)', () => {
  const { deps, workspaceId, accId } = baseWorld();
  const a = debtorWithInvoice(deps, workspaceId, 'A', 'a@kunde.example');
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'ht-p' }), 'propose');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'ht-i' }), 'issue');
  payDocument(deps, workspaceId, accId, a.customerId, a.documentId, 50000, 'ht');

  const other = mintWorkspace(deps, 'Fremde AG', 'ws-other').workspaceId;
  const foreign = call(deps, 'get_dunning_run', { workspaceId: other, runId: run.runId });
  assert.equal(foreign.error, 'not_found', 'the run is invisible from another tenant');
});
