/**
 * G22 leg 2 (D129), the `year_close` template as shipped data (spec §10.5, §10.13): the Nomadik-shaped
 * FY 2026 walked from start to seal with every kind exercised through the REAL verbs, the seal
 * refusing while blocked and refusing the hand, the statements hash moving on a posting and voiding
 * the sign-off, `choice_locked`, `excluded` never stored, the typed bank balance (Q7), the `04-01`
 * fiscal year's labels and deadlines, the Einzelfirma exclusions and the overrule, the Saldo branch,
 * the no-MWST branch, the template's own shape (every prerequisite and inclusion names a real row,
 * the three undeletable rows, no automation).
 *
 * THE ORDER OF THE WALK IS THE PRODUCT'S ORDER. The `vat_filed` hard lock refuses every entry dated
 * inside a filed quarter except the settlement (A38 §4.6), so the closing entries dated 31.12.
 * (Abgrenzungen, Rückstellungen, the Steuerrückstellung) are posted BEFORE Q4 is filed, and the
 * settlement after; the template's prerequisites follow that order (the tax provision waits on the
 * accruals and the provisions, not on the settlement).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { getAction } = await import('../../dist/api/registry.js');
const { makeContext } = await import('../../dist/core/context.js');
const { ledgerPorts } = await import('../../dist/core/ledger/index.js');
const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
const { fixedClock } = await import('../../dist/core/clock.js');
const { sequenceIdGen } = await import('../../dist/core/ids.js');
const { notAutomatableInput } = await import('../../dist/core/automation/denylist.js');
const chk = await import('../../dist/core/checklists/index.js');

const {
  YEAR_CLOSE_TEMPLATE,
  YEAR_CLOSE_BLOCK_VALIDATIONS,
  YEAR_CLOSE_POSTINGS_BEFORE_SIGNOFF,
  CHECKLIST_TEMPLATES,
  CHECKLIST_EVIDENCE_KINDS,
  CHECKLIST_PROBE_KEYS,
  CHECKLIST_VALIDATION_KEYS,
  CHECKLIST_CHECK_KEYS,
  VERB_EVIDENCE,
  resolveDueDates,
  resolveChecklistPeriod,
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
const key = (tag) => `yc-${tag}-${(seq += 1)}`;

/** A workspace at a clock AFTER the fiscal year ended (15.02.2027), so FY 2026 is the last ended year. */
function world(seed, { legalForm = 'gmbh', at = '2027-02-15T09:00:00.000Z', fiscalYearStart } = {}) {
  const store = new SqliteStore({ clock: fixedClock(at) });
  const deps = { store, clock: fixedClock(at), ids: sequenceIdGen(), actor: 'studio' };
  const created = must(getAction('create_workspace').run(deps, { name: 'Nomadik GmbH', idempotencyKey: `${seed}-ws`, ...(fiscalYearStart === undefined ? {} : { fiscalYearStart }) }), 'create');
  const workspaceId = created.workspaceId;
  if (legalForm !== null) store.db.prepare('UPDATE workspace SET legal_form = ? WHERE id = ?').run(legalForm, workspaceId);
  const accId = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const ctx = makeContext(store, { workspaceId, actor: 'studio', clock: deps.clock, ids: deps.ids, ...ledgerPorts({ store, workspaceId, ids: deps.ids }) });
  return { deps, wid: workspaceId, accId, call, ctx };
}

function start(w, period, tag = 'start') {
  const input = { templateId: 'year_close', idempotencyKey: key(tag) };
  if (period !== undefined) input.period = period;
  return must(w.call('checklist_start', input), 'start');
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
function skip(w, runId, itemId, reason) {
  return must(w.call('checklist_item_skip', { runId, itemId, reason, idempotencyKey: key('skip') }), `skip ${itemId}`);
}
function post(w, { date, lines, description = 'manual', source = 'manual', tag = 'p' }) {
  return must(w.call('post_entry', { date, source, description, idempotencyKey: key(tag), lines }), `post ${description}`);
}

function effektiv(w) {
  must(w.call('vat_seed_defaults', {}), 'seed');
  must(w.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
}

const QUARTERS = [
  { label: '2026-Q1', saleNet: 4_000_000, purchaseNet: 1_000_000, saleDate: '2026-02-10', purchaseDate: '2026-03-05' },
  { label: '2026-Q2', saleNet: 5_000_000, purchaseNet: 2_000_000, saleDate: '2026-05-15', purchaseDate: '2026-05-20' },
  { label: '2026-Q3', saleNet: 3_000_000, purchaseNet: 500_000, saleDate: '2026-08-12', purchaseDate: '2026-09-03' },
  { label: '2026-Q4', saleNet: 6_000_000, purchaseNet: 1_500_000, saleDate: '2026-11-11', purchaseDate: '2026-12-02' },
];

/** A year of taxable activity, every customer paid and every supplier paid inside the year, so the open items match the ledger. */
function nomadikYear(w) {
  post(w, { date: '2026-01-15', description: 'Einlage', lines: [{ account: w.accId('1020'), debit: 20_000_000 }, { account: w.accId('2800'), credit: 20_000_000 }] });
  for (const q of QUARTERS) {
    const gross = Math.round(q.saleNet * 1.081);
    post(w, {
      date: q.saleDate,
      description: 'Beratung',
      lines: [
        { account: w.accId('1100'), debit: gross },
        { account: w.accId('3200'), credit: q.saleNet, taxCode: 'UST81' },
        { account: w.accId('2200'), credit: Math.round(q.saleNet * 0.081) },
      ],
    });
    post(w, { date: q.saleDate, description: 'Zahlungseingang', lines: [{ account: w.accId('1020'), debit: gross }, { account: w.accId('1100'), credit: gross }] });
    const purchaseGross = Math.round(q.purchaseNet * 1.081);
    post(w, {
      date: q.purchaseDate,
      description: 'Material',
      lines: [
        { account: w.accId('4000'), debit: q.purchaseNet, taxCode: 'VST-M' },
        { account: w.accId('1170'), debit: Math.round(q.purchaseNet * 0.081) },
        { account: w.accId('2000'), credit: purchaseGross },
      ],
    });
    post(w, { date: q.purchaseDate, description: 'Zahlungsausgang', lines: [{ account: w.accId('2000'), debit: purchaseGross }, { account: w.accId('1020'), credit: purchaseGross }] });
  }
}

function bankBalance1020(w) {
  return w.deps.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor) - SUM(l.base_credit_minor), 0) AS net FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND a.number = '1020' AND e.date <= '2026-12-31'`,
    )
    .get(w.wid).net;
}

// --- The template's shape ------------------------------------------------------------------------

test('year_close ships: every row names a real kind, check, probe, validation, prerequisite and inclusion; three rows are undeletable; no rule may start it', () => {
  assert.deepEqual(CHECKLIST_TEMPLATES.map((t) => t.templateId), ['vat_period', 'month_close', 'year_close']);
  const t = YEAR_CLOSE_TEMPLATE;
  assert.equal(t.periodKind, 'year');
  assert.equal(t.anchor, 'statements');
  const ids = new Set(t.items.map((i) => i.itemId));
  assert.equal(ids.size, t.items.length, 'item ids are unique');
  const choices = new Map(t.items.filter((i) => i.evidenceKind === 'choice').map((i) => [i.itemId, i.options.map((o) => o.id)]));
  for (const i of t.items) {
    assert.ok(CHECKLIST_EVIDENCE_KINDS.includes(i.evidenceKind), `${i.itemId}: kind ${i.evidenceKind}`);
    assert.match(i.title, /[A-Za-zäöüÄÖÜ]/, `${i.itemId}: a title`);
    assert.doesNotMatch(i.title, /ß|\u2014/, `${i.itemId}: de-CH, no em dash`);
    if (i.check !== undefined) assert.ok(CHECKLIST_CHECK_KEYS.includes(i.check), `${i.itemId}: check ${i.check}`);
    if (i.probe !== undefined) assert.ok(CHECKLIST_PROBE_KEYS.includes(i.probe), `${i.itemId}: probe ${i.probe}`);
    if (i.validation !== undefined) assert.ok(CHECKLIST_VALIDATION_KEYS.includes(i.validation), `${i.itemId}: validation ${i.validation}`);
    if (i.evidenceKind === 'preview' || i.evidenceKind === 'verb_result') assert.ok(VERB_EVIDENCE[i.verb], `${i.itemId}: ${i.verb} binds evidence`);
    if (i.evidenceKind === 'posting') {
      assert.ok(i.probe, `${i.itemId}: a posting has a probe`);
      assert.ok(i.verb, `${i.itemId}: a posting names its verb`);
      if (i.itemId !== 'year_sealed') assert.ok(i.reverseVerb, `${i.itemId}: every posting before the seal has its undo`);
    }
    if (i.evidenceKind === 'validation') assert.ok(i.severity === 'block' || i.severity === 'warn', `${i.itemId}: severity`);
    for (const p of [...(i.prerequisiteItemIds ?? []), ...(i.prerequisiteItemId === undefined ? [] : [i.prerequisiteItemId]), ...(i.previewOf === undefined ? [] : [i.previewOf]), ...(i.dueLikeItemId === undefined ? [] : [i.dueLikeItemId])]) {
      assert.ok(ids.has(p), `${i.itemId}: prerequisite ${p} exists`);
    }
    if (i.includedWhen !== undefined) {
      const options = choices.get(i.includedWhen.itemId);
      assert.ok(options, `${i.itemId}: includedWhen names the choice ${i.includedWhen.itemId}`);
      for (const o of Array.isArray(i.includedWhen.optionId) ? i.includedWhen.optionId : [i.includedWhen.optionId]) assert.ok(options.includes(o), `${i.itemId}: option ${o} of ${i.includedWhen.itemId}`);
    }
  }
  assert.deepEqual(t.items.filter((i) => i.undeletable).map((i) => i.itemId), ['umsatzabstimmung', 'statements_signed', 'year_sealed']);
  const seal = t.items.find((i) => i.itemId === 'year_sealed');
  assert.equal(seal.verb, 'close_year');
  assert.equal(seal.reverseVerb, undefined, 'the seal has no undo (D129 Q1)');
  assert.equal(seal.deadlineRule, 'gv_6_months');
  for (const v of YEAR_CLOSE_BLOCK_VALIDATIONS) assert.ok(seal.prerequisiteItemIds.includes(v), `the seal waits on ${v}`);
  const signoff = t.items.find((i) => i.itemId === 'statements_signed');
  for (const p of [...YEAR_CLOSE_BLOCK_VALIDATIONS, ...YEAR_CLOSE_POSTINGS_BEFORE_SIGNOFF]) assert.ok(signoff.prerequisiteItemIds.includes(p), `the sign-off waits on ${p}`);
  assert.deepEqual(notAutomatableInput('checklist_start', { templateId: 'year_close' }), { field: 'templateId', value: 'year_close' });
  assert.equal(notAutomatableInput('checklist_start', { templateId: 'month_close' }), undefined);
});

test('due dates: statutory rules on the year end, the sign-off at + 150 days, rows 1 to 14 pacing on it, the exports at + 180', () => {
  const due = resolveDueDates(YEAR_CLOSE_TEMPLATE.items, '2026-12-31', 'year');
  assert.equal(due.get('statements_signed'), '2027-05-30');
  assert.equal(due.get('no_drafts'), '2027-05-30');
  assert.equal(due.get('balance_equation'), '2027-05-30');
  assert.equal(due.get('umsatzabstimmung'), '2027-06-29', '180 days (Art. 72 Abs. 1 MWSTG)');
  assert.equal(due.get('berichtigung_filed'), '2027-08-28', '240 days');
  assert.equal(due.get('gv_approved'), '2027-06-30', 'six months on (Art. 699 Abs. 2 OR)');
  assert.equal(due.get('year_sealed'), '2027-06-30');
  assert.equal(due.get('archive_exported'), '2027-06-29');
  assert.equal(due.get('legal_form'), null, 'a choice carries no date');
  // The 04-01 fiscal year: the same rules off 31.03.
  const fy = resolveDueDates(YEAR_CLOSE_TEMPLATE.items, '2027-03-31', 'year');
  assert.equal(fy.get('umsatzabstimmung'), '2027-09-27');
  assert.equal(fy.get('berichtigung_240'), undefined);
  assert.equal(fy.get('berichtigung_filed'), '2027-11-26');
  assert.equal(fy.get('gv_approved'), '2027-09-30');
  assert.equal(fy.get('statements_signed'), '2027-08-28');
});

test('a 04-01 fiscal year: the label is the year it starts in, the bounds run to 31.03., and the last ended year is picked by default', () => {
  const w = world('fy', { fiscalYearStart: '04-01', at: '2027-05-01T09:00:00.000Z' });
  const picked = must(resolveChecklistPeriod(w.ctx, 'year'), 'pick');
  assert.deepEqual({ label: picked.label, periodStart: picked.periodStart, periodEnd: picked.periodEnd }, { label: '2026', periodStart: '2026-04-01', periodEnd: '2027-03-31' });
  refuse(resolveChecklistPeriod(w.ctx, 'year', '2027'), 'period_not_ended', 'the running year');
  const run = start(w);
  assert.equal(run.periodLabel, '2026');
  assert.equal(run.periodEnd, '2027-03-31');
  assert.equal(item(run, 'gv_approved').dueAt, '2027-09-30');
  assert.equal(item(run, 'umsatzabstimmung').dueAt, '2027-09-27');
});

// --- The Nomadik walk -------------------------------------------------------------------------------

test('the FY 2026 walk: every kind exercised through the real verbs, the seal held until the blocks pass, the sign-off voided by a posting, the run done', () => {
  const w = world('walk');
  effektiv(w);
  nomadikYear(w);

  // Start with no period: the last ended fiscal year at 15.02.2027 is 2026.
  const run = start(w);
  assert.equal(run.created, true);
  assert.equal(run.periodLabel, '2026');
  assert.equal(run.createdBy, 'studio');
  assert.equal(run.itemCount, YEAR_CLOSE_TEMPLATE.items.length);
  const again = must(w.call('checklist_start', { templateId: 'year_close', period: '2026', idempotencyKey: key('again') }), 'start again');
  assert.equal(again.created, false);
  assert.equal(again.runId, run.runId);

  // The derived choices: a GmbH on effektiv, no FC positions, no assets.
  let v = get(w, run.runId);
  assert.deepEqual(item(v, 'legal_form').choice, { optionId: 'gmbh', source: 'derived' });
  assert.deepEqual(item(v, 'vat_method').choice, { optionId: 'effektiv', source: 'derived' });
  assert.deepEqual(item(v, 'has_fc_positions').choice, { optionId: 'no', source: 'derived' });
  assert.deepEqual(item(v, 'has_assets').choice, { optionId: 'no', source: 'derived' });
  for (const id of ['fx_preview', 'fx_posted', 'depreciation_preview', 'depreciation_posted', 'depreciation_within_limit']) {
    assert.equal(item(v, id).status, 'excluded', `${id} excluded by derivation`);
    assert.equal(item(v, id).storedStatus, 'open', 'excluded is never stored');
  }
  for (const id of ['tax_codes_complete', 'vat_settled', 'vat_accounts_zero', 'umsatzabstimmung', 'tax_provision_preview', 'gv_approved', 'capital_loss_check']) {
    assert.notEqual(item(v, id).status, 'excluded', `${id} included for a GmbH on effektiv`);
  }
  // The live checks pass on these books; the month locks and the bank are the open blocks.
  for (const id of ['no_drafts', 'bank_reconciled', 'tax_codes_complete']) assert.equal(item(v, id).status, 'done', id);
  assert.equal(item(v, 'month_closes_done').status, 'open');
  assert.equal(item(v, 'month_closes_done').validationResult.figures.missing.length, 11);
  assert.equal(item(v, 'open_items_debtors').status, 'done', 'every customer paid: 1100 reads zero and so do the open items');
  assert.equal(item(v, 'open_items_creditors').status, 'done');
  assert.equal(item(v, 'bank_balance_matches').status, 'open');
  assert.equal(item(v, 'bank_balance_matches').validationResult.reason, 'no_statement_no_typed_balance');
  assert.equal(item(v, 'balance_equation').status, 'done');
  // The seal: blocked, and never the hand's.
  assert.notEqual(item(v, 'year_sealed').blockedBy, null);
  refuse(complete(w, run.runId, 'year_sealed', undefined), 'check_item_live', 'the seal by hand');
  refuse(complete(w, run.runId, 'statements_signed', { kind: 'statements_signoff' }), 'prerequisite_open', 'sign-off while a block fails');

  // The months: close January to November; December is the year's own.
  for (let m = 1; m <= 11; m += 1) must(w.call('close_month', { period: `2026-${String(m).padStart(2, '0')}`, idempotencyKey: key('cm') }), `close 2026-${m}`);
  v = get(w, run.runId);
  assert.equal(item(v, 'month_closes_done').status, 'done');

  // The bank (Q7): no statement on file, so the typed figure on the sibling row decides.
  refuse(complete(w, run.runId, 'bank_balance_typed', { kind: 'signoff' }), 'evidence_required', 'the typed row needs the figure');
  const balance = bankBalance1020(w);
  must(complete(w, run.runId, 'bank_balance_typed', { kind: 'signoff', ref: `${(balance / 100).toFixed(2)}` }), 'type the balance');
  v = get(w, run.runId);
  assert.equal(item(v, 'bank_balance_matches').status, 'done');
  assert.equal(item(v, 'bank_balance_matches').validationResult.figures.source, 'typed');
  assert.equal(item(v, 'bank_balance_matches').validationResult.figures.typedMinor, balance);

  // Abgrenzungen: the human answers yes, the preview binds the draft list, the post flips the row,
  // the block validation on the reversal passes by construction, and the choice is then locked.
  must(complete(w, run.runId, 'accruals_needed', { kind: 'choice', ref: 'yes' }), 'accruals yes');
  const accrual = must(w.call('accrual_create', { kind: 'accrued_expense', periodEnd: '2026-12-31', amountMinor: 180_000, contraAccount: '6500', description: 'Strom Dezember', idempotencyKey: key('acc') }), 'accrual draft');
  const previewed = must(complete(w, run.runId, 'accruals_preview', undefined), 'accruals preview');
  assert.match(previewed.item.evidence.ref, /^accrual_list:[0-9a-f]{64}$/);
  must(w.call('accrual_post', { accrualId: accrual.accrual.id, idempotencyKey: key('accp') }), 'accrual post');
  v = get(w, run.runId);
  assert.equal(item(v, 'accruals_posted').status, 'done');
  assert.equal(item(v, 'accruals_posted').probeResult.reversalDate, '2027-01-01');
  assert.equal(item(v, 'accruals_preview').status, 'done', 'gebucht, siehe unten: the probe wins over the moved preview hash');
  assert.equal(item(v, 'accruals_reversed_next_year').status, 'done');
  const locked = refuse(complete(w, run.runId, 'accruals_needed', { kind: 'choice', ref: 'no' }), 'choice_locked', 'a governed posting stands');
  assert.deepEqual(locked.lockedBy, ['accruals_posted']);

  // Rückstellungen: the same pair.
  must(complete(w, run.runId, 'provisions_needed', { kind: 'choice', ref: 'yes' }), 'provisions yes');
  const provision = must(w.call('provision_create', { reason: 'garantie', periodEnd: '2026-12-31', amountMinor: 500_000, provisionAccount: '2330', expenseAccount: '6800', description: 'Garantiefälle 2026', idempotencyKey: key('prov') }), 'provision draft');
  must(complete(w, run.runId, 'provisions_preview', undefined), 'provisions preview');
  must(w.call('provision_post', { provisionId: provision.provision.id, idempotencyKey: key('provp') }), 'provision post');
  v = get(w, run.runId);
  assert.equal(item(v, 'provisions_posted').status, 'done');

  // The tax provision (a GmbH): the helper's preview, the steuern provision from its draft, plausible.
  assert.equal(item(v, 'tax_provision_preview').blockedBy, null, 'waits on the accruals and provisions only');
  const helper = must(w.call('tax_provision_preview', { periodEnd: '2026-12-31' }), 'helper');
  assert.ok(helper.proposedMinor > 0);
  must(complete(w, run.runId, 'tax_provision_preview', undefined), 'tax preview');
  const tax = must(w.call('provision_create', { ...helper.proposedDraft, idempotencyKey: key('tax') }), 'tax draft');
  must(w.call('provision_post', { provisionId: tax.provision.id, idempotencyKey: key('taxp') }), 'tax post');
  v = get(w, run.runId);
  assert.equal(item(v, 'tax_provision_posted').status, 'done');
  assert.equal(item(v, 'tax_provision_plausible').status, 'done');
  assert.equal(item(v, 'tax_provision_plausible').validationResult.result, 'pass');

  // MWST: file the four quarters (the Q4 filing hard-locks October to December, hence the order
  // above), settle each one through the row's verb, and the block validation reads zero.
  for (const q of QUARTERS) must(w.call('vat_mark_filed', { period: q.label, idempotencyKey: key('file') }), `file ${q.label}`);
  v = get(w, run.runId);
  assert.equal(item(v, 'vat_settled').status, 'open');
  assert.deepEqual(item(v, 'vat_settled').probeResult.detail.unsettledFiled, ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  assert.equal(item(v, 'vat_settled').verbInputValue, '2026');
  assert.equal(item(v, 'vat_accounts_zero').status, 'open');
  assert.equal(item(v, 'vat_accounts_zero').blockedBy, 'vat_settled');
  for (const q of QUARTERS) must(w.call('vat_settlement_post', { period: q.label, idempotencyKey: key('settle') }), `settle ${q.label}`);
  v = get(w, run.runId);
  assert.equal(item(v, 'vat_settled').status, 'done');
  assert.equal(item(v, 'vat_settled').probeResult.entryIds.length, 4);
  assert.equal(item(v, 'vat_accounts_zero').status, 'done');
  assert.equal(item(v, 'vat_declared_equals_books').status, 'done');
  assert.equal(item(v, 'umsatzabstimmung').status, 'done', 'a match passes (the engine marks a passing validation done)');
  assert.equal(item(v, 'berichtigung_filed').blockedBy, null);
  skip(w, run.runId, 'berichtigung_filed', 'keine Mängel festgestellt');

  // The warn rows a first year cannot answer are skipped with a reason, never faked.
  assert.equal(item(v, 'prior_year_comparison').validationResult.reason, 'first_year');
  skip(w, run.runId, 'prior_year_comparison', 'erstes Geschäftsjahr');
  assert.equal(item(v, 'capital_loss_check').validationResult.result, 'pass', 'the Einlage on 2800 is the capital');

  // The statements sign-off: bound to the hash, voided by a posting inside the year, re-signed.
  v = get(w, run.runId);
  assert.equal(item(v, 'statements_signed').blockedBy, null, JSON.stringify(v.items.filter((i) => i.status === 'open').map((i) => [i.itemId, i.blockedBy])));
  refuse(complete(w, run.runId, 'statements_signed', { kind: 'signoff' }), 'evidence_required', 'the governed spelling is required');
  const signed = must(complete(w, run.runId, 'statements_signed', { kind: 'statements_signoff' }), 'sign');
  assert.equal(signed.item.signoff.kind, 'statements_signoff');
  assert.equal(signed.item.signoff.hash, v.anchorHash);
  // Every month of 2026 is now hard-locked by the four filings, so nothing but the seal can move the
  // statements from here; the void-by-posting path is proven below on a year without MWST.

  // After the sign-off: the handover, the soft lock, the GV, the seal.
  const handover = must(complete(w, run.runId, 'treuhaender_handover', undefined), 'handover');
  assert.match(handover.item.evidence.ref, /^prepare_period:[0-9a-f]{64}$/);
  must(w.call('lock_period', { period: '2026', kind: 'soft', idempotencyKey: key('lock') }), 'soft lock');
  v = get(w, run.runId);
  assert.equal(item(v, 'soft_lock_on_year').status, 'done');
  assert.equal(item(v, 'year_sealed').blockedBy, 'gv_approved');
  refuse(complete(w, run.runId, 'gv_approved', { kind: 'gv_attestation', ref: '2027-02-10' }), 'acknowledge_needs_reason', 'a GV before the sign-off needs a reason');
  must(complete(w, run.runId, 'gv_approved', { kind: 'gv_attestation', ref: '2027-03-20' }), 'GV');
  v = get(w, run.runId);
  assert.equal(item(v, 'year_sealed').blockedBy, null);
  assert.equal(v.nextItemId, 'year_sealed');
  const sealed = must(w.call('close_year', { year: '2026', idempotencyKey: key('seal') }), 'close_year');
  assert.ok(sealed.closingEntryId);
  v = get(w, run.runId);
  assert.equal(item(v, 'year_sealed').status, 'done');
  assert.equal(item(v, 'statements_signed').status, 'done', 'the seal entry is excluded from the statements hash');
  assert.equal(item(v, 'statements_signed').stale, false);
  refuse(w.call('checklist_start', { templateId: 'year_close', period: '2026', idempotencyKey: key('sealed') }), 'year_already_closed', 'a sealed year is not started again');

  // The dossier, then the run is done and stays stored open.
  const exported = must(complete(w, run.runId, 'archive_exported', undefined), 'export statements');
  assert.match(exported.item.evidence.ref, /^export_statements:[0-9a-f]{64}$/);
  must(complete(w, run.runId, 'journal_exported', undefined), 'export journal');
  v = get(w, run.runId);
  assert.equal(v.status, 'done', JSON.stringify(v.items.filter((i) => i.status === 'open').map((i) => [i.itemId, i.blockedBy, i.validationResult?.reason])));
  assert.equal(v.openCount, 0);
  assert.ok(v.excludedCount >= 5);
  assert.equal(w.deps.store.db.prepare('SELECT status FROM checklist_run WHERE id = ?').get(run.runId).status, 'open', 'done is derived, never stored');
  assert.equal(w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM checklist_run_item WHERE run_id = ? AND status NOT IN ('open', 'done', 'skipped')").get(run.runId).n, 0, 'excluded is never stored');
});

// --- The branches -----------------------------------------------------------------------------------

test('an Einzelfirma: the tax provision, the Kapitalverlust check and the GV are excluded by derivation; the overrule re-includes them and the reopen returns the derived answer', () => {
  const w = world('einzel', { legalForm: 'einzelfirma' });
  const run = start(w);
  let v = get(w, run.runId);
  assert.deepEqual(item(v, 'legal_form').choice, { optionId: 'einzelfirma', source: 'derived' });
  for (const id of ['tax_provision_preview', 'tax_provision_posted', 'tax_provision_plausible', 'capital_loss_check', 'gv_approved']) {
    assert.equal(item(v, id).status, 'excluded', id);
    assert.deepEqual(item(v, id).excludedBy, { itemId: 'legal_form', optionId: 'einzelfirma' });
  }
  assert.ok(!item(v, 'year_sealed').prerequisiteItemIds.some((p) => item(v, p).status === 'excluded' && item(v, 'year_sealed').blockedBy === p), 'an excluded GV never blocks the seal');
  must(complete(w, run.runId, 'legal_form', { kind: 'choice', ref: 'ag' }), 'overrule to AG');
  v = get(w, run.runId);
  assert.deepEqual(item(v, 'legal_form').choice, { optionId: 'ag', source: 'human' });
  assert.equal(item(v, 'gv_approved').status, 'open', 'the AG is in the list form of includedWhen');
  assert.equal(item(v, 'capital_loss_check').status, 'open');
  // The tax helper still reads the PROFILE (einzelfirma: not applicable), so the preview is empty and
  // the pair folds as "nichts zu buchen", not as excluded by the choice.
  assert.equal(item(v, 'tax_provision_preview').status, 'excluded');
  assert.equal(item(v, 'tax_provision_preview').excludedBy, null);
  assert.equal(item(v, 'tax_provision_preview').previewResult.empty, true);
  must(w.call('checklist_item_reopen', { runId: run.runId, itemId: 'legal_form', idempotencyKey: key('ro') }), 'reopen');
  v = get(w, run.runId);
  assert.deepEqual(item(v, 'legal_form').choice, { optionId: 'einzelfirma', source: 'derived' });
  assert.equal(item(v, 'gv_approved').status, 'excluded');
});

test('the MWST branches: a Saldo workspace settles too (Q3), a workspace without MWST excludes the whole MWST block, a filed Saldo period settles through 3809', () => {
  const saldo = world('saldo');
  must(saldo.call('vat_seed_defaults', {}), 'seed');
  must(saldo.call('set_vat_method', { vatMethod: 'saldo', vatAccounting: 'soll', saldoRateBp: 600 }), 'saldo');
  let v = get(saldo, start(saldo).runId);
  assert.deepEqual(item(v, 'vat_method').choice, { optionId: 'saldo', source: 'derived' });
  for (const id of ['tax_codes_complete', 'vat_settled', 'vat_accounts_zero', 'vat_declared_equals_books', 'umsatzabstimmung', 'berichtigung_filed']) {
    assert.notEqual(item(v, id).status, 'excluded', `${id} included under Saldo`);
  }
  assert.equal(item(v, 'vat_settled').probeResult.detail.method, 'saldo');
  assert.deepEqual(item(v, 'vat_settled').probeResult.detail.periods.map((p) => p.label), ['2026-H1', '2026-H2']);

  const none = world('nomwst');
  v = get(none, start(none).runId);
  const method = item(v, 'vat_method').choice;
  assert.ok(method === null || method.optionId === 'none', `no MWST configuration derives none or leaves the choice open: ${JSON.stringify(method)}`);
  if (method === null) must(complete(none, v.runId, 'vat_method', { kind: 'choice', ref: 'none' }), 'answer none');
  v = get(none, v.runId);
  for (const id of ['tax_codes_complete', 'vat_settled', 'vat_accounts_zero', 'vat_declared_equals_books', 'umsatzabstimmung', 'berichtigung_filed']) {
    assert.equal(item(v, id).status, 'excluded', `${id} excluded without MWST`);
  }
});

test('the statements sign-off is voided by a posting inside the year and re-signed on the new hash (a year without MWST, so December stays open)', () => {
  const w = world('void');
  post(w, { date: '2026-01-15', description: 'Einlage', lines: [{ account: w.accId('1020'), debit: 5_000_000 }, { account: w.accId('2800'), credit: 5_000_000 }] });
  post(w, { date: '2026-06-10', description: 'Miete', lines: [{ account: w.accId('6000'), debit: 200_000 }, { account: w.accId('1020'), credit: 200_000 }] });
  for (let m = 1; m <= 11; m += 1) must(w.call('close_month', { period: `2026-${String(m).padStart(2, '0')}`, idempotencyKey: key('cm') }), `close 2026-${m}`);
  const run = start(w);
  let v = get(w, run.runId);
  if (item(v, 'vat_method').choice === null) must(complete(w, run.runId, 'vat_method', { kind: 'choice', ref: 'none' }), 'no MWST');
  must(complete(w, run.runId, 'accruals_needed', { kind: 'choice', ref: 'no' }), 'no accruals');
  must(complete(w, run.runId, 'provisions_needed', { kind: 'choice', ref: 'no' }), 'no provisions');
  must(complete(w, run.runId, 'bank_balance_typed', { kind: 'signoff', ref: `${(bankBalance1020(w) / 100).toFixed(2)}` }), 'type the balance');
  skip(w, run.runId, 'prior_year_comparison', 'erstes Geschäftsjahr');
  v = get(w, run.runId);
  assert.equal(item(v, 'tax_provision_preview').status, 'excluded', 'no profit: the helper proposes nothing');
  assert.equal(item(v, 'statements_signed').blockedBy, null, JSON.stringify(v.items.filter((i) => i.status === 'open').map((i) => [i.itemId, i.blockedBy])));
  const signed = must(complete(w, run.runId, 'statements_signed', { kind: 'statements_signoff' }), 'sign');
  assert.equal(signed.item.signoff.hash, v.anchorHash);
  post(w, { date: '2026-12-31', description: 'Nachtrag', lines: [{ account: w.accId('6500'), debit: 1_000 }, { account: w.accId('1020'), credit: 1_000 }] });
  v = get(w, run.runId);
  assert.equal(item(v, 'statements_signed').status, 'open');
  assert.equal(item(v, 'statements_signed').stale, true, 'Freigabe hinfällig');
  assert.equal(item(v, 'statements_signed').signoff.stale, true);
  // The Nachtrag moved the bank too: the typed figure no longer matches, and the block re-opens.
  assert.equal(item(v, 'bank_balance_matches').status, 'open');
  assert.equal(item(v, 'bank_balance_matches').validationResult.figures.differenceMinor, 1_000);
  // A typed figure is a live sign-off: a second complete is a replay, so the row is reopened first.
  assert.equal(complete(w, run.runId, 'bank_balance_typed', { kind: 'signoff', ref: '0.00' }).alreadyDone, true);
  must(w.call('checklist_item_reopen', { runId: run.runId, itemId: 'bank_balance_typed', idempotencyKey: key('ro') }), 'reopen the typed row');
  must(complete(w, run.runId, 'bank_balance_typed', { kind: 'signoff', ref: `${(bankBalance1020(w) / 100).toFixed(2)}` }), 'retype');
  const resigned = must(complete(w, run.runId, 'statements_signed', { kind: 'statements_signoff' }), 're-sign');
  assert.notEqual(resigned.item.signoff.hash, signed.item.signoff.hash);
  assert.equal(w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM checklist_signoff WHERE run_id = ? AND kind = 'statements_signoff' AND void_reason = 'hash_changed'").get(run.runId).n, 1);
  v = get(w, run.runId);
  assert.equal(item(v, 'statements_signed').status, 'done');
});
