/**
 * CRITIC R3 PROBES (critic/cl-periods-r3, 5632b6b4), ADOPTED AND ADAPTED to the rebuilt seal path (the
 * seal stays on `close_year`, NOT_AUTOMATABLE and dialed close-period by name; the run names itself with
 * `runId`; `checklist_item_complete` never seals). The walk below is the critic's copy of the FY 2026
 * walk in `g22-year-close.test.mjs`, used as the ready-to-seal fixture; the probes at the bottom assert
 * that no automation and no agent input shape can seal the year past the owner. Original header:
 *
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
const { runGoverned } = await import('../../dist/api/agent-gate.js');
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

function readyWorld() {
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
  // The seal: blocked, never the hand's; the bare close_year refuses over the open run, naming it.
  assert.notEqual(item(v, 'year_sealed').blockedBy, null);
  refuse(complete(w, run.runId, 'year_sealed', undefined), 'check_item_live', 'the seal by hand');
  assert.equal(refuse(w.call('close_year', { year: '2026', idempotencyKey: key('bare') }), 'year_close_in_progress', 'the bare seal over an open run').yearRunId, run.runId);
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
  return { w, run };
}

const sealOf = (w) => w.deps.store.db.prepare("SELECT reason FROM period_lock WHERE workspace_id = ? AND period = '2026' AND kind = 'hard'").get(w.wid);

const closeEntries = (w) => w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'close'").get(w.wid).n;

test('CRITIC R3 PROBE A (adapted): manage_checklists without manage_periods cannot seal, through the row or through close_year', () => {
  const { w, run } = readyWorld();
  const deny = { assert: (c) => (c === 'manage_periods' ? { ok: false, error: 'permission_denied', capability: c } : { ok: true }) };
  const ctx = makeContext(w.deps.store, { workspaceId: w.wid, actor: 'studio', clock: w.deps.clock, ids: w.deps.ids, ...ledgerPorts({ store: w.deps.store, workspaceId: w.wid, ids: w.deps.ids }), capabilities: deny });
  const row = chk.checklistItemComplete(ctx, { runId: run.runId, itemId: 'year_sealed', idempotencyKey: key('nomp') });
  assert.equal(row.ok, false, JSON.stringify(row));
  assert.equal(row.error, 'check_item_live', 'the checklist verb never seals');
  const viaVerb = chk.closeYearGuarded(ctx, { year: '2026', runId: run.runId, idempotencyKey: key('nomp2') });
  assert.equal(viaVerb.error, 'permission_denied');
  assert.equal(sealOf(w), undefined);
  assert.equal(closeEntries(w), 0);
});

test('CRITIC R3 PROBE B (control, adapted): the agent\'s run seal through close_year drafts under close-period', () => {
  const { w, run } = readyWorld();
  must(w.call('set_agent_dial', { capability: 'post', level: 'auto', idempotencyKey: key('dial') }), 'post auto');
  const res = runGoverned({ ...w.deps, actor: 'agent' }, getAction('close_year'), { workspaceId: w.wid, year: '2026', runId: run.runId, idempotencyKey: key('agent') });
  assert.equal(res.drafted, true, JSON.stringify(res).slice(0, 300));
  assert.equal(res.dialCapability, 'close-period');
  assert.equal(sealOf(w), undefined);
});

test('CRITIC R3 PROBE C (adapted): no agent input shape seals under close-period on ask', () => {
  const { w, run } = readyWorld();
  // The owner lets the agent post unattended (post = auto) and keeps close-period on ask.
  must(w.call('set_agent_dial', { capability: 'post', level: 'auto', idempotencyKey: key('dial') }), 'post auto');
  const agent = { ...w.deps, actor: 'agent' };
  const shapes = [
    ['close_year', { year: '2026', runId: run.runId, evidence: { kind: 'statements_signoff' } }],
    ['close_year', { year: '2026', runId: run.runId, itemId: 'year_sealed' }],
    ['close_year', { year: '2026' }],
    ['checklist_item_complete', { runId: run.runId, itemId: 'year_sealed', evidence: { kind: 'statements_signoff' } }],
    ['checklist_item_complete', { runId: run.runId, itemId: 'year_sealed', evidence: { kind: 'gv_attestation', ref: '2027-03-20' } }],
    ['checklist_item_complete', { runId: run.runId, itemId: 'year_sealed' }],
  ];
  for (const [verb, input] of shapes) {
    const res = runGoverned(agent, getAction(verb), { workspaceId: w.wid, idempotencyKey: key('shape'), ...input });
    assert.equal(sealOf(w), undefined, `CRITIC: the AGENT sealed FY 2026 with ${verb} ${JSON.stringify(input)}: ${JSON.stringify(res).slice(0, 200)}`);
    assert.equal(closeEntries(w), 0);
    if (verb === 'close_year') assert.equal(res.drafted, true, `${verb} ${JSON.stringify(input)} must draft: ${JSON.stringify(res).slice(0, 200)}`);
  }
});

test('CRITIC R3 PROBE D (adapted): a rule naming close_year is refused at definition, run or no run', () => {
  const { w, run } = readyWorld();
  for (const inputTemplate of [{ year: '2026' }, { year: '2026', runId: run.runId }]) {
    refuse(
      w.call('create_automation_rule', { name: 'seal literal', trigger: { event: 'schedule.daily' }, action: { tool: 'close_year', inputTemplate }, idempotencyKey: key('rule') }),
      'action_not_automatable',
      'a rule naming close_year',
    );
  }
});

test('CRITIC R3 PROBE E (adapted): no automation rule seals the year, whatever its input resolves to', () => {
  const { w, run } = readyWorld();
  const rules = [
    { tool: 'checklist_item_complete', inputTemplate: { runId: run.runId, itemId: 'year_sealed{{nothing}}' } },
    { tool: 'checklist_item_complete', inputTemplate: { runId: run.runId, itemId: 'year_sealed' } },
  ];
  for (const action of rules) {
    const rule = w.call('create_automation_rule', { name: 'seal smuggled', trigger: { event: 'schedule.daily' }, action, idempotencyKey: key('rule') });
    // checklist_item_complete stays automatable (it never seals), so the rule is saved and really fires.
    must(rule, 'a checklist rule');
    must(w.call('run_due_automations', { asOf: '2027-02-15T09:00:00.000Z' }), 'tick');
    const runs = w.deps.store.db.prepare('SELECT status, error_code FROM automation_run WHERE workspace_id = ? AND rule_id = ?').all(w.wid, rule.rule.ruleId);
    assert.ok(runs.length >= 1, `the rule must have fired: ${JSON.stringify(runs)}`);
    for (const r of runs) assert.equal(r.error_code, 'check_item_live', JSON.stringify(runs));
    assert.equal(sealOf(w), undefined, `CRITIC: FY 2026 SEALED by an automation rule: ${JSON.stringify(runs)}`);
    assert.equal(closeEntries(w), 0);
  }
  // The pre-existing dodge on the year-close START is refused at fire time too.
  const start = w.call('create_automation_rule', { name: 'start smuggled', trigger: { event: 'schedule.daily' }, action: { tool: 'checklist_start', inputTemplate: { templateId: 'year_close{{x}}', period: '2027' } }, idempotencyKey: key('rule') });
  must(start, 'the smuggled start rule is saved (the template is not the denied value)');
  must(w.call('run_due_automations', { asOf: '2027-02-15T09:00:00.000Z' }), 'tick');
  const runs = w.deps.store.db.prepare('SELECT status, error_code FROM automation_run WHERE workspace_id = ? AND rule_id = ?').all(w.wid, start.rule.ruleId);
  assert.ok(runs.length >= 1, `the start rule must have fired: ${JSON.stringify(runs)}`);
  for (const r of runs) assert.equal(r.error_code, 'template_not_automatable', JSON.stringify(runs));
  assert.equal(w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM checklist_run WHERE workspace_id = ? AND template_id = 'year_close' AND period_label = '2027'").get(w.wid).n, 0);
});
