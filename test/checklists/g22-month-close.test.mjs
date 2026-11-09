/**
 * G22 leg 2 (D129), the `month_close` template as shipped data (spec §10.6, §10.13): the A26 month-end
 * rows as template items with the A22 FX pair, the Abgrenzungen pair behind a pre-selected "Nein"
 * that is not an answer until saved, and the soft lock as a posting the ledger proves through
 * `close_month` and un-proves through `reopen_month`; the December rule (`year_close_in_progress`)
 * on the last fiscal month while a live `year_close` run exists, with an existing December run still
 * returned on its natural key; and the template's shape. The seeded auto-start rule is proven in
 * `g22-autostart.test.mjs` once the seed is wired into workspace creation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { getAction } = await import('../../dist/api/registry.js');
const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
const { fixedClock } = await import('../../dist/core/clock.js');
const { sequenceIdGen } = await import('../../dist/core/ids.js');
const { notAutomatableInput } = await import('../../dist/core/automation/denylist.js');
const chk = await import('../../dist/core/checklists/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');

const { MONTH_CLOSE_TEMPLATE, CHECKLIST_EVIDENCE_KINDS, VERB_EVIDENCE, resolveDueDates } = chk;

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
const key = (tag) => `mc-${tag}-${(seq += 1)}`;

/** The fixture clock (16.07.2026): 2026-06 is the last ended month. */
function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Monat GmbH', `${seed}-ws`);
  deps.store.db.prepare('UPDATE workspace SET legal_form = ? WHERE id = ?').run('gmbh', workspaceId);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, wid: workspaceId, accId, call };
}

/** A workspace at 15.02.2027, after FY 2026 ended (the December rule needs a live year run). */
function worldAfterYear(seed) {
  const at = '2027-02-15T09:00:00.000Z';
  const store = new SqliteStore({ clock: fixedClock(at) });
  const deps = { store, clock: fixedClock(at), ids: sequenceIdGen(), actor: 'studio' };
  const workspaceId = must(getAction('create_workspace').run(deps, { name: 'Dezember GmbH', idempotencyKey: `${seed}-ws` }), 'create').workspaceId;
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, wid: workspaceId, call };
}

const get = (w, runId) => must(w.call('checklist_get', { runId }), 'get');
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

test('month_close ships: the A26 rows, the FX pair, the Abgrenzungen pair with a pre-selected Nein, the soft lock; every row names real keys; a rule may start it', () => {
  const t = MONTH_CLOSE_TEMPLATE;
  assert.equal(t.periodKind, 'month');
  assert.equal(t.anchor, 'statements');
  assert.deepEqual(
    t.items.map((i) => i.itemId),
    ['vat_method', 'no_drafts', 'bank_reconciled', 'tax_codes_complete', 'open_items_debtors', 'open_items_creditors', 'has_fc_positions', 'fx_preview', 'fx_posted', 'accruals_needed', 'accruals_preview', 'accruals_posted', 'lock_on_month'],
  );
  const ids = new Set(t.items.map((i) => i.itemId));
  for (const i of t.items) {
    assert.ok(CHECKLIST_EVIDENCE_KINDS.includes(i.evidenceKind), `${i.itemId}: kind`);
    assert.doesNotMatch(i.title, /ß|\u2014/, `${i.itemId}: de-CH, no em dash`);
    if (i.evidenceKind === 'preview') assert.ok(VERB_EVIDENCE[i.verb], `${i.itemId}: ${i.verb} binds evidence`);
    if (i.evidenceKind === 'posting') assert.ok(i.probe && i.verb && i.reverseVerb, `${i.itemId}: verb, probe and undo`);
    for (const p of [...(i.prerequisiteItemIds ?? []), ...(i.prerequisiteItemId === undefined ? [] : [i.prerequisiteItemId]), ...(i.previewOf === undefined ? [] : [i.previewOf])]) assert.ok(ids.has(p), `${i.itemId}: prerequisite ${p}`);
    if (i.includedWhen !== undefined) assert.ok(ids.has(i.includedWhen.itemId), `${i.itemId}: includedWhen ${i.includedWhen.itemId}`);
  }
  assert.equal(t.items.find((i) => i.itemId === 'accruals_needed').defaultOptionId, 'no');
  assert.equal(t.items.find((i) => i.itemId === 'lock_on_month').reverseVerb, 'reopen_month');
  assert.equal(t.items.find((i) => i.itemId === 'open_items_debtors').severity, 'warn', 'a warning on a month, a block on the year');
  assert.equal(t.items.filter((i) => i.undeletable).length, 0);
  assert.equal(notAutomatableInput('checklist_start', { templateId: 'month_close' }), undefined, 'the seeded daily rule may start it');
  const due = resolveDueDates(t.items, '2026-06-30', 'month');
  assert.equal(due.get('lock_on_month'), '2026-07-10', 'ten days of pacing');
  assert.equal(due.get('vat_method'), null);
});

test('a June run: the derived rows, the pre-selected Nein stays open until saved, the lock flips through close_month and un-flips through reopen_month', () => {
  const w = world('june');
  must(w.call('vat_seed_defaults', {}), 'seed');
  must(w.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
  const run = must(w.call('checklist_start', { templateId: 'month_close', idempotencyKey: key('start') }), 'start without a period');
  assert.equal(run.periodLabel, '2026-06');
  assert.equal(run.periodEnd, '2026-06-30');
  let v = get(w, run.runId);
  assert.deepEqual(item(v, 'vat_method').choice, { optionId: 'effektiv', source: 'derived' });
  assert.equal(item(v, 'tax_codes_complete').status, 'done');
  assert.equal(item(v, 'fx_preview').status, 'excluded', 'no FC positions');
  assert.equal(item(v, 'accruals_needed').status, 'open', 'a pre-selected radio is not an answer');
  assert.equal(item(v, 'accruals_needed').defaultOptionId, 'no');
  assert.equal(item(v, 'accruals_preview').status, 'open', 'no answer yet: the pair is neither included nor excluded by derivation');
  assert.equal(v.nextItemId, 'accruals_needed', 'the warn validations pass on an empty book, so the choice is next');
  assert.equal(item(v, 'open_items_debtors').status, 'done');
  must(complete(w, run.runId, 'accruals_needed', { kind: 'choice', ref: 'no' }), 'save the Nein');
  v = get(w, run.runId);
  assert.equal(item(v, 'accruals_preview').status, 'excluded');
  assert.equal(item(v, 'accruals_posted').status, 'excluded');
  assert.equal(v.nextItemId, 'lock_on_month');
  refuse(complete(w, run.runId, 'lock_on_month', undefined), 'check_item_live', 'the lock by hand');
  must(w.call('close_month', { period: '2026-06', idempotencyKey: key('close') }), 'close_month');
  v = get(w, run.runId);
  assert.equal(item(v, 'lock_on_month').status, 'done');
  assert.equal(v.status, 'done');
  must(w.call('reopen_month', { period: '2026-06', idempotencyKey: key('reopen') }), 'reopen_month');
  v = get(w, run.runId);
  assert.equal(item(v, 'lock_on_month').status, 'open', 'the owner verb\'s undo re-opens the row by derivation');
  assert.equal(v.status, 'open');
  refuse(w.call('checklist_start', { templateId: 'month_close', period: '2026-07', idempotencyKey: key('running') }), 'period_not_ended', 'the running month');
  refuse(w.call('checklist_start', { templateId: 'month_close', period: '2026-6', idempotencyKey: key('bad') }), 'invalid_period', 'a malformed label');
});

test('the December rule: the last fiscal month is not started while a live year_close run exists; November is; an existing December run is returned, never refused', () => {
  const w = worldAfterYear('december');
  const nov = must(w.call('checklist_start', { templateId: 'month_close', period: '2026-11', idempotencyKey: key('nov') }), 'November');
  assert.equal(nov.created, true);
  const dec = must(w.call('checklist_start', { templateId: 'month_close', period: '2026-12', idempotencyKey: key('dec') }), 'December before the year run');
  assert.equal(dec.created, true);
  const year = must(w.call('checklist_start', { templateId: 'year_close', period: '2026', idempotencyKey: key('year') }), 'year run');
  const again = must(w.call('checklist_start', { templateId: 'month_close', period: '2026-12', idempotencyKey: key('dec2') }), 'an existing December run');
  assert.equal(again.created, false);
  assert.equal(again.runId, dec.runId);
  must(w.call('checklist_abandon', { runId: dec.runId, reason: 'Das Jahr deckt den Dezember.', idempotencyKey: key('ab') }), 'abandon December');
  const w2 = worldAfterYear('december-2');
  const y2 = must(w2.call('checklist_start', { templateId: 'year_close', period: '2026', idempotencyKey: key('y2') }), 'year run first');
  const refused = refuse(w2.call('checklist_start', { templateId: 'month_close', period: '2026-12', idempotencyKey: key('dec3') }), 'year_close_in_progress', 'December under a live year run');
  assert.equal(refused.fiscalYear, '2026');
  assert.equal(refused.yearRunId, y2.runId);
  assert.equal(must(w2.call('checklist_start', { templateId: 'month_close', period: '2026-11', idempotencyKey: key('nov2') }), 'November under the year run').created, true);
  must(w2.call('checklist_abandon', { runId: y2.runId, reason: 'Falsches Jahr.', idempotencyKey: key('ab2') }), 'abandon the year run');
  assert.equal(must(w2.call('checklist_start', { templateId: 'month_close', period: '2026-12', idempotencyKey: key('dec4') }), 'December after the abandon').created, true);
  assert.equal(year.periodLabel, '2026');
});
