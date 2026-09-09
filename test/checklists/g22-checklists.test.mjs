/**
 * G22 Checklisten: the matrix rows of spec §2, driven through the registry (the same `action.run`
 * both MCP faces and REST dispatch), over the real `vat_period` template.
 *
 * What this file proves, row by row: idempotent start on the natural key (1.3), `needs_vat_config`
 * (1.4) and `period_not_filable` (1.5), the live system checks flipping without a write (3.1 / 3.2),
 * engine-bound verb evidence (4.1), `prerequisite_open` (4.2), `evidence_required` (4.3),
 * `evidence_mismatch`, the attestation with a date and `already_attested` (5.1 / 5.2), the skip with a
 * reason and the undeletable refusal (6.1), reopen voiding the sign-off (6.2), the bridge sign-off going
 * stale and voided on a hash change, the statutory due dates (Art. 71 / Art. 86 MWSTG, 60 days), the
 * G15 provider with abandoned runs invisible (7.1 / 7.2), the derived `done` (8.1), abandon (8.2),
 * no `_rappen` column, and §H-TENANT (a second workspace sees nothing).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { ledgerPorts, postEntry } from '../../dist/core/ledger/index.js';
import { buildVatLines } from '../../dist/core/vat/index.js';
import { attentionList, attentionSummary, ATTENTION_PROVIDERS } from '../../dist/core/attention/index.js';
import { CHECKLISTS_SCHEMA_SQL, VAT_PERIOD_TEMPLATE, resolveDueDates } from '../../dist/core/checklists/index.js';
import { CAPABILITY_FOR_ACTION } from '../../dist/core/access/actionCapabilities.js';
import { BUILTIN_ROLE_DEFAULTS } from '../../dist/core/access/capabilities.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};
const refuse = (res, error, what) => {
  assert.equal(res.ok, false, `${what} should have refused: ${JSON.stringify(res)}`);
  assert.equal(res.error, error, `${what} wrong error: ${JSON.stringify(res)}`);
  return res;
};

let seq = 0;
const key = (tag) => `g22-${tag}-${(seq += 1)}`;

/** A configured effektiv/soll workspace at the fixture clock (2026-07-16): 2026-Q2 has ended. */
function world(seed, { configured = true, actor = 'studio' } = {}) {
  const deps = freshDeps();
  deps.actor = actor;
  const { workspaceId, accId } = mintWorkspace(deps, 'Checkliste GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  if (configured) {
    must(call('vat_seed_defaults', {}), 'seed');
    must(call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
  }
  const ctx = makeContext(deps.store, { workspaceId, actor, clock: deps.clock, ids: deps.ids, ...ledgerPorts({ store: deps.store, workspaceId, ids: deps.ids }) });
  return { deps, wid: workspaceId, accId, call, ctx };
}

function start(w, period = '2026-Q2', tag = 'start') {
  return must(w.call('checklist_start', { templateId: 'vat_period', period, idempotencyKey: key(tag) }), 'start');
}

function item(view, itemId) {
  const found = view.items.find((i) => i.itemId === itemId);
  assert.ok(found, `item ${itemId} missing`);
  return found;
}

/** Post one taxed sale in Q2 so the return carries figures (and the hash moves). */
function postSale(w, { date = '2026-05-15', net = 100_000, taxCode = 'UST81' } = {}) {
  const lines = buildVatLines(w.ctx, {
    counterAccount: w.accId('1100'),
    revenueOrExpenseAccount: w.accId('3200'),
    amountMinor: net,
    amountIsGross: false,
    taxCode,
    direction: 'output',
    supplyDate: date,
  });
  return must(postEntry(w.ctx, { date, source: 'manual', idempotencyKey: key('sale'), lines }), 'post sale');
}

/** Save a draft dated inside Q2 through the registry, so the `no_drafts` check has something to count. */
function saveDraft(w) {
  return must(
    w.call('save_draft', {
      date: '2026-06-10',
      description: 'Entwurf',
      lines: [
        { account: w.accId('6500'), debit: 1000 },
        { account: w.accId('1000'), credit: 1000 },
      ],
      idempotencyKey: key('draft'),
    }),
    'save draft',
  );
}

// --- Start (1.1 to 1.5) --------------------------------------------------------------------------

test('start: creates the run with every item, owners and due dates; the filing items sit at period end + 60 days (Art. 71 / Art. 86 MWSTG)', () => {
  const w = world('start');
  const res = start(w);
  assert.equal(res.created, true);
  assert.equal(res.periodLabel, '2026-Q2');
  assert.equal(res.periodStart, '2026-04-01');
  assert.equal(res.periodEnd, '2026-06-30');
  assert.equal(res.items.length, VAT_PERIOD_TEMPLATE.items.length);
  assert.deepEqual(res.items.map((i) => i.itemId), VAT_PERIOD_TEMPLATE.items.map((i) => i.itemId));
  assert.deepEqual(res.items.map((i) => i.ownerKind), ['system', 'system', 'system', 'agent', 'human', 'agent', 'human', 'human', 'human']);
  assert.equal(item(res, 'eportal_filed').dueAt, '2026-08-29');
  assert.equal(item(res, 'period_locked').dueAt, '2026-08-29');
  assert.equal(item(res, 'settlement_booked').dueAt, '2026-08-29');
  assert.equal(item(res, 'vat_return_computed').dueAt, '2026-07-30');
  // Items 1 to 3 inherit item 4's date (plan finding 3): no fresh run opens with three overdue rows.
  for (const id of ['no_drafts', 'bank_reconciled', 'tax_codes_complete']) assert.equal(item(res, id).dueAt, '2026-07-30');
  assert.equal(item(res, 'vat_return_computed').verb, 'vat_return');
  assert.equal(item(res, 'ech0217_exported').verb, 'vat_export_ech0217');
  assert.equal(res.status, 'open');
});

test('start twice: the natural key wins (created:false, one row); a replay of the SAME key answers identically', () => {
  const w = world('twice');
  const first = w.call('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: 'same-key' });
  must(first, 'first');
  const second = must(w.call('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: 'other-key' }), 'second');
  assert.equal(second.created, false);
  assert.equal(second.runId, first.runId);
  const rows = w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM checklist_run WHERE workspace_id = ?').get(w.wid);
  assert.equal(rows.n, 1);
  const replay = w.call('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: 'same-key' });
  assert.deepEqual(replay, first);
});

test('start refuses: needs_vat_config without A05, period_not_filable naming the year\'s periods, unknown_template', () => {
  const bare = world('noconfig', { configured: false });
  refuse(bare.call('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: key('nc') }), 'needs_vat_config', 'no config');
  const w = world('badperiod');
  const bad = refuse(w.call('checklist_start', { templateId: 'vat_period', period: '2026-H1', idempotencyKey: key('bp') }), 'period_not_filable', 'semester on effektiv');
  assert.deepEqual(bad.periods, ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  refuse(w.call('checklist_start', { templateId: 'year_close', period: '2026', idempotencyKey: key('ut') }), 'unknown_template', 'unknown template');
});

// --- System checks (3.1 / 3.2) -------------------------------------------------------------------

test('a system check flips live without a write: a draft opens no_drafts with its count, clearing it closes the item again', () => {
  const w = world('drafts');
  const run = start(w);
  assert.equal(item(run, 'no_drafts').status, 'done');
  const draft = saveDraft(w);
  const withDraft = must(w.call('checklist_get', { runId: run.runId }), 'get');
  const noDrafts = item(withDraft, 'no_drafts');
  assert.equal(noDrafts.status, 'open');
  assert.equal(noDrafts.checkResult.passed, false);
  assert.equal(noDrafts.checkResult.count, 1);
  assert.equal(noDrafts.storedStatus, 'open', 'a check item is never written');
  assert.equal(noDrafts.deepLink, '/journal');
  // Item 4 waits on the check.
  assert.equal(item(withDraft, 'vat_return_computed').blockedBy, 'no_drafts');
  refuse(w.call('checklist_item_complete', { runId: run.runId, itemId: 'no_drafts', idempotencyKey: key('c') }), 'check_item_live', 'hand-completing a check');
  must(w.call('delete_draft', { entryId: draft.entryId, idempotencyKey: key('drop-draft') }), 'delete the draft');
  const after = must(w.call('checklist_get', { runId: run.runId }), 'get after');
  assert.equal(item(after, 'no_drafts').status, 'done');
  assert.equal(item(after, 'vat_return_computed').blockedBy, null);
  assert.equal(after.nextItemId, 'vat_return_computed');
});

// --- Verb items (4.1 to 4.3) ---------------------------------------------------------------------

test('complete: the engine binds the computed return hash; prerequisite_open names the blocker; evidence_mismatch refuses a foreign ref', () => {
  const w = world('verb');
  postSale(w);
  const run = start(w);
  refuse(w.call('checklist_item_complete', { runId: run.runId, itemId: 'ech0217_exported', idempotencyKey: key('early') }), 'prerequisite_open', 'export before review').prerequisiteItemId;
  const blocked = refuse(w.call('checklist_item_complete', { runId: run.runId, itemId: 'abstimmung_reviewed', idempotencyKey: key('early2') }), 'prerequisite_open', 'review before return');
  assert.equal(blocked.prerequisiteItemId, 'vat_return_computed');

  refuse(
    w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', evidence: { kind: 'verb_result', ref: 'vat_return:deadbeef' }, idempotencyKey: key('mm') }),
    'evidence_mismatch',
    'foreign ref',
  );
  const done = must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('c4') }), 'complete 4');
  assert.equal(done.alreadyDone, false);
  assert.equal(done.item.status, 'done');
  assert.equal(done.item.evidence.kind, 'verb_result');
  assert.equal(done.item.evidence.ref, `vat_return:${run.returnHash}`);
  assert.equal(done.item.completedByKind, 'studio');
  const again = must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('c4b') }), 'complete 4 again');
  assert.equal(again.alreadyDone, true);
  // The audit log carries the act.
  const audit = w.deps.store.db.prepare("SELECT action FROM audit_log WHERE workspace_id = ? AND entity_kind = 'checklist_run' ORDER BY rowid").all(w.wid).map((r) => r.action);
  assert.deepEqual(audit, ['create', 'complete']);
});

test('complete: a verb item goes stale when the return changes after it was bound, and re-completes with the new hash', () => {
  const w = world('stale');
  postSale(w);
  const run = start(w);
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('c4') }), 'complete 4');
  postSale(w, { date: '2026-06-01', net: 50_000 });
  const view = must(w.call('checklist_get', { runId: run.runId }), 'get');
  const it = item(view, 'vat_return_computed');
  assert.equal(it.status, 'open');
  assert.equal(it.stale, true);
  assert.equal(it.storedStatus, 'done');
  assert.equal(view.nextItemId, 'vat_return_computed');
  const redo = must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('c4r') }), 'recomplete');
  assert.equal(redo.item.stale, false);
  assert.equal(redo.item.evidence.ref, `vat_return:${view.returnHash}`);
});

test('complete: evidence_required on the payment sign-off without a reference, and on the attestation without a date', () => {
  const w = world('evidence');
  const run = start(w);
  // Walk to item 7 and 9 quickly: no figures (nil return), so the bridge matches.
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('a') }), '4');
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'abstimmung_reviewed', idempotencyKey: key('b') }), '5');
  must(w.call('update_company_profile', { name: 'Checkliste GmbH', uid: 'CHE-116.281.271' }), 'uid');
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'ech0217_exported', idempotencyKey: key('c') }), '6');
  const noDate = refuse(w.call('checklist_item_complete', { runId: run.runId, itemId: 'eportal_filed', idempotencyKey: key('d') }), 'evidence_required', 'attest without date');
  assert.equal(noDate.evidenceKind, 'filed_attestation');
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'eportal_filed', evidence: { kind: 'filed_attestation', ref: '2026-07-16' }, idempotencyKey: key('e') }), '7');
  must(w.call('vat_mark_filed', { period: '2026-Q2', idempotencyKey: key('f') }), 'mark filed');
  const noRef = refuse(w.call('checklist_item_complete', { runId: run.runId, itemId: 'settlement_booked', idempotencyKey: key('g') }), 'evidence_required', 'payment without ref');
  assert.equal(noRef.evidenceKind, 'signoff');
});

// --- The attestation (5.1 / 5.2) -----------------------------------------------------------------

test('attestation: a date not before the export, refused twice while live (already_attested), voided by reopen', () => {
  const w = world('attest');
  const run = start(w);
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('a') }), '4');
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'abstimmung_reviewed', idempotencyKey: key('b') }), '5');
  refuse(w.call('checklist_item_complete', { runId: run.runId, itemId: 'eportal_filed', evidence: { kind: 'filed_attestation', ref: '2026-07-16' }, idempotencyKey: key('x') }), 'prerequisite_open', 'attest before export');
  must(w.call('update_company_profile', { name: 'Checkliste GmbH', uid: 'CHE-116.281.271' }), 'uid');
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'ech0217_exported', idempotencyKey: key('c') }), '6');
  const early = refuse(
    w.call('checklist_item_complete', { runId: run.runId, itemId: 'eportal_filed', evidence: { kind: 'filed_attestation', ref: '2026-07-10' }, idempotencyKey: key('d') }),
    'attestation_before_export',
    'date before export',
  );
  assert.equal(early.exportedAt, '2026-07-16');
  const attested = must(
    w.call('checklist_item_complete', { runId: run.runId, itemId: 'eportal_filed', evidence: { kind: 'filed_attestation', ref: '2026-07-16' }, idempotencyKey: key('e') }),
    'attest',
  );
  assert.equal(attested.item.status, 'done');
  assert.equal(attested.item.signoff.kind, 'filed_attestation');
  assert.equal(attested.item.signoff.evidenceRef, '2026-07-16');
  assert.equal(attested.item.signoff.actorKind, 'studio');
  const twice = refuse(
    w.call('checklist_item_complete', { runId: run.runId, itemId: 'eportal_filed', evidence: { kind: 'filed_attestation', ref: '2026-07-20' }, idempotencyKey: key('f') }),
    'already_attested',
    'second attestation',
  );
  assert.equal(twice.attestedOn, '2026-07-16');
  assert.equal(twice.actor, 'studio');
  const reopened = must(w.call('checklist_item_reopen', { runId: run.runId, itemId: 'eportal_filed', idempotencyKey: key('g') }), 'reopen');
  assert.equal(reopened.voidedSignoffId, attested.signoffId);
  assert.equal(reopened.item.status, 'open');
  const voided = w.deps.store.db.prepare('SELECT voided_at, void_reason FROM checklist_signoff WHERE id = ?').get(attested.signoffId);
  assert.equal(voided.void_reason, 'reopened');
  assert.ok(voided.voided_at);
  // Append-only: the voided row cannot be deleted or rewritten.
  assert.throws(() => w.deps.store.db.prepare('DELETE FROM checklist_signoff WHERE id = ?').run(attested.signoffId), /signoff_append_only/);
  assert.throws(() => w.deps.store.db.prepare("UPDATE checklist_signoff SET evidence_ref = '2026-01-01' WHERE id = ?").run(attested.signoffId), /signoff_append_only/);
});

// --- The bridge sign-off (finding 5, the hash binding) -------------------------------------------

test('bridge sign-off: check_not_passed while the bridge is open; signed sign-off goes stale on a hash change and is voided hash_changed on re-sign', () => {
  const w = world('bridge');
  postSale(w);
  const run = start(w);
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('a') }), '4');
  // Break the bridge: a manual posting onto 2200 that the return does not carry.
  must(
    postEntry(w.ctx, {
      date: '2026-06-20',
      source: 'manual',
      idempotencyKey: key('drift'),
      lines: [
        { account: w.accId('1000'), debit: 700 },
        { account: w.accId('2200'), credit: 700 },
      ],
    }),
    'drift posting',
  );
  const open = must(w.call('checklist_get', { runId: run.runId }), 'get');
  assert.equal(item(open, 'abstimmung_reviewed').preconditionResult.passed, false);
  // Item 4 went stale with the drift posting: re-bind it first, then the bridge still refuses.
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('a2') }), '4 again');
  const notPassed = refuse(w.call('checklist_item_complete', { runId: run.runId, itemId: 'abstimmung_reviewed', idempotencyKey: key('b') }), 'check_not_passed', 'sign while open');
  assert.equal(notPassed.check, 'abstimmung_resolved');
});

test('bridge sign-off: a signed review goes stale on a hash change (open again, nothing written) and the re-sign voids it hash_changed', () => {
  // A clean world: sales through buildVatLines book 2200 exactly, so the bridge matches from the start.
  const w = world('bridge-stale');
  postSale(w);
  const run = start(w);
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('a') }), '4');
  const signed = must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'abstimmung_reviewed', idempotencyKey: key('c') }), 'sign 5');
  assert.equal(signed.item.status, 'done');
  const boundHash = signed.item.signoff.hash;
  assert.ok(boundHash);
  // A new sale moves the hash: the sign-off is stale, the item reads open, nothing was written.
  postSale(w, { date: '2026-06-25', net: 30_000 });
  const stale = must(w.call('checklist_get', { runId: run.runId }), 'get stale');
  assert.equal(item(stale, 'abstimmung_reviewed').status, 'open');
  assert.equal(item(stale, 'abstimmung_reviewed').stale, true);
  assert.equal(item(stale, 'abstimmung_reviewed').signoff.stale, true);
  const untouched = w.deps.store.db.prepare('SELECT voided_at FROM checklist_signoff WHERE id = ?').get(signed.signoffId);
  assert.equal(untouched.voided_at, null, 'a read voids nothing');
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('a4') }), '4 again');
  const resigned = must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'abstimmung_reviewed', idempotencyKey: key('d') }), 'resign 5');
  assert.notEqual(resigned.item.signoff.hash, boundHash);
  const old = w.deps.store.db.prepare('SELECT void_reason FROM checklist_signoff WHERE id = ?').get(signed.signoffId);
  assert.equal(old.void_reason, 'hash_changed');
});

// --- Skip and reopen (6.1 / 6.2) -----------------------------------------------------------------

test('skip: needs a reason, refuses the three undeletable items, shows the reason and actor; reopen returns it to open', () => {
  const w = world('skip');
  const run = start(w);
  refuse(w.call('checklist_item_skip', { runId: run.runId, itemId: 'ech0217_exported', reason: '  ', idempotencyKey: key('r') }), 'skip_needs_reason', 'blank reason');
  for (const id of ['vat_return_computed', 'period_locked', 'settlement_booked']) {
    refuse(w.call('checklist_item_skip', { runId: run.runId, itemId: id, reason: 'x', idempotencyKey: key('u') }), 'undeletable', `skip ${id}`);
  }
  const skipped = must(w.call('checklist_item_skip', { runId: run.runId, itemId: 'ech0217_exported', reason: 'Von Hand im ePortal erfasst.', idempotencyKey: key('s') }), 'skip');
  assert.equal(skipped.item.status, 'skipped');
  assert.equal(skipped.item.skipReason, 'Von Hand im ePortal erfasst.');
  assert.equal(skipped.item.skippedBy, 'studio');
  const reopened = must(w.call('checklist_item_reopen', { runId: run.runId, itemId: 'ech0217_exported', idempotencyKey: key('o') }), 'reopen');
  assert.equal(reopened.item.status, 'open');
  assert.equal(reopened.item.skipReason, null);
  const audit = w.deps.store.db.prepare("SELECT action FROM audit_log WHERE workspace_id = ? AND entity_kind = 'checklist_run' ORDER BY rowid").all(w.wid).map((r) => r.action);
  assert.deepEqual(audit, ['create', 'skip', 'reopen']);
});

// --- Done, abandon, list (8.1 / 8.2 / 10.1) ------------------------------------------------------

test('a full walk reaches the derived done; the run status is never stored', () => {
  const w = world('walk');
  const run = start(w);
  must(w.call('update_company_profile', { name: 'Checkliste GmbH', uid: 'CHE-116.281.271' }), 'uid');
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('1') }), '4');
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'abstimmung_reviewed', idempotencyKey: key('2') }), '5');
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'ech0217_exported', idempotencyKey: key('3') }), '6');
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'eportal_filed', evidence: { kind: 'filed_attestation', ref: '2026-07-16' }, idempotencyKey: key('4') }), '7');
  const beforeLock = must(w.call('checklist_get', { runId: run.runId }), 'before lock');
  assert.equal(item(beforeLock, 'period_locked').status, 'open');
  assert.equal(item(beforeLock, 'settlement_booked').blockedBy, 'period_locked');
  must(w.call('vat_mark_filed', { period: '2026-Q2', idempotencyKey: key('5') }), 'mark filed');
  const locked = must(w.call('checklist_get', { runId: run.runId }), 'after lock');
  assert.equal(item(locked, 'period_locked').status, 'done');
  assert.equal(locked.nextItemId, 'settlement_booked');
  must(w.call('checklist_item_complete', { runId: run.runId, itemId: 'settlement_booked', evidence: { kind: 'signoff', ref: 'bank_txn:zkb-2026-08-20' }, idempotencyKey: key('6') }), '9');
  const done = must(w.call('checklist_get', { runId: run.runId }), 'done');
  assert.equal(done.status, 'done');
  assert.equal(done.openCount, 0);
  assert.equal(done.nextItemId, null);
  const stored = w.deps.store.db.prepare('SELECT status FROM checklist_run WHERE id = ?').get(run.runId);
  assert.equal(stored.status, 'open', 'done is derived, never stored');
  const listed = must(w.call('checklist_list', {}), 'list');
  assert.equal(listed.runs[0].status, 'done');
  assert.equal(listed.runs[0].doneCount, 9);
});

test('abandon: needs a reason, stays listed under the filter, every later write refuses run_abandoned', () => {
  const w = world('abandon');
  const run = start(w);
  refuse(w.call('checklist_abandon', { runId: run.runId, reason: '', idempotencyKey: key('a') }), 'invalid_input', 'no reason');
  const gone = must(w.call('checklist_abandon', { runId: run.runId, reason: 'Falsche Periode.', idempotencyKey: key('b') }), 'abandon');
  assert.equal(gone.status, 'abandoned');
  assert.equal(gone.abandonReason, 'Falsche Periode.');
  refuse(w.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('c') }), 'run_abandoned', 'complete after abandon');
  refuse(w.call('checklist_item_skip', { runId: run.runId, itemId: 'no_drafts', reason: 'x', idempotencyKey: key('d') }), 'run_abandoned', 'skip after abandon');
  const listed = must(w.call('checklist_list', { status: 'abandoned' }), 'list abandoned');
  assert.equal(listed.runs.length, 1);
  assert.equal(must(w.call('checklist_list', { status: 'open' }), 'list open').runs.length, 0);
  // A new run for the same period is refused by the natural key: the abandoned run still occupies it.
  const again = must(w.call('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: key('e') }), 'start again');
  assert.equal(again.created, false);
  assert.equal(again.status, 'abandoned');
});

test('list: open first, then done, then abandoned; newest period first within a group', () => {
  const w = world('list');
  start(w, '2026-Q1', 'q1');
  const q2 = start(w, '2026-Q2', 'q2');
  const older = w.call('checklist_start', { templateId: 'vat_period', period: '2025-Q4', idempotencyKey: key('q4') });
  if (older.ok) must(w.call('checklist_abandon', { runId: older.runId, reason: 'Vorjahr.', idempotencyKey: key('ab') }), 'abandon q4');
  const listed = must(w.call('checklist_list', {}), 'list');
  const labels = listed.runs.map((r) => `${r.periodLabel}:${r.status}`);
  assert.deepEqual(labels.slice(0, 2), ['2026-Q2:open', '2026-Q1:open']);
  if (older.ok) assert.equal(labels[2], '2025-Q4:abandoned');
  assert.equal(listed.runs[0].runId, q2.runId);
});

// --- Deadlines (the compliance fixture) ----------------------------------------------------------

test('deadlines: Q2/2026 resolves the filing and payment items to 2026-08-29 (period end + 60 days) and the sibling inheritance', () => {
  const due = resolveDueDates(VAT_PERIOD_TEMPLATE.items, '2026-06-30');
  assert.equal(due.get('eportal_filed'), '2026-08-29');
  assert.equal(due.get('period_locked'), '2026-08-29');
  assert.equal(due.get('settlement_booked'), '2026-08-29');
  assert.equal(due.get('vat_return_computed'), '2026-07-30');
  assert.equal(due.get('no_drafts'), '2026-07-30');
  // A semester (Saldo) end: 60 days after 2026-12-31 crosses the year.
  assert.equal(resolveDueDates(VAT_PERIOD_TEMPLATE.items, '2026-12-31').get('eportal_filed'), '2027-03-01');
});

// --- G15 (7.1 / 7.2) -----------------------------------------------------------------------------

test('G15: the provider registers, counts open items due within 14 days (overdue after the date), and an abandoned run contributes nothing', () => {
  assert.ok(ATTENTION_PROVIDERS.some((p) => p.queueId === 'checklist_items_due'), 'provider registered');
  const w = world('hub');
  // The fixture clock is 2026-07-16; 2026-Q1's item 4 date (2026-04-30) is overdue and 2026-Q2's
  // items 1 to 4 (2026-07-30) are due within the window; the 2026-08-29 items are outside it.
  const q1 = start(w, '2026-Q1', 'q1');
  start(w, '2026-Q2', 'q2');
  const summary = must(attentionSummary(w.ctx, {}), 'summary');
  const queue = summary.queues.find((q) => q.queueId === 'checklist_items_due');
  assert.ok(queue, 'queue present');
  // Q1: item 4 (system checks 1 to 3 pass on an empty book, so only the agent item is open and due);
  // Q2: item 4 likewise. Items 5+ are blocked and later, but blocked open items ARE listed when due.
  const list = must(attentionList(w.ctx, { queueId: 'checklist_items_due', limit: 50 }), 'list');
  const q1Rows = list.items.filter((i) => i.deepLink.params.run === q1.runId);
  assert.ok(q1Rows.length >= 1);
  assert.equal(q1Rows[0].urgency, 'overdue');
  assert.equal(q1Rows[0].deepLink.route, '/checklisten');
  assert.equal(queue.count, list.items.length, 'count equals the untruncated derived set');
  const q2Rows = list.items.filter((i) => i.deepLink.params.run !== q1.runId);
  assert.ok(q2Rows.every((i) => i.urgency === 'due'));
  must(w.call('checklist_abandon', { runId: q1.runId, reason: 'Vorperiode.', idempotencyKey: key('ab') }), 'abandon q1');
  const after = must(attentionList(w.ctx, { queueId: 'checklist_items_due', limit: 50 }), 'list after');
  assert.equal(after.items.filter((i) => i.deepLink.params.run === q1.runId).length, 0, 'abandoned run invisible');
});

// --- Invariants ----------------------------------------------------------------------------------

test('no _rappen column on any checklist table, and every table carries workspace_id', () => {
  assert.equal(/_rappen/.test(CHECKLISTS_SCHEMA_SQL), false);
  const w = world('schema');
  for (const table of ['checklist_run', 'checklist_run_item', 'checklist_signoff']) {
    const cols = w.deps.store.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.ok(cols.includes('workspace_id'), `${table} carries workspace_id`);
    assert.equal(cols.some((c) => c.endsWith('_rappen') || c.endsWith('_minor')), false, `${table} carries no money column`);
  }
});

test('§H-TENANT: a second workspace sees nothing of the first (get, list, complete, hub)', () => {
  const a = world('tenant-a');
  const run = start(a);
  const b = world('tenant-b');
  refuse(b.call('checklist_get', { runId: run.runId }), 'not_found', 'cross-tenant get');
  refuse(b.call('checklist_item_complete', { runId: run.runId, itemId: 'vat_return_computed', idempotencyKey: key('x') }), 'not_found', 'cross-tenant complete');
  refuse(b.call('checklist_abandon', { runId: run.runId, reason: 'x', idempotencyKey: key('y') }), 'not_found', 'cross-tenant abandon');
  assert.equal(must(b.call('checklist_list', {}), 'list b').runs.length, 0);
  const hubB = must(attentionList(b.ctx, { queueId: 'checklist_items_due', limit: 50 }), 'hub b');
  assert.equal(hubB.items.length, 0);
  // Same store, two tenants: the shared-store shape a Treuhänder runs.
  const c = world('tenant-c');
  c.deps.store = a.deps.store;
  const { workspaceId: cid } = mintWorkspace(a.deps, 'Andere GmbH', 'tenant-c2');
  const callC = (name, input) => getAction(name).run(a.deps, { workspaceId: cid, ...input });
  refuse(callC('checklist_get', { runId: run.runId }), 'not_found', 'shared-store cross-tenant get');
  assert.equal(must(callC('checklist_list', {}), 'list c').runs.length, 0);
});

test('permission: the five writes gate on manage_checklists, the three reads on read_books, and the bundles holding post hold the new capability', () => {
  for (const verb of ['checklist_start', 'checklist_item_complete', 'checklist_item_skip', 'checklist_item_reopen', 'checklist_abandon']) {
    assert.equal(CAPABILITY_FOR_ACTION[verb], 'manage_checklists', verb);
  }
  for (const verb of ['checklist_templates', 'checklist_get', 'checklist_list']) {
    assert.equal(CAPABILITY_FOR_ACTION[verb], 'read_books', verb);
  }
  for (const role of ['bookkeeper', 'treuhaender', 'agent']) {
    const bundle = BUILTIN_ROLE_DEFAULTS.get(role);
    assert.ok(bundle.includes('post') && bundle.includes('manage_checklists'), `${role} holds post and manage_checklists`);
  }
  assert.equal(CAPABILITY_FOR_ACTION.vat_mark_filed, 'vat_file', 'item 8 keeps the statutory gate');
});
