/**
 * G22 leg 2 (D129): the generalised checklist engine, driven over the `test_kinds` FIXTURE template
 * (registered only under `NODE_ENV=test`, which this suite sets BEFORE its dynamic imports because
 * `node --test` does not) so every item kind is proven before the real close templates exist.
 *
 * What this file proves: the fixture carries every kind and the registry hides it outside test;
 * `checklist_start` with an omitted period, `period_not_ended`, `invalid_period`; the derived
 * choices (legal form off the workspace, FC positions off A22, assets off the register), the
 * pre-selected default that is not an answer, `invalid_choice`, the human overrule and the reopen back
 * to the derived answer, `excluded` by derivation (never stored, settled for prerequisites, outside
 * `openCount`, invisible to the hub), `item_excluded`, `choice_locked`; the preview bound through
 * `VERB_EVIDENCE` (canonical hash, `evidence_mismatch`, `read_refused` on an unregistered verb, the
 * `emptyWhen` exclusion, `postedBelow`); the posting as a derivation (the probe wins,
 * `check_item_live` on complete and reopen, the A38 probe answering `found:false` on an empty period, the real A22 probe
 * over a posted revaluation, the month lock over A03); the validations (`block` refusing
 * `check_not_passed`, `warn` acknowledged with a hash-bound sign-off that goes stale and is voided
 * with `hash_changed`, `unavailable` on a first year); the statements sign-off bound to the anchor
 * (moves on a posting inside the period, not after it, not on the seal's own entry); the GV
 * attestation (a date before the statements sign-off needs a reason, `already_attested`); the run
 * reaching `done`; the period kinds (`month`, `year`, the `04-01` fiscal year, `year_already_closed`);
 * the deadlines (180 / 240 days and six months on a year, null on a month); the seeded auto-start
 * rules (INSERT WHERE NOT EXISTS, a disabled rule never re-enabled, the daily tick starting exactly
 * one run); `template_not_automatable` at rule definition and patch; the prompt line shapes per kind
 * in parity with `checklist_get`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { getAction } = await import('../../dist/api/registry.js');
const { makeContext } = await import('../../dist/core/context.js');
const { ledgerPorts, postEntry } = await import('../../dist/core/ledger/index.js');
const { attentionList } = await import('../../dist/core/attention/index.js');
const { createAssetCategory } = await import('../../dist/core/assets/index.js');
const { NOT_AUTOMATABLE_INPUTS, notAutomatableInput } = await import('../../dist/core/automation/denylist.js');
const chk = await import('../../dist/core/checklists/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');

const {
  CHECKLIST_EVIDENCE_KINDS,
  CHECKLIST_PROBE_KEYS,
  CHECKLIST_VALIDATION_KEYS,
  CHECKLIST_SIGNOFF_KINDS,
  CHECKLIST_DERIVED_ITEM_STATUSES,
  CHECKLIST_ITEM_STATUSES,
  CHECKLIST_TEMPLATES,
  TEST_KINDS_TEMPLATE,
  DEADLINE_DAYS_AFTER_PERIOD_END,
  NOT_AUTOMATABLE_TEMPLATE_IDS,
  TEMPLATE_NOT_AUTOMATABLE_CODE,
  CHECKLIST_AUTOSTART_RULE_IDS,
  checklistAutostartRuleId,
  addMonths,
  canonicalHashOf,
  checklistTemplate,
  resolveDueDates,
  resolveChecklistPeriod,
  pickChecklistPeriod,
  renderChecklistPrompt,
  seedDefaultChecklistRules,
  statementsHashOf,
  readMemoOf,
  verbEvidenceOf,
  VERB_EVIDENCE,
} = chk;

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
const key = (tag) => `kinds-${tag}-${(seq += 1)}`;

/** A GmbH workspace at the fixture clock (2026-07-16): 2026-06 is the last ended month. */
function world(seed, { legalForm = 'gmbh', actor = 'studio' } = {}) {
  const deps = freshDeps();
  deps.actor = actor;
  const { workspaceId, accId } = mintWorkspace(deps, 'Abschluss GmbH', `${seed}-ws`);
  if (legalForm !== null) deps.store.db.prepare('UPDATE workspace SET legal_form = ? WHERE id = ?').run(legalForm, workspaceId);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const ctx = makeContext(deps.store, { workspaceId, actor, clock: deps.clock, ids: deps.ids, ...ledgerPorts({ store: deps.store, workspaceId, ids: deps.ids }) });
  return { deps, wid: workspaceId, accId, call, ctx };
}

function start(w, period, tag = 'start') {
  const input = { templateId: 'test_kinds', idempotencyKey: key(tag) };
  if (period !== undefined) input.period = period;
  return must(w.call('checklist_start', input), 'start');
}

function get(w, runId) {
  return must(w.call('checklist_get', { runId }), 'get');
}

function item(view, itemId) {
  const found = view.items.find((i) => i.itemId === itemId);
  assert.ok(found, `item ${itemId} missing`);
  return found;
}

function complete(w, runId, itemId, evidence, tag = 'c') {
  const input = { runId, itemId, idempotencyKey: key(tag) };
  if (evidence !== undefined) input.evidence = evidence;
  return w.call('checklist_item_complete', input);
}

/** A balanced manual posting through the registry: `debit` and `credit` are account numbers. */
function post(w, { date, debit, credit, amount, source = 'manual', tag = 'p' }) {
  return must(
    w.call('post_entry', {
      date,
      source,
      description: `${debit}/${credit}`,
      idempotencyKey: key(tag),
      lines: [
        { account: w.accId(debit), debit: amount },
        { account: w.accId(credit), credit: amount },
      ],
    }),
    `post ${debit}/${credit}`,
  );
}

// --- The fixture and the registry ---------------------------------------------------------------

test('the fixture carries every item kind, every probe and validation key is registered, and the registry hides it outside test', () => {
  const kinds = new Set(TEST_KINDS_TEMPLATE.items.map((i) => i.evidenceKind));
  for (const kind of CHECKLIST_EVIDENCE_KINDS) assert.ok(kinds.has(kind), `fixture exercises ${kind}`);
  assert.equal(CHECKLIST_EVIDENCE_KINDS.length, 8);
  assert.equal(CHECKLIST_PROBE_KEYS.length, 9);
  assert.equal(CHECKLIST_VALIDATION_KEYS.length, 13);
  assert.equal(CHECKLIST_SIGNOFF_KINDS.length, 6);
  assert.deepEqual([...CHECKLIST_DERIVED_ITEM_STATUSES], [...CHECKLIST_ITEM_STATUSES, 'excluded']);
  assert.equal(TEST_KINDS_TEMPLATE.anchor, 'statements');
  assert.equal(TEST_KINDS_TEMPLATE.periodKind, 'month');
  // Shipped data never carries the fixture; the live registry carries it only under test.
  assert.equal(CHECKLIST_TEMPLATES.some((t) => t.templateId === 'test_kinds'), false);
  const w = world('registry');
  const listed = must(w.call('checklist_templates', {}), 'templates');
  const fixture = listed.templates.find((t) => t.templateId === 'test_kinds');
  assert.ok(fixture, 'fixture listed under NODE_ENV=test');
  assert.equal(fixture.anchor, 'statements');
  assert.equal(listed.templates.find((t) => t.templateId === 'vat_period').anchor, 'vat_return');
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal(checklistTemplate('test_kinds'), undefined, 'the fixture is unreachable outside test');
    refuse(w.call('checklist_start', { templateId: 'test_kinds', idempotencyKey: key('prod') }), 'unknown_template', 'start outside test');
  } finally {
    process.env.NODE_ENV = before;
  }
});

// --- Start: the optional period and the month kind ----------------------------------------------

test('start: an omitted period picks the last ended month, a running month refuses period_not_ended, the pacing offsets and the year-only rules resolve', () => {
  const w = world('start');
  const res = start(w);
  assert.equal(res.created, true);
  assert.equal(res.periodLabel, '2026-06');
  assert.equal(res.periodStart, '2026-06-01');
  assert.equal(res.periodEnd, '2026-06-30');
  assert.equal(res.periodKind, 'month');
  assert.equal(res.anchorKind, 'statements');
  assert.equal(res.items.length, TEST_KINDS_TEMPLATE.items.length);
  assert.equal(item(res, 'no_drafts').dueAt, '2026-07-10');
  assert.equal(item(res, 'statements_signed').dueAt, '2026-07-20');
  assert.equal(item(res, 'gv_approved').dueAt, null, 'gv_6_months does not resolve on a month');
  assert.equal(item(res, 'capital_loss_check').dueAt, null, 'umsatzabstimmung_180 does not resolve on a month');
  const again = must(w.call('checklist_start', { templateId: 'test_kinds', idempotencyKey: key('again') }), 'again');
  assert.equal(again.created, false);
  assert.equal(again.runId, res.runId);
  refuse(w.call('checklist_start', { templateId: 'test_kinds', period: '2026-07', idempotencyKey: key('running') }), 'period_not_ended', 'running month');
  refuse(w.call('checklist_start', { templateId: 'test_kinds', period: '2026-6', idempotencyKey: key('bad') }), 'invalid_period', 'bad label');
  const may = must(w.call('checklist_start', { templateId: 'test_kinds', period: '2026-05', idempotencyKey: key('may') }), 'may');
  assert.equal(may.periodEnd, '2026-05-31');
});

// --- Choices, derivation, exclusion -------------------------------------------------------------

test('choices: derived off the books, the default is not an answer, excluded rows settle prerequisites and leave the counts and the hub', () => {
  const w = world('choice');
  const run = start(w);
  const legal = item(run, 'legal_form');
  assert.equal(legal.status, 'done');
  assert.deepEqual(legal.choice, { optionId: 'gmbh', source: 'derived' });
  assert.equal(legal.storedStatus, 'open', 'a derived answer is never stored');
  assert.deepEqual(item(run, 'has_fc_positions').choice, { optionId: 'no', source: 'derived' });
  assert.deepEqual(item(run, 'has_assets').choice, { optionId: 'no', source: 'derived' });
  const accruals = item(run, 'accruals_needed');
  assert.equal(accruals.status, 'open');
  assert.equal(accruals.choice, null);
  assert.equal(accruals.defaultOptionId, 'no');
  for (const id of ['fx_preview', 'fx_posted', 'depreciation_preview', 'depreciation_posted']) {
    const row = item(run, id);
    assert.equal(row.status, 'excluded', `${id} excluded`);
    assert.equal(row.storedStatus, 'open', `${id} exclusion is never stored`);
    assert.equal(row.blockedBy, null);
  }
  assert.deepEqual(item(run, 'fx_preview').excludedBy, { itemId: 'has_fc_positions', optionId: 'no' });
  assert.equal(item(run, 'capital_loss_check').status, 'open', 'included under gmbh (no capital yet: unavailable)');
  assert.equal(item(run, 'gv_approved').excludedBy, null, 'included under gmbh');
  assert.equal(item(run, 'accruals_preview').status, 'open', 'no answer yet: included, blocked');
  assert.equal(item(run, 'accruals_preview').blockedBy, 'accruals_needed');
  assert.equal(run.excludedCount, 4);
  assert.equal(run.openCount, run.items.filter((i) => i.status === 'open').length);
  assert.equal(run.nextItemId, 'accruals_needed');
  const hub = must(attentionList(w.ctx, { queueId: 'checklist_items_due', limit: 50 }), 'hub');
  const ids = hub.items.filter((i) => i.deepLink.params.run === run.runId).map((i) => i.titleParams.title);
  assert.equal(ids.includes(item(run, 'fx_preview').title), false, 'an excluded row never reaches the hub');
  assert.ok(ids.includes(item(run, 'accruals_needed').title), 'an open due row does');

  // Einzelfirma: the GmbH-only rows leave by derivation.
  const e = world('einzel', { legalForm: 'einzelfirma' });
  const er = start(e);
  assert.equal(item(er, 'capital_loss_check').status, 'excluded');
  assert.equal(item(er, 'gv_approved').status, 'excluded');
  // No legal form on file: the choice stays open, nothing it governs is excluded, and the rows wait.
  const n = world('noform', { legalForm: null });
  const nr = start(n);
  assert.equal(item(nr, 'legal_form').status, 'open');
  assert.equal(item(nr, 'legal_form').choice, null);
  assert.equal(item(nr, 'gv_approved').status, 'open');
  assert.equal(item(nr, 'capital_loss_check').blockedBy, 'legal_form');
});

test('choices: vat_method derives from the era that governed the run period, not the current workspace method; two eras over one period answer nothing', () => {
  const w = world('vat-era');
  // Effektiv until 31.12.2025, saldo from 1.1.2026: the closed era is on file, the workspace row is the tail.
  w.deps.store.db
    .prepare(`INSERT INTO vat_method_era (workspace_id, valid_from, valid_to, method, timing, created_at, created_by) VALUES (?, '0001-01-01', '2025-12-31', 'effektiv', 'soll', ?, 'studio')`)
    .run(w.wid, '2026-01-01T00:00:00.000Z');
  w.deps.store.db.prepare(`UPDATE workspace SET vat_method = 'saldo' WHERE id = ?`).run(w.wid);
  const dec = start(w, '2025-12', 'dec');
  assert.deepEqual(item(dec, 'vat_method').choice, { optionId: 'effektiv', source: 'derived' }, 'the run period is governed by the closed era');
  assert.equal(item(dec, 'vat_method').status, 'done');
  const jan = start(w, '2026-01', 'jan');
  assert.deepEqual(item(jan, 'vat_method').choice, { optionId: 'saldo', source: 'derived' }, 'the tail era governs the new year');
  // A second change recorded mid-month: the month spans two eras, the books carry no single answer.
  w.deps.store.db
    .prepare(`INSERT INTO vat_method_era (workspace_id, valid_from, valid_to, method, timing, created_at, created_by) VALUES (?, '2026-01-01', '2026-06-14', 'saldo', 'soll', ?, 'studio')`)
    .run(w.wid, '2026-06-15T00:00:00.000Z');
  w.deps.store.db.prepare(`UPDATE workspace SET vat_method = 'none' WHERE id = ?`).run(w.wid);
  const jun = start(w, '2026-06', 'jun');
  assert.equal(item(jun, 'vat_method').choice, null, 'two eras: no derived answer');
  assert.equal(item(jun, 'vat_method').status, 'open', 'the human chooses');
  must(complete(w, jun.runId, 'vat_method', { kind: 'choice', ref: 'none' }), 'a human answer settles it');
});

test('choices: has_assets derives yes from an active asset only; a register holding nothing but a fully depreciated asset derives no', () => {
  const w = world('assets-active');
  const cat = createAssetCategory(w.ctx, {
    code: 'M1',
    name: 'Maschinen',
    depreciationMethod: 'straight_line',
    usefulLifeMonths: 60,
    glAssetAccountId: w.accId('1500'),
    glAccumDeprAccountId: w.accId('1510'),
    glDeprExpenseAccountId: w.accId('6800'),
    idempotencyKey: key('cat'),
  });
  must(cat, 'category');
  const asset = must(
    w.call('asset_create', { categoryId: cat.category.id, name: 'CNC', acquisitionDate: '2024-01-15', acquisitionCostRappen: 1250000, idempotencyKey: key('asset') }),
    'asset',
  );
  const run = start(w);
  assert.deepEqual(item(run, 'has_assets').choice, { optionId: 'no', source: 'derived' }, 'a draft is not on the register yet');
  const setStatus = (status) => w.deps.store.db.prepare('UPDATE asset SET status = ? WHERE workspace_id = ? AND id = ?').run(status, w.wid, asset.asset.id);
  setStatus('active');
  assert.deepEqual(item(get(w, run.runId), 'has_assets').choice, { optionId: 'yes', source: 'derived' }, 'an active asset opens the depreciation pair');
  setStatus('fully_depreciated');
  const view = get(w, run.runId);
  assert.deepEqual(item(view, 'has_assets').choice, { optionId: 'no', source: 'derived' }, 'nothing eligible: the pair is excluded, not left open');
  assert.equal(item(view, 'depreciation_preview').status, 'excluded');
  assert.equal(item(view, 'depreciation_posted').status, 'excluded');
});

test('choices: invalid_choice names the options, a human answer is stored and overrules, item_excluded on an excluded row, reopen falls back to the derived answer', () => {
  const w = world('answer');
  const run = start(w);
  const bad = refuse(complete(w, run.runId, 'accruals_needed', { kind: 'choice', ref: 'maybe' }), 'invalid_choice', 'unknown option');
  assert.deepEqual(bad.options, ['yes', 'no']);
  refuse(complete(w, run.runId, 'accruals_needed', { kind: 'signoff', ref: 'no' }), 'invalid_choice', 'wrong evidence kind');
  const no = must(complete(w, run.runId, 'accruals_needed', { kind: 'choice', ref: 'no' }), 'answer no');
  assert.deepEqual(no.item.choice, { optionId: 'no', source: 'human' });
  assert.equal(no.item.storedStatus, 'done');
  assert.deepEqual(no.item.evidence, { kind: 'choice', ref: 'choice:no' });
  let view = get(w, run.runId);
  assert.equal(item(view, 'accruals_preview').status, 'excluded');
  assert.equal(item(view, 'accruals_posted').status, 'excluded');
  const excl = refuse(complete(w, run.runId, 'accruals_preview', undefined), 'item_excluded', 'excluded row');
  assert.deepEqual(excl.excludedBy, { itemId: 'accruals_needed', optionId: 'no' });
  refuse(w.call('checklist_item_skip', { runId: run.runId, itemId: 'accruals_preview', reason: 'x', idempotencyKey: key('s') }), 'item_excluded', 'skip excluded');
  const same = must(complete(w, run.runId, 'accruals_needed', { kind: 'choice', ref: 'no' }), 'same answer');
  assert.equal(same.alreadyDone, true);
  must(complete(w, run.runId, 'accruals_needed', { kind: 'choice', ref: 'yes' }), 'answer yes');
  view = get(w, run.runId);
  assert.equal(item(view, 'accruals_preview').status, 'open', 're-included by derivation');
  // The A38 read is registered (N4): an empty draft list binds like any other preview, and an
  // unregistered verb is still the refusal path (proven on a verb that no template names).
  assert.equal(item(view, 'accruals_preview').previewResult.ok, true);
  const bound = must(complete(w, run.runId, 'accruals_preview', undefined), 'empty draft list bound');
  assert.match(bound.item.evidence.ref, /^accrual_list:[0-9a-f]{64}$/);
  const rr = verbEvidenceOf(w.ctx, 'no_such_verb', { label: '2026-06', periodStart: '2026-06-01', periodEnd: '2026-06-30' }, readMemoOf(w.ctx, TEST_KINDS_TEMPLATE, { label: '2026-06', periodStart: '2026-06-01', periodEnd: '2026-06-30' }));
  assert.equal(rr.ok, false);
  assert.equal(rr.details.reason, 'verb_not_registered');
  // The A38 probe is real (N4): nothing drafted and nothing posted is found:false, and the row stays open.
  const stub = item(view, 'accruals_posted');
  assert.equal(stub.probeResult.found, false);
  assert.equal(stub.probeResult.reason, undefined);
  assert.deepEqual(stub.probeResult.detail, { periodEnd: '2026-06-30', draftIds: [], postedIds: [], reversedIds: [] });
  assert.equal(stub.status, 'open');
  // Overrule a derived answer, then reopen: the derived answer returns.
  must(complete(w, run.runId, 'has_fc_positions', { kind: 'choice', ref: 'yes' }), 'overrule fc');
  view = get(w, run.runId);
  assert.deepEqual(item(view, 'has_fc_positions').choice, { optionId: 'yes', source: 'human' });
  const fxp = item(view, 'fx_preview');
  assert.equal(fxp.excludedBy, null, 'included by the overrule');
  assert.equal(fxp.previewResult.ok, true);
  assert.equal(fxp.previewResult.empty, true, 'no positions: emptyWhen holds');
  assert.equal(fxp.status, 'excluded', 'empty preview with nothing posted reads excluded');
  assert.equal(item(view, 'fx_posted').status, 'excluded', 'and so does its posting');
  const reopened = must(w.call('checklist_item_reopen', { runId: run.runId, itemId: 'has_fc_positions', idempotencyKey: key('r') }), 'reopen fc');
  assert.deepEqual(reopened.item.choice, { optionId: 'no', source: 'derived' });
  assert.equal(reopened.item.storedStatus, 'open');
});

// --- Preview, verb_result, posting ---------------------------------------------------------------

test('preview and verb_result bind the canonical hash through VERB_EVIDENCE; evidence_mismatch; the posting stays open while the probe finds nothing', () => {
  const w = world('preview');
  const run = start(w);
  must(complete(w, run.runId, 'has_assets', { kind: 'choice', ref: 'yes' }), 'overrule assets');
  let view = get(w, run.runId);
  const pv = item(view, 'depreciation_preview');
  assert.equal(pv.status, 'open');
  assert.equal(pv.previewResult.ok, true);
  assert.equal(pv.previewResult.empty, false, 'no emptyWhen pointer: never excluded by emptiness');
  assert.equal(pv.verbInputValue, '2026-06');
  const expectedHash = canonicalHashOf(pv.previewResult.payload);
  assert.equal(pv.previewResult.hash, expectedHash);
  refuse(complete(w, run.runId, 'depreciation_preview', { kind: 'preview', ref: 'asset_depreciation_preview:deadbeef' }), 'evidence_mismatch', 'wrong ref');
  const done = must(complete(w, run.runId, 'depreciation_preview', undefined), 'complete preview');
  assert.equal(done.item.status, 'done');
  assert.deepEqual(done.item.evidence, { kind: 'preview', ref: `asset_depreciation_preview:${expectedHash}` });
  view = get(w, run.runId);
  const posting = item(view, 'depreciation_posted');
  assert.equal(posting.status, 'open', 'the probe finds no posted run');
  assert.equal(posting.probeResult.found, false);
  assert.deepEqual(posting.probeResult.detail.nothingEligible, ['2026-06']);
  assert.equal(posting.blockedBy, null, 'the paired preview is done');
  refuse(complete(w, run.runId, 'depreciation_posted', undefined), 'check_item_live', 'a posting is a derivation');
  refuse(w.call('checklist_item_reopen', { runId: run.runId, itemId: 'depreciation_posted', idempotencyKey: key('rp') }), 'check_item_live', 'reopen a posting');
  // The D127 verb_result kind now binds through the same dispatcher, with a canonical hash.
  const vr = must(complete(w, run.runId, 'depreciation_previewed', undefined), 'verb_result');
  assert.equal(vr.item.status, 'done');
  assert.equal(vr.item.evidence.ref, `asset_depreciation_preview:${expectedHash}`);
  // Canonical: key order does not move the hash, `ok` is dropped.
  assert.equal(canonicalHashOf({ b: 1, a: [{ y: 2, x: 1 }], ok: true }), canonicalHashOf({ a: [{ x: 1, y: 2 }], b: 1, ok: false }));
});

test('VERB_EVIDENCE carries the A25 handover and archive verbs: each binds a canonical hash that is stable on re-read and moves on a posting inside the period', () => {
  const w = world('a25-evidence');
  const period = { label: '2026-06', periodStart: '2026-06-01', periodEnd: '2026-06-30' };
  const memo = readMemoOf(w.ctx, TEST_KINDS_TEMPLATE, period);
  const verbs = ['prepare_period', 'export_journal', 'export_statements'];
  for (const verb of verbs) assert.ok(Object.keys(VERB_EVIDENCE).includes(verb), `${verb} registered`);
  const before = Object.fromEntries(verbs.map((verb) => [verb, verbEvidenceOf(w.ctx, verb, period, memo)]));
  for (const verb of verbs) {
    const ev = before[verb];
    assert.equal(ev.ok, true, `${verb} binds evidence: ${JSON.stringify(ev)}`);
    assert.equal(ev.ref, `${verb}:${ev.hash}`);
    assert.equal(verbEvidenceOf(w.ctx, verb, period, memo).hash, ev.hash, `${verb}: same period, same hash`);
  }
  assert.equal(before.export_journal.payload.entryCount, 0);
  assert.equal(before.export_journal.payload.artifact.base64, undefined, 'the bytes are not carried, their digest is');
  assert.match(before.export_journal.payload.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(before.export_statements.payload.artifacts.length, 2);
  assert.equal(before.prepare_period.payload.total, 0);
  assert.equal(before.prepare_period.payload.entries, undefined, 'the packet summary, not the entry list');
  post(w, { date: '2026-06-20', debit: '1020', credit: '3200', amount: 7000, tag: 'inside' });
  for (const verb of verbs) {
    const after = verbEvidenceOf(w.ctx, verb, period, memo);
    assert.equal(after.ok, true);
    assert.notEqual(after.hash, before[verb].hash, `${verb}: a posting inside the period moves the hash`);
  }
  // The verb_result row binds the same way and reads stale once the figures moved.
  const run = start(w);
  refuse(complete(w, run.runId, 'depreciation_previewed', { kind: 'verb_result', ref: 'export_journal:nope' }), 'evidence_mismatch', 'the fixture row is bound to its own verb');
});

test('the A22 probe: a posted revaluation flips the posting row by derivation, the preview reads gebucht, and a manual reversal of the run entry un-does the row', () => {
  const w = world('fxprobe');
  // A EUR receivable booked at 0.96 with a 0.952 closing rate (the A22 worked example).
  must(
    w.call('post_entry', {
      date: '2026-06-15',
      source: 'manual',
      currency: 'EUR',
      fxRate: '0.9600',
      description: 'EUR position',
      idempotencyKey: key('pos'),
      lines: [
        { account: w.accId('1000'), debit: 1000000 },
        { account: w.accId('3200'), credit: 1000000 },
      ],
    }),
    'position',
  );
  must(w.call('record_exchange_rate', { baseCurrency: 'EUR', rate: '0.9520', asOf: '2026-06-30', source: 'manual', method: 'daily', idempotencyKey: key('rate') }), 'rate');
  const run = start(w);
  assert.deepEqual(item(run, 'has_fc_positions').choice, { optionId: 'yes', source: 'derived' });
  const preview = item(run, 'fx_preview');
  assert.equal(preview.status, 'open');
  assert.equal(preview.previewResult.empty, false);
  assert.equal(item(run, 'fx_posted').status, 'open');
  assert.equal(item(run, 'fx_posted').probeResult.found, false);
  const posted = must(w.call('post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: key('fx') }), 'post fx');
  let view = get(w, run.runId);
  const row = item(view, 'fx_posted');
  assert.equal(row.status, 'done', 'the probe wins: posted without touching the run');
  assert.deepEqual(row.probeResult.entryIds, [posted.entryId, posted.reversalId]);
  assert.equal(row.probeResult.reversalDate, '2026-07-01');
  assert.equal(item(view, 'fx_preview').status, 'done', 'gebucht, siehe unten');
  assert.equal(item(view, 'fx_preview').previewResult.postedBelow, true);
  // The anchor moved with the fx entry (dated inside the period).
  assert.notEqual(view.anchorHash, run.anchorHash);
  // A38's reversal-ownership guard: the revaluation entry and its scheduled reversal are `owned_by`
  // `fx_revaluation_reverse`, so the raw tool cannot touch them and the row STAYS done.
  refuse(w.call('reverse_entry', { entryId: posted.entryId, date: '2026-06-30', idempotencyKey: key('rev') }), 'owned_by', 'the raw tool on the revaluation entry');
  refuse(w.call('reverse_entry', { entryId: posted.reversalId, date: '2026-07-01', idempotencyKey: key('rev-b') }), 'owned_by', 'the raw tool on the scheduled reversal');
  view = get(w, run.runId);
  assert.equal(item(view, 'fx_posted').status, 'done');
  assert.equal(item(view, 'fx_posted').probeResult.found, true);
  // The ONE way to un-do the row is the owner verb (D129 Q2): the mirror pair lands on the run row's
  // storno link, the probe reads it, and the posting row derives back to open with the four entries named.
  const reverted = must(w.call('fx_revaluation_reverse', { runId: posted.runId, idempotencyKey: key('undo') }), 'fx_revaluation_reverse');
  view = get(w, run.runId);
  const undone = item(view, 'fx_posted');
  assert.equal(undone.status, 'open', 'a reverted run reads open again');
  assert.equal(undone.probeResult.found, false);
  assert.ok(undone.probeResult.entryIds.includes(posted.entryId));
  assert.ok(undone.probeResult.entryIds.some((id) => id !== posted.entryId && id !== posted.reversalId), 'the storno pair is named');
  assert.equal(item(view, 'fx_preview').status, 'open', 'the preview is due again once the artefact is gone');
  void reverted;
});

test('the probe wins over the exclusion: a posting under a governing "no" keeps the pair done, and choice_locked still guards the re-answer', () => {
  const w = world('probe-wins');
  must(
    w.call('post_entry', {
      date: '2026-06-15',
      source: 'manual',
      currency: 'EUR',
      fxRate: '0.9600',
      description: 'EUR position',
      idempotencyKey: key('pos'),
      lines: [
        { account: w.accId('1000'), debit: 1000000 },
        { account: w.accId('3200'), credit: 1000000 },
      ],
    }),
    'position',
  );
  must(w.call('record_exchange_rate', { baseCurrency: 'EUR', rate: '0.9520', asOf: '2026-06-30', source: 'manual', method: 'daily', idempotencyKey: key('rate') }), 'rate');
  const run = start(w);
  // A human says "no" before anything is posted: the pair is excluded by the choice.
  must(complete(w, run.runId, 'has_fc_positions', { kind: 'choice', ref: 'no' }), 'answer no');
  let view = get(w, run.runId);
  assert.equal(item(view, 'fx_posted').status, 'excluded');
  assert.equal(item(view, 'fx_preview').status, 'excluded');
  // The revaluation is posted anyway (legal without a run): the probe finds it and the pair reads done.
  must(w.call('post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: key('fx') }), 'post fx');
  view = get(w, run.runId);
  const posting = item(view, 'fx_posted');
  assert.equal(posting.status, 'done', 'the probe wins over the governing choice');
  assert.equal(posting.probeResult.found, true);
  assert.equal(item(view, 'fx_preview').status, 'done', 'gebucht, siehe unten, whatever the choice says');
  assert.equal(item(view, 'fx_preview').previewResult.postedBelow, true);
  // The artefact stands, so the choice that governs it is locked in both directions.
  const locked = refuse(complete(w, run.runId, 'has_fc_positions', { kind: 'choice', ref: 'yes' }), 'choice_locked', 're-answer to yes');
  assert.deepEqual(locked.lockedBy, ['fx_posted']);
  refuse(w.call('checklist_item_reopen', { runId: run.runId, itemId: 'has_fc_positions', idempotencyKey: key('ro') }), 'choice_locked', 'clearing the answer');
});

// --- Validations ----------------------------------------------------------------------------------

test('validations: a block refuses check_not_passed and holds its dependents; a warn is acknowledged with a hash-bound sign-off that goes stale and is voided; a first year reads unavailable', () => {
  const w = world('validation');
  const run = start(w);
  assert.equal(item(run, 'balance_equation').status, 'done', 'a balanced book passes');
  assert.equal(item(run, 'balance_equation').validationResult.result, 'pass');
  assert.equal(item(run, 'open_items_reconciled').status, 'done');
  const first = item(run, 'prior_year_check');
  assert.equal(first.validationResult.result, 'unavailable');
  assert.equal(first.validationResult.reason, 'first_year');
  assert.equal(first.status, 'open');
  refuse(complete(w, run.runId, 'prior_year_check', { kind: 'signoff', ref: 'x' }), 'check_not_passed', 'an unavailable warn cannot be acknowledged');
  const cap = item(run, 'capital_loss_check');
  assert.equal(cap.validationResult.reason, 'no_capital');

  // A receivable posted without an open item: 1100 disagrees with the OP-Liste, the block fails.
  post(w, { date: '2026-06-10', debit: '1100', credit: '3200', amount: 1000000, tag: 'recv' });
  let view = get(w, run.runId);
  const oi = item(view, 'open_items_reconciled');
  assert.equal(oi.status, 'open');
  assert.equal(oi.validationResult.result, 'fail');
  assert.equal(oi.validationResult.figures.differenceMinor, -1000000);
  assert.equal(oi.validationResult.formula, 'checklists.validation.open_items_debtors.formula');
  refuse(complete(w, run.runId, 'open_items_reconciled', { kind: 'signoff', ref: 'ignore' }), 'check_not_passed', 'a block is never acknowledged');
  assert.equal(item(view, 'statements_signed').blockedBy, 'open_items_reconciled');
  refuse(complete(w, run.runId, 'statements_signed', { kind: 'statements_signoff' }), 'prerequisite_open', 'held by the block');
  post(w, { date: '2026-06-11', debit: '3200', credit: '1100', amount: 1000000, tag: 'fix' });
  view = get(w, run.runId);
  assert.equal(item(view, 'open_items_reconciled').status, 'done');

  // Capital 100'000, a 60'000 loss: equity 40'000 is below half of the capital, the warn fails.
  post(w, { date: '2026-01-10', debit: '1020', credit: '2800', amount: 10000000, tag: 'cap' });
  post(w, { date: '2026-06-05', debit: '6500', credit: '1020', amount: 6000000, tag: 'loss' });
  view = get(w, run.runId);
  let cl = item(view, 'capital_loss_check');
  assert.equal(cl.validationResult.result, 'fail');
  assert.equal(cl.validationResult.figures.equityMinor, 4000000);
  assert.equal(cl.validationResult.figures.thresholdMinor, 5000000);
  assert.equal(cl.status, 'open');
  refuse(complete(w, run.runId, 'capital_loss_check', { kind: 'signoff' }), 'acknowledge_needs_reason', 'a warn needs a reason');
  const ack = must(complete(w, run.runId, 'capital_loss_check', { kind: 'signoff', ref: 'Kapitalerhöhung im Juli beschlossen' }), 'acknowledge');
  assert.equal(ack.item.status, 'done');
  assert.equal(ack.item.signoff.kind, 'validation_acknowledged');
  assert.equal(ack.item.signoff.hash, cl.validationResult.hash);
  assert.equal(ack.item.signoff.evidenceRef, 'Kapitalerhöhung im Juli beschlossen');
  // The figures move: the acknowledgement is stale, the row open again, and re-acknowledging voids it.
  post(w, { date: '2026-06-06', debit: '6500', credit: '1020', amount: 500000, tag: 'loss2' });
  view = get(w, run.runId);
  cl = item(view, 'capital_loss_check');
  assert.equal(cl.status, 'open');
  assert.equal(cl.stale, true);
  assert.equal(cl.signoff.stale, true);
  const again = must(complete(w, run.runId, 'capital_loss_check', { kind: 'signoff', ref: 'geprüft, Sanierung läuft' }), 'acknowledge again');
  assert.equal(again.item.status, 'done');
  const voided = w.deps.store.db.prepare('SELECT void_reason FROM checklist_signoff WHERE id = ?').get(ack.signoffId);
  assert.equal(voided.void_reason, 'hash_changed');
  const rows = w.deps.store.db.prepare(`SELECT COUNT(*) AS n FROM checklist_signoff WHERE run_id = ? AND kind = 'validation_acknowledged'`).get(run.runId);
  assert.equal(rows.n, 2, 'append-only: two rows, one voided');
});

test('prior_year_comparison reads through the seal: a sealed prior year compares against its real figures, and sealing the current year moves neither the result nor the hash', () => {
  const w = world('pyc-seal');
  const fy2026 = { label: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31' };
  post(w, { date: '2025-06-10', debit: '1020', credit: '3200', amount: 10000000, tag: 'rev25' });
  post(w, { date: '2026-03-10', debit: '1020', credit: '3200', amount: 12000000, tag: 'rev26' });
  must(w.call('close_year', { year: '2025', idempotencyKey: key('seal25') }), 'seal 2025');
  const closeRows = w.deps.store.db.prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'close'`).get(w.wid);
  assert.equal(closeRows.n, 2, 'the seal posted its P&L sweep and the 2979 carry, both source close');
  const sealedPrior = chk.evaluateValidation(w.ctx, 'prior_year_comparison', fy2026);
  assert.equal(sealedPrior.result, 'pass', `a sealed prior year is not a first year: ${JSON.stringify(sealedPrior)}`);
  assert.deepEqual(
    sealedPrior.figures.accounts.map((a) => [a.number, a.currentMinor, a.priorMinor]),
    [['3200', -12000000, -10000000]],
    'the comparison reads the real prior-year figures, not the zeroed post-close ones',
  );
  must(w.call('close_year', { year: '2026', idempotencyKey: key('seal26') }), 'seal 2026');
  const sealedCurrent = chk.evaluateValidation(w.ctx, 'prior_year_comparison', fy2026);
  assert.equal(sealedCurrent.result, 'pass', 'the current year seal flags nothing');
  assert.equal(sealedCurrent.hash, sealedPrior.hash, 'the acknowledgement hash does not move on the seal');
});

// --- The statements sign-off and the anchor ------------------------------------------------------

test('the statements sign-off binds the anchor: it moves on a posting inside the period, not on one after it, not on the seal entry, and a re-sign voids the stale one', () => {
  const w = world('anchor');
  const run = start(w);
  const before = statementsHashOf(w.ctx, '2026-06-01', '2026-06-30');
  assert.equal(run.anchorHash, before.hash);
  assert.deepEqual(before.payload.balance, []);
  const signed = must(complete(w, run.runId, 'statements_signed', { kind: 'statements_signoff' }), 'sign');
  assert.equal(signed.item.status, 'done');
  assert.equal(signed.item.signoff.kind, 'statements_signoff');
  assert.equal(signed.item.signoff.hash, before.hash);
  assert.equal(signed.item.evidence.ref, `statements:${before.hash}`);
  refuse(w.call('checklist_item_skip', { runId: run.runId, itemId: 'statements_signed', reason: 'x', idempotencyKey: key('sk') }), 'undeletable', 'the sign-off is not skippable');

  post(w, { date: '2026-07-05', debit: '1020', credit: '3200', amount: 5000, tag: 'after' });
  let view = get(w, run.runId);
  assert.equal(view.anchorHash, before.hash, 'a posting after the period end does not move the anchor');
  assert.equal(item(view, 'statements_signed').status, 'done');
  // The seal's own entry (source close, dated the period end) does not move it either.
  must(
    postEntry(w.ctx, {
      date: '2026-06-30',
      source: 'close',
      idempotencyKey: key('close'),
      lines: [
        { account: w.accId('3200'), debit: 5000 },
        { account: w.accId('2979'), credit: 5000 },
      ],
    }),
    'close entry',
  );
  view = get(w, run.runId);
  assert.equal(view.anchorHash, before.hash, 'the closing entry is excluded from the projection');

  post(w, { date: '2026-06-20', debit: '1020', credit: '3200', amount: 7000, tag: 'inside' });
  view = get(w, run.runId);
  assert.notEqual(view.anchorHash, before.hash, 'a posting inside the period moves the anchor');
  const st = item(view, 'statements_signed');
  assert.equal(st.status, 'open');
  assert.equal(st.stale, true);
  assert.equal(st.signoff.stale, true);
  const after = statementsHashOf(w.ctx, '2026-06-01', '2026-06-30');
  assert.deepEqual(after.payload.balance, [['1020', 7000], ['3200', -7000]]);
  assert.deepEqual(after.payload.income, [['3200', -7000]]);
  const resigned = must(complete(w, run.runId, 'statements_signed', { kind: 'statements_signoff' }), 're-sign');
  assert.equal(resigned.item.signoff.hash, after.hash);
  const voided = w.deps.store.db.prepare('SELECT void_reason FROM checklist_signoff WHERE id = ?').get(signed.signoffId);
  assert.equal(voided.void_reason, 'hash_changed');
});

// --- The GV attestation and choice_locked -------------------------------------------------------

test('gv_attestation: a date before the statements sign-off needs a reason (a warn, never a refusal), already_attested on a second, and the governing choice is then locked', () => {
  const w = world('gv');
  const run = start(w);
  refuse(complete(w, run.runId, 'gv_approved', { kind: 'gv_attestation', ref: '2026-07-10' }), 'prerequisite_open', 'waits on the sign-off');
  must(complete(w, run.runId, 'statements_signed', { kind: 'statements_signoff' }), 'sign');
  refuse(complete(w, run.runId, 'gv_approved', { kind: 'signoff', ref: '2026-07-10' }), 'evidence_required', 'wrong evidence kind');
  refuse(complete(w, run.runId, 'gv_approved', { kind: 'gv_attestation', ref: '10.07.2026' }), 'evidence_required', 'not an ISO day');
  const early = refuse(complete(w, run.runId, 'gv_approved', { kind: 'gv_attestation', ref: '2026-07-10' }), 'acknowledge_needs_reason', 'before the sign-off');
  assert.equal(early.statementsSignedAt, '2026-07-16');
  const gv = must(complete(w, run.runId, 'gv_approved', { kind: 'gv_attestation', ref: '2026-07-10', reason: 'GV fand vor der Migration statt' }), 'attest with reason');
  assert.equal(gv.warnedBeforeStatements, true);
  assert.equal(gv.item.status, 'done');
  assert.equal(gv.item.signoff.kind, 'gv_attestation');
  assert.equal(gv.item.signoff.evidenceRef, '2026-07-10:GV fand vor der Migration statt');
  assert.equal(gv.item.signoff.hash, run.anchorHash, 'bound to the anchor like every acknowledgement');
  refuse(complete(w, run.runId, 'gv_approved', { kind: 'gv_attestation', ref: '2026-07-12' }), 'already_attested', 'a second date');
  // The GV attestation stands, so the legal form that governs it is locked.
  const locked = refuse(complete(w, run.runId, 'legal_form', { kind: 'choice', ref: 'einzelfirma' }), 'choice_locked', 're-answer');
  assert.deepEqual(locked.lockedBy, ['gv_approved']);
  must(complete(w, run.runId, 'legal_form', { kind: 'choice', ref: 'gmbh' }), 'the same answer by a human is fine');
  refuse(w.call('checklist_item_reopen', { runId: run.runId, itemId: 'legal_form', idempotencyKey: key('rl') }), 'choice_locked', 'clearing the human answer is the same lock');
  // Reopen the attestation: the sign-off is voided, the choice is free again.
  const reopened = must(w.call('checklist_item_reopen', { runId: run.runId, itemId: 'gv_approved', idempotencyKey: key('rg') }), 'reopen gv');
  assert.ok(reopened.voidedSignoffId);
  must(complete(w, run.runId, 'legal_form', { kind: 'choice', ref: 'einzelfirma' }), 're-answer after the reopen');
  const view = get(w, run.runId);
  assert.equal(item(view, 'gv_approved').status, 'excluded');
  assert.equal(item(view, 'capital_loss_check').status, 'excluded');
});

test('gv_attestation: a stale attestation is refreshed by the same date and actor (the old one voided hash_changed), and a replay while it stands is alreadyDone', () => {
  const w = world('gv-refresh');
  const run = start(w);
  must(complete(w, run.runId, 'statements_signed', { kind: 'statements_signoff' }), 'sign');
  const gv = must(complete(w, run.runId, 'gv_approved', { kind: 'gv_attestation', ref: '2026-07-20' }), 'attest');
  assert.equal(gv.item.signoff.hash, run.anchorHash);
  const replay = must(complete(w, run.runId, 'gv_approved', { kind: 'gv_attestation', ref: '2026-07-20' }), 'replay');
  assert.equal(replay.alreadyDone, true, 'the same date while the attestation stands is a replay');
  // The anchor moves: the attestation is stale, and so is the statements sign-off it follows.
  post(w, { date: '2026-06-20', debit: '1020', credit: '3200', amount: 7000, tag: 'inside' });
  let view = get(w, run.runId);
  assert.equal(item(view, 'gv_approved').status, 'open');
  assert.equal(item(view, 'gv_approved').stale, true);
  must(complete(w, run.runId, 'statements_signed', { kind: 'statements_signoff' }), 're-sign');
  view = get(w, run.runId);
  const fresh = must(complete(w, run.runId, 'gv_approved', { kind: 'gv_attestation', ref: '2026-07-20' }), 're-attest the same date');
  assert.equal(fresh.alreadyDone, false, 'a stale attestation is refreshed, not replayed');
  assert.equal(fresh.item.status, 'done');
  assert.equal(fresh.item.stale, false);
  assert.equal(fresh.item.signoff.hash, view.anchorHash, 'bound to the moved anchor');
  assert.notEqual(fresh.signoffId, gv.signoffId);
  const voided = w.deps.store.db.prepare('SELECT void_reason FROM checklist_signoff WHERE id = ?').get(gv.signoffId);
  assert.equal(voided.void_reason, 'hash_changed');
  const rows = w.deps.store.db.prepare(`SELECT COUNT(*) AS n FROM checklist_signoff WHERE run_id = ? AND kind = 'gv_attestation'`).get(run.runId);
  assert.equal(rows.n, 2, 'append-only: two rows, one voided');
  // Another date on the refreshed attestation is still refused.
  refuse(complete(w, run.runId, 'gv_approved', { kind: 'gv_attestation', ref: '2026-07-21' }), 'already_attested', 'a second date');
});

// --- The month lock as a posting, and the run reaching done --------------------------------------

test('the month lock is a posting probed off A03, and the run reads done when every row is done, skipped or excluded', () => {
  const w = world('done');
  const run = start(w);
  must(complete(w, run.runId, 'accruals_needed', { kind: 'choice', ref: 'no' }), 'no accruals');
  must(complete(w, run.runId, 'statements_signed', { kind: 'statements_signoff' }), 'sign');
  must(complete(w, run.runId, 'gv_approved', { kind: 'gv_attestation', ref: '2026-07-20' }), 'gv');
  // The D127 attestation kind, unchanged: a date not before the prerequisite's completion.
  refuse(complete(w, run.runId, 'berichtigung_filed', { kind: 'filed_attestation', ref: '2026-07-01' }), 'attestation_before_export', 'before the sign-off');
  must(complete(w, run.runId, 'berichtigung_filed', { kind: 'filed_attestation', ref: '2026-07-16' }), 'berichtigung');
  must(complete(w, run.runId, 'depreciation_previewed', undefined), 'verb_result');
  must(w.call('checklist_item_skip', { runId: run.runId, itemId: 'prior_year_check', reason: 'Erstes Geschäftsjahr.', idempotencyKey: key('skip') }), 'skip first year');
  // Capital loss: no capital on the books reads unavailable and stays open; a skip settles it.
  must(w.call('checklist_item_skip', { runId: run.runId, itemId: 'capital_loss_check', reason: 'Kein Kapital erfasst.', idempotencyKey: key('skip2') }), 'skip capital');
  let view = get(w, run.runId);
  assert.equal(view.nextItemId, 'lock_on_month');
  assert.equal(item(view, 'lock_on_month').status, 'open');
  assert.equal(item(view, 'lock_on_month').verbInputValue, '2026-06');
  refuse(complete(w, run.runId, 'lock_on_month', undefined), 'check_item_live', 'the lock is the act');
  must(w.call('close_month', { period: '2026-06', idempotencyKey: key('lock') }), 'close month');
  view = get(w, run.runId);
  assert.equal(item(view, 'lock_on_month').status, 'done');
  assert.equal(item(view, 'lock_on_month').probeResult.found, true);
  assert.equal(view.status, 'done');
  assert.equal(view.openCount, 0);
  assert.equal(view.excludedCount, 6);
  const listed = must(w.call('checklist_list', { templateId: 'test_kinds' }), 'list');
  assert.equal(listed.runs[0].status, 'done');
  assert.equal(listed.runs[0].excludedCount, 6);
  // Reopen the month: the row flips back by derivation, the run is open again.
  must(w.call('reopen_month', { period: '2026-06', idempotencyKey: key('unlock') }), 'reopen month');
  view = get(w, run.runId);
  assert.equal(item(view, 'lock_on_month').status, 'open');
  assert.equal(view.status, 'open');
});

test('the December rule (spec §10.6): the last fiscal month refuses year_close_in_progress while a live year_close run covers the year; an existing run is returned, an abandoned year run lifts it', () => {
  const w = world('december');
  const yearRun = (label, periodStart, periodEnd, id) =>
    w.deps.store.db
      .prepare(
        `INSERT INTO checklist_run (id, workspace_id, template_id, period_label, period_start, period_end, status, created_by, created_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', 'studio', ?, ?)`,
      )
      .run(id, w.wid, 'year_close', label, periodStart, periodEnd, key('yr'), '2026-07-16T00:00:00.000Z');
  // November 2025 starts before the year run exists, December too: both return on their natural key later.
  must(w.call('checklist_start', { templateId: 'test_kinds', period: '2025-11', idempotencyKey: key('nov') }), 'november');
  yearRun('2025', '2025-01-01', '2025-12-31', 'chkrun-year-2025');
  const refused = refuse(w.call('checklist_start', { templateId: 'test_kinds', period: '2025-12', idempotencyKey: key('dec') }), 'year_close_in_progress', 'december under a year run');
  assert.deepEqual({ period: refused.period, fiscalYear: refused.fiscalYear, yearRunId: refused.yearRunId }, { period: '2025-12', fiscalYear: '2025', yearRunId: 'chkrun-year-2025' });
  assert.equal(must(w.call('checklist_start', { templateId: 'test_kinds', period: '2025-11', idempotencyKey: key('nov2') }), 'november again').created, false, 'only the last month is covered');
  must(w.call('checklist_start', { templateId: 'test_kinds', period: '2026-01', idempotencyKey: key('jan') }), 'the next year is free');
  // An abandoned year run no longer covers December.
  w.deps.store.db.prepare(`UPDATE checklist_run SET status = 'abandoned' WHERE id = ?`).run('chkrun-year-2025');
  const dec = must(w.call('checklist_start', { templateId: 'test_kinds', period: '2025-12', idempotencyKey: key('dec2') }), 'december after the abandon');
  assert.equal(dec.created, true);
  // A live year run AFTER the December run exists (the natural key is unique, so the row is revived):
  // the existing December run is returned, never refused.
  w.deps.store.db.prepare(`UPDATE checklist_run SET status = 'open' WHERE id = ?`).run('chkrun-year-2025');
  assert.equal(must(w.call('checklist_start', { templateId: 'test_kinds', period: '2025-12', idempotencyKey: key('dec3') }), 'december exists').created, false);
  // The fiscal year 04-01: March 2026 is the last month of fiscal 2025.
  w.deps.store.db.prepare(`UPDATE workspace SET fiscal_year_start = '04-01' WHERE id = ?`).run(w.wid);
  refuse(w.call('checklist_start', { templateId: 'test_kinds', period: '2026-03', idempotencyKey: key('mar') }), 'year_close_in_progress', 'march under a 04-01 year');
  must(w.call('checklist_start', { templateId: 'test_kinds', period: '2026-02', idempotencyKey: key('feb') }), 'february is not the last month');
  assert.equal(chk.YEAR_CLOSE_TEMPLATE_ID, 'year_close', 'the rule keys on the year_close template id, exported for N4');
});

// --- Period kinds and deadlines ------------------------------------------------------------------

test('period kinds: year resolves the fiscal year label and bounds, refuses period_not_ended and year_already_closed; month picks the last ended month', () => {
  const w = world('periods');
  const y = must(resolveChecklistPeriod(w.ctx, 'year'), 'last ended year');
  assert.deepEqual({ label: y.label, periodStart: y.periodStart, periodEnd: y.periodEnd }, { label: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' });
  refuse(resolveChecklistPeriod(w.ctx, 'year', '2026'), 'period_not_ended', 'the running year');
  refuse(resolveChecklistPeriod(w.ctx, 'year', '25'), 'invalid_period', 'bad label');
  const m = must(resolveChecklistPeriod(w.ctx, 'month'), 'last ended month');
  assert.equal(m.label, '2026-06');
  // The month shape is the ledger's: a two-digit tail is not enough.
  refuse(resolveChecklistPeriod(w.ctx, 'month', '2026-00'), 'invalid_period', 'month 00');
  refuse(resolveChecklistPeriod(w.ctx, 'month', '2026-13'), 'invalid_period', 'month 13');
  refuse(pickChecklistPeriod(() => ({ ok: false, error: 'never_called' }), '2026-07-16', '2026-00', 'month'), 'invalid_period', 'pick month 00');
  refuse(pickChecklistPeriod(() => ({ ok: false, error: 'never_called' }), '2026-07-16', '2026-13', 'month'), 'invalid_period', 'pick month 13');
  w.deps.store.db.prepare(`UPDATE workspace SET fiscal_year_start = '04-01' WHERE id = ?`).run(w.wid);
  const fy = must(resolveChecklistPeriod(w.ctx, 'year', '2025'), 'fiscal 2025');
  assert.deepEqual({ periodStart: fy.periodStart, periodEnd: fy.periodEnd }, { periodStart: '2025-04-01', periodEnd: '2026-03-31' });
  const last = must(resolveChecklistPeriod(w.ctx, 'year'), 'last ended fiscal year');
  assert.equal(last.label, '2025', 'today (2026-07-16) falls in fiscal 2026, so 2025 is the last ended');
  w.deps.store.db
    .prepare(`INSERT INTO period_lock (workspace_id, period, kind, locked_at, locked_by, reason) VALUES (?, '2025', 'hard', ?, 'studio', 'year_close')`)
    .run(w.wid, '2026-07-16T00:00:00.000Z');
  refuse(resolveChecklistPeriod(w.ctx, 'year', '2025'), 'year_already_closed', 'sealed');
  refuse(resolveChecklistPeriod(w.ctx, 'year'), 'year_already_closed', 'sealed, picked');
  // The prompt's picker resolves the same way without a store.
  const pm = must(pickChecklistPeriod(() => ({ ok: false, error: 'never_called' }), '2026-07-16', undefined, 'month'), 'pick month');
  assert.equal(pm.label, '2026-06');
  const py = must(pickChecklistPeriod(() => ({ ok: false, error: 'never_called' }), '2026-07-16', undefined, 'year', '04-01'), 'pick year');
  assert.deepEqual({ label: py.label, periodEnd: py.periodEnd }, { label: '2025', periodEnd: '2026-03-31' });
  refuse(pickChecklistPeriod(() => ({ ok: false, error: 'never_called' }), '2026-07-16', '2026-07', 'month'), 'period_not_ended', 'pick running month');
});

test('deadlines: on a year the 180 / 240 day rules and the GV six months on resolve from the fiscal year end; on a month and a MWST period they stay null', () => {
  const items = [
    { itemId: 'u', title: 'u', ownerKind: 'human', evidenceKind: 'signoff', deadlineRule: 'umsatzabstimmung_180' },
    { itemId: 'b', title: 'b', ownerKind: 'human', evidenceKind: 'signoff', deadlineRule: 'berichtigung_240' },
    { itemId: 'g', title: 'g', ownerKind: 'human', evidenceKind: 'signoff', deadlineRule: 'gv_6_months' },
    { itemId: 'f', title: 'f', ownerKind: 'human', evidenceKind: 'signoff', deadlineRule: 'vat_filing_60' },
  ];
  const year = resolveDueDates(items, '2026-03-31', 'year');
  assert.equal(year.get('u'), '2026-09-27');
  assert.equal(year.get('b'), '2026-11-26');
  assert.equal(year.get('g'), '2026-09-30');
  assert.equal(year.get('f'), null, 'the MWST filing rule is not a year rule');
  const calendar = resolveDueDates(items, '2026-12-31', 'year');
  assert.equal(calendar.get('g'), '2027-06-30', 'six months on from 31.12. is 30.06., clamped');
  assert.equal(calendar.get('u'), '2027-06-29');
  const month = resolveDueDates(items, '2026-06-30', 'month');
  for (const id of ['u', 'b', 'g', 'f']) assert.equal(month.get(id), null, `${id} null on a month`);
  const vat = resolveDueDates(items, '2026-06-30');
  assert.equal(vat.get('f'), '2026-08-29');
  assert.equal(vat.get('g'), null);
  assert.equal(DEADLINE_DAYS_AFTER_PERIOD_END.vat_filing_60.vat_period, 60);
  assert.equal(DEADLINE_DAYS_AFTER_PERIOD_END.vat_payment_60.vat_period, 60);
  assert.equal(addMonths('2026-08-31', 6), '2027-02-28');
});

// --- Auto-start: the seed, the disabled rule, the tick, template_not_automatable ------------------

test('auto-start: the seed inserts the two rules once, a disabled rule is never re-enabled, and the daily tick starts each period exactly once', () => {
  const w = world('seed');
  must(w.call('vat_seed_defaults', {}), 'seed vat');
  must(w.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
  const RULES = 'SELECT id, enabled, trigger_event, action_tool, action_input FROM automation_rule WHERE workspace_id = ? ORDER BY id';
  // Since N4 the seed runs at workspace creation; the explicit call is the idempotent no-op it always was.
  const monthRuleId = checklistAutostartRuleId(w.wid, 'month_close');
  const vatRuleId = checklistAutostartRuleId(w.wid, 'vat_period');
  assert.deepEqual(w.deps.store.db.prepare(RULES).all(w.wid).map((r) => r.id), [monthRuleId, vatRuleId], 'seeded at creation, the ids carry the workspace');
  const first = seedDefaultChecklistRules(w.ctx);
  assert.deepEqual(first.seeded, [], 'a second seed inserts nothing');
  const rows = w.deps.store.db.prepare(RULES).all(w.wid);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.enabled, 1);
    assert.equal(r.trigger_event, 'schedule.daily');
    assert.equal(r.action_tool, 'checklist_start');
  }
  assert.deepEqual(JSON.parse(rows.find((r) => r.id === vatRuleId).action_input), { templateId: 'vat_period' });
  must(w.call('disable_automation_rule', { ruleId: monthRuleId }), 'disable');
  assert.deepEqual(seedDefaultChecklistRules(w.ctx).seeded, []);
  const disabled = w.deps.store.db.prepare('SELECT enabled FROM automation_rule WHERE workspace_id = ? AND id = ?').get(w.wid, monthRuleId);
  assert.equal(disabled.enabled, 0, 'the seed never re-enables a rule the owner disabled');

  // The tick: the vat_period rule fires checklist_start with no period, which picks 2026-Q2 and is
  // idempotent on the natural key, so a second day starts nothing new. The tick refuses an `asOf`
  // ahead of the clock, so the clock walks forward one day per tick.
  let today = '2026-07-16T03:00:00.000Z';
  w.deps.clock = { now: () => today };
  const runsOf = () => must(w.call('checklist_list', { templateId: 'vat_period' }), 'list').runs;
  assert.equal(runsOf().length, 0);
  must(w.call('run_due_automations', { asOf: today }), 'tick 1');
  const afterFirst = runsOf();
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0].periodLabel, '2026-Q2');
  today = '2026-07-17T03:00:00.000Z';
  must(w.call('run_due_automations', { asOf: today }), 'tick 2');
  today = '2026-07-18T03:00:00.000Z';
  must(w.call('run_due_automations', { asOf: today }), 'tick 3');
  assert.equal(runsOf().length, 1, 'three ticks, one run');
  const fired = w.deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM automation_run WHERE workspace_id = ? AND rule_id = ?')
    .get(w.wid, vatRuleId);
  assert.equal(fired.n, 3, 'the rule fired each day; the verb answered created:false');
  const monthFired = w.deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM automation_run WHERE workspace_id = ? AND rule_id = ?')
    .get(w.wid, monthRuleId);
  assert.equal(monthFired.n, 0, 'the disabled rule never fired');
});

test('template_not_automatable: a rule naming checklist_start with year_close is refused at definition and at patch; the denylist pair agrees with the checklists module', () => {
  const w = world('deny');
  assert.equal(TEMPLATE_NOT_AUTOMATABLE_CODE, 'template_not_automatable');
  assert.deepEqual([...NOT_AUTOMATABLE_INPUTS.checklist_start.templateId].sort(), [...NOT_AUTOMATABLE_TEMPLATE_IDS].sort());
  assert.deepEqual(notAutomatableInput('checklist_start', { templateId: 'year_close' }), { field: 'templateId', value: 'year_close' });
  assert.equal(notAutomatableInput('checklist_start', { templateId: 'vat_period' }), undefined);
  assert.equal(notAutomatableInput('post_entry', { templateId: 'year_close' }), undefined);
  const denied = refuse(
    w.call('create_automation_rule', {
      name: 'Jahresabschluss automatisch',
      trigger: { event: 'schedule.daily' },
      action: { tool: 'checklist_start', inputTemplate: { templateId: 'year_close' } },
      idempotencyKey: key('deny'),
    }),
    'template_not_automatable',
    'year_close rule',
  );
  assert.equal(denied.field, 'templateId');
  assert.equal(denied.value, 'year_close');
  const okRule = must(
    w.call('create_automation_rule', {
      name: 'MWST-Periode automatisch',
      trigger: { event: 'schedule.daily' },
      action: { tool: 'checklist_start', inputTemplate: { templateId: 'vat_period' } },
      idempotencyKey: key('ok'),
    }),
    'vat_period rule',
  );
  refuse(
    w.call('update_automation_rule', { ruleId: okRule.rule.ruleId, patch: { action: { tool: 'checklist_start', inputTemplate: { templateId: 'year_close' } } }, idempotencyKey: key('patch') }),
    'template_not_automatable',
    'patched to year_close',
  );
  assert.equal(w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM automation_rule WHERE workspace_id = ? AND action_input LIKE ?').get(w.wid, '%year_close%').n, 0, 'no such row was ever stored');
});

// --- The prompt --------------------------------------------------------------------------------

test('the prompt renders one line shape per kind over the same derivation checklist_get returns, in order', () => {
  // No legal form on file, so the derived choice stays OPEN and renders its line (an answered
  // choice is done and, like every done row, leaves the open list).
  const w = world('prompt', { legalForm: null });
  const run = start(w);
  must(complete(w, run.runId, 'has_assets', { kind: 'choice', ref: 'yes' }), 'assets');
  must(complete(w, run.runId, 'accruals_needed', { kind: 'choice', ref: 'yes' }), 'accruals');
  must(complete(w, run.runId, 'depreciation_preview', undefined), 'preview done, so its posting line renders');
  must(complete(w, run.runId, 'statements_signed', { kind: 'statements_signoff' }), 'signed, so the GV line renders');
  const rendered = must(renderChecklistPrompt(w.ctx, { templateId: 'test_kinds' }), 'prompt');
  assert.equal(rendered.runId, run.runId, 'no period given: the last ended month, the run exists');
  const view = get(w, run.runId);
  assert.deepEqual(rendered.openItemIds, view.items.filter((i) => i.status === 'open').map((i) => i.itemId));
  const text = rendered.text;
  assert.match(text, /Rechtsform \(itemId legal_form\): a bounded choice, options einzelfirma \| gmbh \| ag\. No answer yet\. Answer with checklist_item_complete .*evidence: \{kind: "choice", ref: <optionId>\}/);
  assert.match(text, /read accrual_list \{workspaceId: "[^"]+", periodEnd: "2026-06-30"\}, review it, then checklist_item_complete/);
  assert.doesNotMatch(text, /The read refuses/);
  assert.match(text, /post through asset_depreciation_run_post \{workspaceId: "[^"]+", lastMonth: "2026-06", idempotencyKey\} under that verb's own gate; the row flips by derivation when the probe depreciation_charged finds the artefact\. Nobody completes it by hand\. Reverse with asset_depreciation_run_reverse/);
  assert.match(text, /Abgrenzungen gebucht \(itemId accruals_posted, due 2026-07-10\): waits on accruals_preview/);
  assert.match(text, /validation prior_year_comparison \(formula checklists\.validation\.prior_year_comparison\.formula\), result unavailable \(first_year\), a warning that does not block the close\. Figures: \{"prior".*Acknowledge with checklist_item_complete/);
  assert.match(text, /Kein Kapitalverlust \(itemId capital_loss_check\): waits on legal_form/);
  assert.match(text, /Generalversammlung approves the statements \(outside TILL\), then checklist_item_complete .*evidence: \{kind: "gv_attestation", ref: "YYYY-MM-DD"\}.*DRAFTED as a Vorschlag/);
  assert.match(text, /a human files the exported file in the ESTV ePortal .*evidence: \{kind: "filed_attestation", ref: "YYYY-MM-DD"\}/);
  assert.match(text, /Monat abschliessen \(itemId lock_on_month, due 2026-07-10\): post through close_month \{workspaceId: "[^"]+", period: "2026-06", idempotencyKey\}.*Reverse with reopen_month/);
  assert.match(text, /Excluded by a choice: 2\./);
  assert.doesNotMatch(text, /statements_signed, due/, 'a done row is not an open line');
  // The statements line, on a run where it is still open.
  const w2 = world('prompt-open');
  const r2 = start(w2);
  const t2 = must(renderChecklistPrompt(w2.ctx, { templateId: 'test_kinds' }), 'prompt 2').text;
  assert.match(t2, /the owner releases the Bilanz and Erfolgsrechnung through checklist_item_complete .*evidence: \{kind: "statements_signoff"\}.*bound to the statements hash [0-9a-f]{64}\. Under the agent seat .*DRAFTED as a Vorschlag/);
  assert.match(t2, new RegExp(`the next actionable one is accruals_needed`));
  assert.match(t2, /a bounded choice, options yes \| no\. Pre-selected: no \(not an answer until saved\)\./);
  assert.ok(r2.runId);
  refuse(renderChecklistPrompt(w.ctx, { templateId: 'test_kinds', period: '2026-07' }), 'period_not_ended', 'prompt for the running month');
  const none = must(renderChecklistPrompt(w.ctx, { templateId: 'test_kinds', period: '2026-05' }), 'no run');
  assert.equal(none.runId, null);
  assert.match(none.text, /Start one with checklist_start \{workspaceId: "[^"]+", templateId: "test_kinds", period: "2026-05"/);
});
