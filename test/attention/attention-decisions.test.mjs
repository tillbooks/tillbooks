/**
 * G15 F-01 (2026-09-05): the row carries its decision, MEASURED against real providers.
 *
 * What the hub row needs from the engine, proven on real stores seeded through the registry and the
 * module engines:
 *
 *  - an A21 credit carries its live-scored `suggestedInvoiceId`, its `reasonCode` (the J8.12 reason)
 *    and the two exits `/reconciliation` offers, plus the link for the hand-picked case; a `none`
 *    score offers no apply at all (the hub never invents a match);
 *  - every option names an EXISTING registry write with a DETERMINISTIC per-item idempotency key,
 *    stable across two reads, so a double click on the row replays the first write: apply twice
 *    posts ONE payment, dismiss twice decides ONCE;
 *  - the consequence sentence is the dial map's own (key + English), and a verb the map does not
 *    govern carries `null`, never an invented sentence;
 *  - an A35 draft carries its proposer, the drafted verb's consequence, approve / approve-and-allow /
 *    reject, and approving twice through the option's input posts exactly one entry while rejecting
 *    posts nothing;
 *  - an A25 flag reaches the hub as the `review_flag` queue with a true COUNT, the flag's reason and
 *    reviewer, and resolving it twice through the option's input records ONE approval;
 *  - an A15 proposed run reaches the hub as the `dunning_run` queue with the issue exit under `dun`,
 *    and issuing it twice through the option's input books ONE Mahngebühr;
 *  - §H-TENANT: a second workspace sees none of it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attentionList } from '../../dist/core/attention/index.js';
import { getAction } from '../../dist/api/registry.js';
import { createBankAccount, recordIncomingCredit } from '../../dist/core/banking/index.js';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { CONSEQUENCE_FOR_ACTION } from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';
import { setup, issueInvoice, GROSS_MINOR } from '../payments/support.mjs';
import { PLAIN_IBAN } from '../banking/support.mjs';

const ok = (res, label = 'result') => {
  assert.equal(res.ok, true, `expected ${label} ok, got ${JSON.stringify(res)}`);
  return res;
};

/** The A21 world: the A14 fixture plus a Bankkonto on 1020, an issued invoice and its QRR. */
function qrWorld() {
  const t = setup();
  const bank = ok(
    createBankAccount(t.ctx, { name: 'PostFinance', iban: PLAIN_IBAN, currency: 'CHF', ledgerAccountId: t.bankId, idempotencyKey: 'att-bank' }),
    'createBankAccount',
  );
  const doc = issueInvoice(t.ctx, { contactId: t.customerId, key: 'att-inv' });
  return { ...t, bankAccountId: bank.bankAccountId, doc, reference: buildQrrReference(doc.number) };
}

function credit(t, { reference, amountMinor, key }) {
  return ok(
    recordIncomingCredit(t.ctx, { bankAccountId: t.bankAccountId, amountMinor, valueDate: '2026-07-19', reference, idempotencyKey: key }),
    'recordIncomingCredit',
  ).credit;
}

/** The hub's own call shape: the option's fixed input, the workspace, and the human confirmation. */
function runOption(deps, workspaceId, option, extra = {}) {
  return getAction(option.verb).run(deps, {
    workspaceId,
    ...option.input,
    ...(option.humanConfirm ? { confirmed: true } : {}),
    ...extra,
  });
}

function qrItems(t) {
  return ok(attentionList(t.ctx, { queueId: 'qr_match' }), 'attention_list').items;
}

test('qr_match: a high-scoring credit carries its suggested invoice, the apply/dismiss/open exits and the pay sentence', () => {
  const t = qrWorld();
  const c = credit(t, { reference: t.reference, amountMinor: GROSS_MINOR, key: 'att-c-high' });
  const [item] = qrItems(t);
  assert.ok(item, 'the credit is listed');
  assert.equal(item.entityId, c.creditId);
  assert.equal(item.suggestedInvoiceId, t.doc.id, 'the live score names the invoice (J2.4)');
  assert.equal(item.suggestedInvoiceNumber, t.doc.number);
  assert.equal(item.reasonCode, 'exact_open');
  assert.equal(item.reasonKey, 'qrmatch.reason.exact_open', 'the reason is keyed into the owning catalogue (J8.12)');
  const ids = item.decisionOptions.map((o) => o.id);
  assert.deepEqual(ids, ['apply', 'dismiss', 'open']);
  const apply = item.decisionOptions.find((o) => o.id === 'apply');
  assert.equal(apply.verb, 'apply_qr_match');
  assert.equal(apply.role, 'primary');
  assert.equal(apply.input.invoiceId, t.doc.id);
  assert.equal(apply.input.mode, 'full', 'an exact match applies in full');
  assert.equal(apply.humanConfirm, true);
  assert.equal(apply.capability, 'pay');
  const open = item.decisionOptions.find((o) => o.id === 'open');
  assert.equal(open.verb, null);
  assert.equal(open.deepLink.route, '/reconciliation');
  // D118 C4: the sentence is the dial map's own, keyed for the Studio and spelled for the agent.
  assert.equal(item.consequenceKey, 'agent.consequence.pay');
  assert.equal(item.consequence, CONSEQUENCE_FOR_ACTION.apply_qr_match);
});

test('qr_match: a credit that matches nothing offers NO apply (the hub never invents a match), dismiss leads, and the reason says why', () => {
  const t = qrWorld();
  credit(t, { reference: buildQrrReference('X-9999'), amountMinor: 1000, key: 'att-c-none' });
  const [item] = qrItems(t);
  assert.equal(item.suggestedInvoiceId, null);
  assert.equal(item.reasonCode, 'no_invoice');
  assert.deepEqual(item.decisionOptions.map((o) => o.id), ['dismiss', 'open']);
  assert.equal(item.decisionOptions[0].role, 'primary', 'with no candidate, "Keine Kundenzahlung" is the row\'s primary');
  // A dismiss books nothing, so the row states no posting (D118 C4: the sentence is about the write
  // the row can make, and this row can make none). The pay sentence belongs to the apply exit only.
  assert.equal(item.consequenceKey, null, 'a dismiss-only row carries no consequence sentence');
  assert.equal(item.consequence, null);
});

test('qr_match: a short credit applies as a PARTIAL payment (never written off from the hub)', () => {
  const t = qrWorld();
  credit(t, { reference: t.reference, amountMinor: GROSS_MINOR - 500, key: 'att-c-short' });
  const [item] = qrItems(t);
  assert.equal(item.reasonCode, 'amount_short');
  const apply = item.decisionOptions.find((o) => o.id === 'apply');
  assert.equal(apply.input.mode, 'partial');
  assert.equal(apply.labelKey, 'qrmatch.applyPartial');
});

test('qr_match: an over-paying credit applies in FULL under "Übernehmen" (the surplus parks as Guthaben), and the posting settles the invoice once', () => {
  const t = qrWorld();
  const c = credit(t, { reference: t.reference, amountMinor: GROSS_MINOR + 500, key: 'att-c-over' });
  const [item] = qrItems(t);
  assert.equal(item.reasonCode, 'amount_over');
  const apply = item.decisionOptions.find((o) => o.id === 'apply');
  assert.equal(apply.labelKey, 'qrmatch.applyFull', 'the label says Übernehmen');
  assert.equal(apply.input.mode, 'full', 'and the call sends the mode the label names');
  assert.match(apply.input.idempotencyKey, /:full:/);
  const deps = { ...t.deps, actor: 'user_1' };
  ok(runOption(deps, t.workspaceId, apply), 'apply the surplus');
  const row = t.store.db.prepare(`SELECT status, applied_mode FROM reconciliation_match WHERE id = ?`).get(c.creditId);
  assert.equal(row.status, 'applied');
  assert.equal(row.applied_mode, 'full');
  assert.equal(t.store.db.prepare(`SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?`).get(t.workspaceId).n, 1, 'one payment, the surplus parked on it');
  assert.equal(qrItems(t).length, 0);
});

test('idempotency: the option key is deterministic across reads, and APPLY TWICE posts exactly ONE payment', () => {
  const t = qrWorld();
  const c = credit(t, { reference: t.reference, amountMinor: GROSS_MINOR, key: 'att-c-idem' });
  const first = qrItems(t)[0].decisionOptions.find((o) => o.id === 'apply');
  const second = qrItems(t)[0].decisionOptions.find((o) => o.id === 'apply');
  assert.equal(first.input.idempotencyKey, second.input.idempotencyKey, 'the same row asks the same question under the same key');
  assert.match(first.input.idempotencyKey, /^attention:apply:/);
  assert.doesNotMatch(first.input.idempotencyKey, /kaizen:|seed:/);

  const deps = { ...t.deps, actor: 'user_1' };
  const one = ok(runOption(deps, t.workspaceId, first), 'apply #1');
  const two = ok(runOption(deps, t.workspaceId, first), 'apply #2 (double click)');
  assert.equal(two.paymentId, one.paymentId, 'the replay answers with the first payment');
  const payments = t.store.db
    .prepare(`SELECT COUNT(*) AS n FROM reconciliation_match WHERE workspace_id = ? AND id = ? AND status = 'applied'`)
    .get(t.workspaceId, c.creditId);
  assert.equal(payments.n, 1);
  const paymentRows = t.store.db.prepare(`SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?`).get(t.workspaceId);
  assert.equal(paymentRows.n, 1, 'one payment row for two clicks');
  assert.equal(qrItems(t).length, 0, 'the row left the queue by the act, not by hiding');
});

test('idempotency: DISMISS TWICE decides once and posts nothing', () => {
  const t = qrWorld();
  const c = credit(t, { reference: buildQrrReference('X-9999'), amountMinor: 1000, key: 'att-c-dismiss' });
  const dismiss = qrItems(t)[0].decisionOptions.find((o) => o.id === 'dismiss');
  // Deterministic ACROSS READS: a re-listed row after a transient error replays under the same key.
  assert.equal(dismiss.input.idempotencyKey, qrItems(t)[0].decisionOptions.find((o) => o.id === 'dismiss').input.idempotencyKey);
  assert.match(dismiss.input.idempotencyKey, /^attention:dismiss:/);
  const deps = { ...t.deps, actor: 'user_1' };
  const entriesBefore = t.store.db.prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?`).get(t.workspaceId).n;
  ok(runOption(deps, t.workspaceId, dismiss), 'dismiss #1');
  ok(runOption(deps, t.workspaceId, dismiss), 'dismiss #2 (double click)');
  const row = t.store.db.prepare(`SELECT status, decided_at FROM reconciliation_match WHERE id = ?`).get(c.creditId);
  assert.equal(row.status, 'dismissed');
  const entriesAfter = t.store.db.prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?`).get(t.workspaceId).n;
  assert.equal(entriesAfter, entriesBefore, 'a dismissal books nothing');
  assert.equal(qrItems(t).length, 0);
});

// --- A35 drafts: approve, approve-and-allow, reject ------------------------------------------------

function seedDraft(deps, workspaceId, { id, actor = 'till-agent', actionTool, payload }) {
  deps.store.db
    .prepare(
      `INSERT INTO agent_action
         (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(id, workspaceId, actor, 'post', actionTool, JSON.stringify(payload), payload.idempotencyKey ?? null, deps.clock.now());
  return id;
}

function draftedPost(deps, workspaceId, accId, { id, key }) {
  return seedDraft(deps, workspaceId, {
    id,
    actionTool: 'post_entry',
    payload: { workspaceId, ...manualPost(accId, key) },
  });
}

const postedEntries = (deps, workspaceId) =>
  deps.store.db.prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'`).get(workspaceId).n;

test('agent_action: the draft row carries its proposer, the DRAFTED verb\'s consequence and the three D103 exits', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Vorschlag GmbH', 'att-draft-ws');
  draftedPost(deps, workspaceId, accId, { id: 'd-shape', key: 'd-shape-key' });
  const res = ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'agent_action' }));
  const [item] = res.items;
  assert.equal(item.entityId, 'd-shape');
  assert.equal(item.proposedBy, 'till-agent');
  assert.equal(item.subtitleParams.tool, 'post_entry');
  assert.equal(item.consequenceKey, 'agent.consequence.post', 'the sentence is the drafted verb\'s, what the approver decides about');
  assert.equal(item.consequence, CONSEQUENCE_FOR_ACTION.post_entry);
  const byId = Object.fromEntries(item.decisionOptions.map((o) => [o.id, o]));
  assert.deepEqual(Object.keys(byId), ['approve', 'approve_allow', 'reject']);
  assert.equal(byId.approve.verb, 'approve_drafted_action');
  assert.deepEqual(byId.approve.input, { actionId: 'd-shape' });
  assert.deepEqual(byId.approve_allow.input, { actionId: 'd-shape', allowFuture: true }, 'the D103 grant is one act on the row');
  assert.equal(byId.approve_allow.capability, 'manage_agent_dial');
  assert.equal(byId.reject.verb, 'reject_drafted_action');
  assert.equal(byId.reject.reasonField, true);
  assert.equal(byId.reject.role, 'danger');
});

test('agent_action: APPROVE TWICE through the option posts exactly ONE entry, and the row leaves the queue', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Approve GmbH', 'att-approve-ws');
  draftedPost(deps, workspaceId, accId, { id: 'd-approve', key: 'd-approve-key' });
  const approve = ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'agent_action' })).items[0].decisionOptions.find((o) => o.id === 'approve');
  const human = { ...deps, actor: 'studio' };
  ok(runOption(human, workspaceId, approve), 'approve #1');
  ok(runOption(human, workspaceId, approve), 'approve #2 (double click)');
  assert.equal(postedEntries(deps, workspaceId), 1, 'one posting for two approvals');
  assert.equal(ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'agent_action' })).items.length, 0);
});

test('agent_action: REJECT through the option posts NOTHING, tolerates the reason, and is idempotent on the action id', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Reject GmbH', 'att-reject-ws');
  draftedPost(deps, workspaceId, accId, { id: 'd-reject', key: 'd-reject-key' });
  const reject = ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'agent_action' })).items[0].decisionOptions.find((o) => o.id === 'reject');
  const human = { ...deps, actor: 'studio' };
  ok(runOption(human, workspaceId, reject, { reason: 'Falsches Konto' }), 'reject #1 with a reason');
  ok(runOption(human, workspaceId, reject, { reason: 'Falsches Konto' }), 'reject #2 (double click)');
  assert.equal(postedEntries(deps, workspaceId), 0, 'a rejected draft posts nothing');
  const row = deps.store.db.prepare(`SELECT status FROM agent_action WHERE id = ?`).get('d-reject');
  assert.equal(row.status, 'rejected');
  assert.equal(ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'agent_action' })).items.length, 0);
});

// --- A15 runs: the dunning_run queue ----------------------------------------------------------------

/**
 * The A15 world (the `a15-critic-adversarial` seed, shortened): a QR-IBAN creditor, one customer,
 * one issued CHF invoice 45 days overdue at the fixed clock, a fee-income account and a policy
 * that BOOKS a Mahngebühr at level 1, then one proposed run.
 */
function dunningWorld(deps, prefix) {
  const call = (name, input) => ok(getAction(name).run(deps, input), name);
  const { workspaceId } = mintWorkspace(deps, `${prefix} GmbH`, `${prefix}-ws`);
  call('vat_seed_defaults', { workspaceId });
  call('set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' });
  call('set_creditor_profile', {
    workspaceId,
    creditorName: 'Treuhand Muster GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  const customerId = call('create_contact', {
    workspaceId,
    partyRole: 'customer',
    name: 'Säumig AG',
    address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
    email: 'debitor@kunde.example',
    idempotencyKey: `${prefix}-contact`,
  }).contact.id;
  const documentId = call('create_document', {
    workspaceId,
    type: 'invoice',
    contactId: customerId,
    currency: 'CHF',
    dueDate: '2026-06-01',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: `${prefix}-doc`,
  }).document.id;
  call('issue_invoice', { workspaceId, invoiceId: documentId, idempotencyKey: `${prefix}-issue` });
  const fee = call('create_account', { workspaceId, number: '3999', name: 'Mahngebühren', type: 'income', idempotencyKey: `${prefix}-fee-acc` });
  const feeIncomeAccountId = fee.account?.id ?? fee.accountId ?? fee.id;
  const level = { feeMinor: 2000, bookFee: true, showInterest: false, feeIncomeAccountId };
  call('set_dunning_config', {
    workspaceId,
    levels: [
      { level: 1, daysOverdue: 10, ...level },
      { level: 2, daysOverdue: 20, ...level },
      { level: 3, daysOverdue: 30, ...level },
    ],
    idempotencyKey: `${prefix}-cfg`,
  });
  const run = call('propose_dunning_run', { workspaceId, idempotencyKey: `${prefix}-propose` });
  return { workspaceId, documentId, runId: run.runId };
}

const feeEntries = (deps, workspaceId) =>
  deps.store.db.prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'dunning'`).get(workspaceId).n;

test('dunning_run: the proposed run reaches the hub with the issue exit and the dun sentence; ISSUE TWICE books ONE fee and the row leaves the queue', () => {
  const deps = freshDeps();
  const { workspaceId, runId } = dunningWorld(deps, 'att-dun');

  const summary = ok(getAction('attention_summary').run(deps, { workspaceId }));
  assert.equal(summary.queues.find((q) => q.queueId === 'dunning_run')?.count, 1, 'a true COUNT of proposed runs');
  const [item] = ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'dunning_run' })).items;
  assert.equal(item.entityKind, 'dunning_run');
  assert.equal(item.entityId, runId);
  assert.equal(item.subtitleParams.count, 1);
  assert.deepEqual(item.decisionOptions.map((o) => o.id), ['issue', 'open']);
  const issue = item.decisionOptions.find((o) => o.id === 'issue');
  assert.equal(issue.verb, 'issue_dunning_run');
  assert.equal(issue.humanConfirm, true, 'issuing is the P8 commitment: a person at the button confirms');
  assert.equal(issue.capability, 'dun');
  assert.equal(issue.input.runId, runId);
  assert.equal(issue.input.idempotencyKey, `attention:issue:${workspaceId}:${runId}`);
  assert.equal(issue.input.idempotencyKey, ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'dunning_run' })).items[0].decisionOptions[0].input.idempotencyKey, 'deterministic across reads');
  assert.equal(item.consequenceKey, 'agent.consequence.dun', 'the sentence /dunning renders beside its own commit');
  assert.equal(item.consequence, CONSEQUENCE_FOR_ACTION.issue_dunning_run);

  const before = postedEntries(deps, workspaceId);
  assert.equal(feeEntries(deps, workspaceId), 0);
  const human = { ...deps, actor: 'studio' };
  const one = ok(runOption(human, workspaceId, issue), 'issue #1');
  assert.equal(one.status, 'issued');
  const two = ok(runOption(human, workspaceId, issue), 'issue #2 (double click)');
  assert.equal(two.runId, one.runId, 'the replay answers with the same run');
  assert.equal(feeEntries(deps, workspaceId), 1, 'ONE Mahngebühr entry for two clicks');
  assert.equal(postedEntries(deps, workspaceId), before + 1, 'exactly one posting more than before');
  const runRow = deps.store.db.prepare(`SELECT status FROM dunning_run WHERE workspace_id = ? AND id = ?`).get(workspaceId, runId);
  assert.equal(runRow.status, 'issued');
  assert.equal(ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'dunning_run' })).items.length, 0, 'the row left by the act');
  assert.equal(ok(getAction('attention_summary').run(deps, { workspaceId })).queues.some((q) => q.queueId === 'dunning_run'), false);
  deps.store.close();
});

test('§H-TENANT: the issue option fired against another workspace is not_found, books nothing, and the run stays proposed', () => {
  const deps = freshDeps();
  const a = dunningWorld(deps, 'att-dun-a');
  const b = mintWorkspace(deps, 'Fremd GmbH', 'att-dun-b');
  const issue = ok(getAction('attention_list').run(deps, { workspaceId: a.workspaceId, queueId: 'dunning_run' })).items[0].decisionOptions.find((o) => o.id === 'issue');
  assert.ok(ok(getAction('attention_summary').run(deps, { workspaceId: b.workspaceId })).queues.every((q) => q.queueId !== 'dunning_run'), 'B sees no run of A');
  const foreign = runOption({ ...deps, actor: 'studio' }, b.workspaceId, issue);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found');
  assert.equal(feeEntries(deps, a.workspaceId), 0);
  assert.equal(feeEntries(deps, b.workspaceId), 0);
  assert.equal(deps.store.db.prepare(`SELECT status FROM dunning_run WHERE id = ?`).get(a.runId).status, 'proposed');
  deps.store.close();
});

// --- A25 flags: the review_flag queue ---------------------------------------------------------------

function postAndFlag(deps, workspaceId, accId, { key, reason }) {
  const posted = ok(getAction('post_entry').run(deps, { workspaceId, ...manualPost(accId, key) }), 'post_entry');
  const entryId = posted.entryId ?? posted.entry?.id;
  assert.ok(entryId, `posted entry id in ${JSON.stringify(posted)}`);
  ok(getAction('flag_entry').run({ ...deps, actor: 'reto' }, { workspaceId, entryId, reason, idempotencyKey: `${key}-flag` }), 'flag_entry');
  return entryId;
}

test('review_flag: a flagged posting reaches the hub with its reason and reviewer, a true COUNT, and the open/resolve exits', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Flag GmbH', 'att-flag-ws');
  const entryId = postAndFlag(deps, workspaceId, accId, { key: 'f-1', reason: 'Falsches Konto: Aufwand statt Ertrag' });
  // A second, unflagged posting must NOT appear; a flagged-then-approved one must leave.
  ok(getAction('post_entry').run(deps, { workspaceId, ...manualPost(accId, 'f-2') }), 'post_entry #2');

  const summary = ok(getAction('attention_summary').run(deps, { workspaceId }));
  const queue = summary.queues.find((q) => q.queueId === 'review_flag');
  assert.ok(queue, 'the review_flag queue is present');
  assert.equal(queue.count, 1);
  assert.equal(queue.area, 'accounting');

  const [item] = ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'review_flag' })).items;
  assert.equal(item.entityKind, 'journal_entry');
  assert.equal(item.entityId, entryId);
  assert.equal(item.subtitleParams.reason, 'Falsches Konto: Aufwand statt Ertrag');
  // `reto` is an actor string the engine cannot place (no seat, no bound user): the raw id rides
  // `proposedBy` for the whoami self-check only, and the NAME the surface prints is empty.
  assert.equal(item.proposedBy, 'reto');
  assert.equal(item.proposedByKind, 'unknown');
  assert.equal(item.proposedByName, null);
  assert.equal(item.subtitleParams.reviewer, '', 'a raw actor id never rides the subtitle');
  assert.equal(item.deepLink.route, '/journal');
  assert.deepEqual(item.decisionOptions.map((o) => o.id), ['open', 'resolve']);
  const resolve = item.decisionOptions.find((o) => o.id === 'resolve');
  assert.equal(resolve.verb, 'approve_entry');
  assert.equal(resolve.capability, 'review');
  assert.equal(item.consequenceKey, null, 'approve_entry is not dial-governed: no sentence, none invented');
  assert.equal(item.consequence, null);
});

test('review_flag: the reviewer is resolved to a KIND and a NAME (agent seat, Studio seat, a bound member by display name), never a raw id', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Wer GmbH', 'att-who-ws');
  const flagAs = (actor, key) => {
    const posted = ok(getAction('post_entry').run(deps, { workspaceId, ...manualPost(accId, key) }), 'post_entry');
    const entryId = posted.entryId ?? posted.entry?.id;
    ok(getAction('flag_entry').run({ ...deps, actor }, { workspaceId, entryId, reason: `von ${key}`, idempotencyKey: `${key}-flag` }), 'flag_entry');
    return entryId;
  };
  const byAgent = flagAs('agent', 'w-agent');
  const byStudio = flagAs('studio', 'w-studio');
  // A served member: the A24 user row binds `member:<user_id>` to a display name (M01).
  deps.store.db
    .prepare(`INSERT INTO user (id, actor_id, email, display_name, kind, created_at) VALUES (?, ?, ?, ?, 'human', ?)`)
    .run('user_9', 'member:user_9', 'reto@treuhand.example', 'Reto Muster', deps.clock.now());
  const byMember = flagAs('studio', 'w-member');
  deps.store.db.prepare(`UPDATE entry_review SET reviewer = 'member:user_9' WHERE workspace_id = ? AND entry_id = ?`).run(workspaceId, byMember);
  // A member with no display name yet (the invite went to an email): the email is the name shown.
  deps.store.db
    .prepare(`INSERT INTO user (id, actor_id, email, display_name, kind, created_at) VALUES (?, ?, ?, NULL, 'human', ?)`)
    .run('user_10', 'member:user_10', 'mara@kmu.example', deps.clock.now());
  const byEmail = flagAs('studio', 'w-email');
  deps.store.db.prepare(`UPDATE entry_review SET reviewer = 'member:user_10' WHERE workspace_id = ? AND entry_id = ?`).run(workspaceId, byEmail);

  const items = ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'review_flag' })).items;
  const byId = Object.fromEntries(items.map((i) => [i.entityId, i]));
  assert.equal(byId[byAgent].proposedByKind, 'agent');
  assert.equal(byId[byAgent].proposedByName, null);
  assert.equal(byId[byAgent].subtitleParams.reviewer, '');
  assert.equal(byId[byStudio].proposedByKind, 'studio');
  assert.equal(byId[byStudio].subtitleParams.reviewer, '');
  assert.equal(byId[byMember].proposedByKind, 'member');
  assert.equal(byId[byMember].proposedByName, 'Reto Muster', 'a member is named by the display name the read model knows');
  assert.equal(byId[byMember].subtitleParams.reviewer, 'Reto Muster');
  assert.equal(byId[byMember].proposedBy, 'member:user_9', 'the raw id still rides proposedBy for the whoami self-check');
  assert.equal(byId[byEmail].proposedByKind, 'member');
  assert.equal(byId[byEmail].subtitleParams.reviewer, 'mara@kmu.example');
  for (const item of items) {
    assert.doesNotMatch(String(item.subtitleParams.reviewer), /^member:/, 'no served actor id in a subtitle param');
  }
  deps.store.close();
});

test('review_flag: RESOLVE TWICE records ONE approval, the flag leaves the queue, and the posted rows are untouched', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Resolve GmbH', 'att-resolve-ws');
  const entryId = postAndFlag(deps, workspaceId, accId, { key: 'r-1', reason: 'Beleg fehlt' });
  const linesBefore = deps.store.db.prepare(`SELECT COUNT(*) AS n FROM journal_line WHERE entry_id = ?`).get(entryId).n;
  const readResolve = () => ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'review_flag' })).items[0].decisionOptions.find((o) => o.id === 'resolve');
  const resolve = readResolve();
  // Deterministic ACROSS READS: a flaky re-read must not mint a second approval under a fresh key.
  assert.equal(resolve.input.idempotencyKey, readResolve().input.idempotencyKey);
  assert.match(resolve.input.idempotencyKey, /^attention:resolve:/);
  const human = { ...deps, actor: 'studio' };
  ok(runOption(human, workspaceId, resolve), 'resolve #1');
  ok(runOption(human, workspaceId, resolve), 'resolve #2 (double click)');
  const approvals = deps.store.db
    .prepare(`SELECT COUNT(*) AS n FROM entry_review WHERE workspace_id = ? AND entry_id = ? AND status = 'approved'`)
    .get(workspaceId, entryId).n;
  assert.equal(approvals, 1, 'one approval event for two clicks');
  assert.equal(ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'review_flag' })).items.length, 0);
  assert.equal(ok(getAction('attention_summary').run(deps, { workspaceId })).queues.some((q) => q.queueId === 'review_flag'), false);
  const linesAfter = deps.store.db.prepare(`SELECT COUNT(*) AS n FROM journal_line WHERE entry_id = ?`).get(entryId).n;
  assert.equal(linesAfter, linesBefore, 'review metadata never touches the posted rows');
});

test('review_flag: a flag raised AGAIN after an approval is a NEW question under a new key', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Again GmbH', 'att-again-ws');
  const entryId = postAndFlag(deps, workspaceId, accId, { key: 'a-1', reason: 'erste Frage' });
  const first = ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'review_flag' })).items[0].decisionOptions.find((o) => o.id === 'resolve');
  ok(runOption({ ...deps, actor: 'studio' }, workspaceId, first), 'resolve the first flag');
  ok(getAction('flag_entry').run({ ...deps, actor: 'reto' }, { workspaceId, entryId, reason: 'zweite Frage', idempotencyKey: 'a-1-flag-2' }), 'flag again');
  const second = ok(getAction('attention_list').run(deps, { workspaceId, queueId: 'review_flag' })).items[0].decisionOptions.find((o) => o.id === 'resolve');
  assert.notEqual(second.input.idempotencyKey, first.input.idempotencyKey, 'the second flag is not a replay of the first approval');
  ok(runOption({ ...deps, actor: 'studio' }, workspaceId, second), 'resolve the second flag');
  const approvals = deps.store.db
    .prepare(`SELECT COUNT(*) AS n FROM entry_review WHERE workspace_id = ? AND entry_id = ? AND status = 'approved'`)
    .get(workspaceId, entryId).n;
  assert.equal(approvals, 2);
});

test('§H-TENANT: a second workspace sees no flag and no draft of the first', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'A GmbH', 'att-t-a');
  const b = mintWorkspace(deps, 'B GmbH', 'att-t-b');
  postAndFlag(deps, a.workspaceId, a.accId, { key: 't-1', reason: 'nur in A' });
  draftedPost(deps, a.workspaceId, a.accId, { id: 'd-tenant', key: 'd-tenant-key' });
  const inA = ok(getAction('attention_summary').run(deps, { workspaceId: a.workspaceId }));
  assert.equal(inA.queues.find((q) => q.queueId === 'review_flag')?.count, 1);
  assert.equal(inA.queues.find((q) => q.queueId === 'agent_action')?.count, 1);
  const inB = ok(getAction('attention_summary').run(deps, { workspaceId: b.workspaceId }));
  assert.ok(inB.queues.every((q) => q.queueId !== 'review_flag' && q.queueId !== 'agent_action'));
  assert.equal(inB.total, 0);
});

test('non-mutation: listing the decision options writes nothing (the hub still decides nothing by itself)', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Read Only GmbH', 'att-ro-2');
  postAndFlag(deps, workspaceId, accId, { key: 'n-1', reason: 'nur lesen' });
  draftedPost(deps, workspaceId, accId, { id: 'd-ro', key: 'd-ro-key' });
  const snapshot = () => ({
    review: deps.store.db.prepare('SELECT COUNT(*) AS n FROM entry_review').get().n,
    actions: deps.store.db.prepare(`SELECT COUNT(*) AS n FROM agent_action WHERE status = 'pending'`).get().n,
    entries: deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n,
  });
  const before = snapshot();
  ok(getAction('attention_summary').run(deps, { workspaceId }));
  ok(getAction('attention_list').run(deps, { workspaceId }));
  assert.deepEqual(snapshot(), before);
});
