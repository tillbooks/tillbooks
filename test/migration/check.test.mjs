/**
 * G11, the Eröffnungsprüfung: the invariants the spec turns on, proven by measurement.
 *
 * The claims worth the most here: a mis-tied control total FAILS the check and the commit gate
 * REFUSES (migration_check_step is the gate that lets G09 commit opening balances); a control
 * nobody declared reads "nicht geprüft" and never green, and it also refuses the commit; a waiver
 * without a reason is refused (empty string included) and a waived control reports `waived`, never
 * `passed`; the hash is stable for stable inputs and moves on any input change; the transposition
 * fixture passes `trial_balance_balanced` and fails `trial_balance_matches_source` (A04 §10's
 * stated blind spot, closed); `ar_control` is byte-identical to A16's own read; `source_as_at`
 * catches a stale export and reports `not_computable`, never `passed`, for a format with no date;
 * the two runs must agree or the live check reports `diverged` naming the control; §H-TENANT.
 *
 * MONEY-PATH NOTE (CLAUDE.md): these are invariant tests on the gate that stands before the live
 * ledger. Drafted by the capability author; the non-author critic on this capability must confirm
 * they bite before the branch lands.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { CONTROL_STATUSES, CONTROL_KINDS } from '../../dist/core/migration/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);
const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

function ws(seed) {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Prüfung GmbH', `${seed}-ws`);
  return { deps, wid: workspaceId };
}

/** Two real KMU accounts and an opening CSV over them, linked, scoped, NOT yet declared. */
function seedOpeningStep(deps, wid, seed, { rows } = {}) {
  const accounts = must(call(deps, 'list_accounts', { workspaceId: wid }), 'list_accounts').accounts;
  const [a, b] = accounts;
  const csvRows = rows ?? [
    { account: a.number, debitMinor: 100000, creditMinor: 0 },
    { account: b.number, debitMinor: 0, creditMinor: 100000 },
  ];
  const csv =
    'account,debitMinor,creditMinor\n' + csvRows.map((r) => `${r.account},${r.debitMinor},${r.creditMinor}`).join('\n') + '\n';
  const up = must(
    call(deps, 'files_upload', {
      workspaceId: wid,
      title: `Eröffnung ${seed}`,
      filename: `${seed}.csv`,
      mime: 'text/csv',
      contentBase64: Buffer.from(csv).toString('base64'),
      idempotencyKey: `${seed}-up`,
    }),
    'files_upload',
  );
  const planId = must(
    call(deps, 'migration_create_plan', { workspaceId: wid, sourceSystem: 'csv', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: `${seed}-plan` }),
    'create_plan',
  ).planId;
  must(call(deps, 'migration_discover_source', { workspaceId: wid, fileIds: [up.file.id], planId }), 'discover');
  const scope = must(
    call(deps, 'migration_set_scope', { workspaceId: wid, planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: `${seed}-scope` }),
    'set_scope',
  );
  return { planId, stepId: scope.steps[0].stepId, a, b, fileId: up.file.id };
}

function declare(deps, wid, planId, stepId, scope, declaredMinor, key) {
  return must(
    call(deps, 'migration_declare_control_total', {
      workspaceId: wid,
      planId,
      stepId,
      kind: 'trial_balance_matches_source',
      scope,
      declaredMinor,
      idempotencyKey: key,
    }),
    'declare',
  );
}

function check(deps, wid, planId, stepId, key, against = 'testmandant') {
  return must(call(deps, 'migration_check_step', { workspaceId: wid, planId, stepId, against, idempotencyKey: key }), 'check');
}

const byKind = (controls, kind) => controls.filter((c) => c.kind === kind);

// --- The enum itself: five statuses, and the retired brand word is NOT one of them --------------

test('G11: control_status has exactly five values and amber is not one of them', () => {
  assert.equal(CONTROL_STATUSES.length, 5);
  assert.deepEqual([...CONTROL_STATUSES].sort(), ['failed', 'not_asserted', 'not_computable', 'passed', 'waived']);
  assert.ok(!CONTROL_STATUSES.includes('amber'), 'the retired brand colour re-entered through a data name');
  assert.equal(CONTROL_KINDS.length, 9);
});

// --- The tie-out gate: a mis-tied total FAILS and the commit refuses ----------------------------

test('G11: a mis-tied control total FAILS the check and the commit gate refuses (the tie-out gate)', () => {
  const { deps, wid } = ws('mistie');
  const { planId, stepId, a, b } = seedOpeningStep(deps, wid, 'mt');
  // The source says a=100000; the operator declares 90000: the declared source total does NOT tie.
  declare(deps, wid, planId, stepId, a.number, 90000, 'mt-d1');
  declare(deps, wid, planId, stepId, b.number, -100000, 'mt-d2');

  const checked = check(deps, wid, planId, stepId, 'mt-check');
  const failing = byKind(checked.controls, 'trial_balance_matches_source').find((c) => c.scope === a.number);
  assert.equal(failing.status, 'failed', 'a mis-tied per-account total must FAIL');
  assert.equal(failing.differenceMinor, 100000 - 90000, 'the difference is integer subtraction in Rappen');
  assert.equal(checked.clean, false);
  assert.equal(checked.failedCheckId, checked.checkId, 'the check_failed occurrence anchor must resolve');
  assert.equal(checked.cleanCheckId, null);

  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'mt-trial' }), 'trial');
  const res = call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'mt-commit' });
  assert.equal(res.ok, false, 'a step whose check failed must not commit');
  assert.equal(res.error, 'check_failed');
  assert.equal(res.status, 'failed');
});

// --- The transposition fixture: A04 section 10's stated blind spot, closed ----------------------

test('G11: two transposed accounts pass trial_balance_balanced and fail trial_balance_matches_source', () => {
  const { deps, wid } = ws('transpose');
  const { planId, stepId, a, b } = seedOpeningStep(deps, wid, 'tp');
  // The operator declares the two accounts TRANSPOSED against what the file holds.
  declare(deps, wid, planId, stepId, a.number, -100000, 'tp-d1');
  declare(deps, wid, planId, stepId, b.number, 100000, 'tp-d2');

  const checked = check(deps, wid, planId, stepId, 'tp-check');
  const balanced = byKind(checked.controls, 'trial_balance_balanced')[0];
  assert.equal(balanced.status, 'passed', 'a transposition is invisible to the structural balance check');
  for (const control of byKind(checked.controls, 'trial_balance_matches_source')) {
    assert.equal(control.status, 'failed', `the per-account control must catch the transposition on ${control.scope}`);
  }
});

// --- not_asserted: never green, never clean, refuses the commit; distinct from not_computable ---

test('G11: an undeclared control reads not_asserted, never clean, and refuses the commit', () => {
  const { deps, wid } = ws('undeclared');
  const { planId, stepId } = seedOpeningStep(deps, wid, 'ud');
  const checked = check(deps, wid, planId, stepId, 'ud-check');

  const perAccount = byKind(checked.controls, 'trial_balance_matches_source');
  assert.ok(perAccount.length >= 2, 'the per-account control must report per account, not one total');
  for (const control of perAccount) {
    assert.equal(control.status, 'not_asserted', 'no expectation was stated, so the control is nicht geprüft');
  }
  assert.equal(checked.clean, false, 'a check with a not_asserted control must never read clean');

  // Distinct from not_computable: the ledger-membership controls on a trial run miss their INPUT
  // (no Testmandant until G12), which is a different fact than "you did not tell me".
  const ar = byKind(checked.controls, 'ar_control')[0];
  assert.equal(ar.status, 'not_computable');
  assert.ok(ar.missingInput.includes('testmandant'), 'not_computable names the missing input');

  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'ud-trial' }), 'trial');
  const res = call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'ud-commit' });
  assert.equal(res.ok, false, 'not_asserted must refuse the commit engine-side');
  assert.equal(res.error, 'check_failed');
  assert.equal(res.status, 'not_asserted');
});

test('G11: an empty step ties out trivially and says so', () => {
  const { deps, wid } = ws('empty');
  // No source file at all: zero rows.
  const planId = must(
    call(deps, 'migration_create_plan', { workspaceId: wid, sourceSystem: 'csv', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: 'em-plan' }),
    'plan',
  ).planId;
  const scope = must(
    call(deps, 'migration_set_scope', { workspaceId: wid, planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: 'em-scope' }),
    'scope',
  );
  const checked = check(deps, wid, planId, scope.steps[0].stepId, 'em-check');
  const matches = byKind(checked.controls, 'trial_balance_matches_source')[0];
  assert.equal(matches.status, 'passed', 'an empty class ties out trivially (0 == 0), never not_asserted');
  assert.equal(matches.computedMinor, 0);
});

// --- Waivers: reason required, waived is not passed, who/why recorded, voided on change ---------

test('G11: a waiver without a reason is refused (empty string included), and a waived control is waived, not passed', () => {
  const { deps, wid } = ws('waiver');
  const { planId, stepId, a, b } = seedOpeningStep(deps, wid, 'wv');
  declare(deps, wid, planId, stepId, a.number, 90000, 'wv-d1'); // mis-tied on purpose
  declare(deps, wid, planId, stepId, b.number, -100000, 'wv-d2');
  const checked = check(deps, wid, planId, stepId, 'wv-check');
  const failing = checked.controls.find((c) => c.status === 'failed');

  // No reason, and a blank reason, are the SAME refusal: a silent waiver is a deleted control.
  const missing = call(deps, 'migration_waive_control', { workspaceId: wid, controlId: failing.controlId, idempotencyKey: 'wv-w0', reason: undefined });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'waiver_needs_reason');
  const blank = call(deps, 'migration_waive_control', { workspaceId: wid, controlId: failing.controlId, reason: '   ', idempotencyKey: 'wv-w1' });
  assert.equal(blank.ok, false);
  assert.equal(blank.error, 'waiver_needs_reason');

  const waived = must(
    call(deps, 'migration_waive_control', { workspaceId: wid, controlId: failing.controlId, reason: 'Bewusst vom alten Saldo übernommen', idempotencyKey: 'wv-w2' }),
    'waive',
  );
  assert.equal(waived.status, 'waived');

  // WHO and WHY are recorded on the row (the export and readiness carry them).
  const row = deps.store.db
    .prepare('SELECT status, waiver_reason, waived_by, waived_at FROM migration_control_total WHERE id = ?')
    .get(failing.controlId);
  assert.equal(row.status, 'waived');
  assert.equal(row.waiver_reason, 'Bewusst vom alten Saldo übernommen');
  assert.ok(row.waived_by, 'the waiver must record who');
  assert.ok(row.waived_at, 'the waiver must record when');

  // The re-run carries the waiver (computed unchanged): waived is a VISIBLE exception, never a
  // silent pass, and the FAILED leg of the gate is now cleared the way US-G11.6 intends.
  const rechecked = check(deps, wid, planId, stepId, 'wv-check-2');
  const carried = rechecked.controls.find((c) => c.controlId === failing.controlId);
  assert.equal(carried.status, 'waived', 'a waiver survives an idempotent re-check');
  assert.notEqual(carried.status, 'passed', 'a waived control must never read as passed');
  // `clean` is a conjunction of passed and waived: the not_computable controls (no Testmandant
  // until G12, a CSV with no as-of date) keep it false until each is waived too. Waive them all
  // and the conjunction closes.
  assert.equal(rechecked.clean, false, 'a not_computable control still keeps the check from reading clean');
  let waiveKey = 0;
  for (const control of rechecked.controls.filter((c) => c.status === 'not_computable')) {
    must(
      call(deps, 'migration_waive_control', { workspaceId: wid, controlId: control.controlId, reason: 'Quelle liefert diese Angabe nicht; geprüft am Papier', idempotencyKey: `wv-nc-${waiveKey++}` }),
      'waive not_computable',
    );
  }
  const closed = check(deps, wid, planId, stepId, 'wv-check-3');
  assert.equal(closed.clean, true, 'clean is a conjunction of passed and waived');
  assert.equal(closed.cleanCheckId, closed.checkId, 'the check_clean occurrence anchor resolves only when clean');

  // A passed control cannot be waived: waiving is for setting a finding aside, not for decoration.
  const passed = rechecked.controls.find((c) => c.status === 'passed');
  const refuse = call(deps, 'migration_waive_control', { workspaceId: wid, controlId: passed.controlId, reason: 'unnötig', idempotencyKey: 'wv-w3' });
  assert.equal(refuse.ok, false);
  assert.equal(refuse.error, 'control_not_waivable');

  // A NEW declaration reopens the control: the waiver was for a result that no longer exists.
  declare(deps, wid, planId, stepId, a.number, 95000, 'wv-d3');
  const reopened = deps.store.db.prepare('SELECT status, waiver_reason FROM migration_control_total WHERE id = ?').get(failing.controlId);
  assert.equal(reopened.status, 'not_asserted');
  assert.equal(reopened.waiver_reason, null, 'a reopened control does not keep a stale excuse');
});

// --- The hash: stable for stable inputs, moved by any input change ------------------------------

test('G11: the check hash is stable for unchanged inputs (same snapshot returned) and moves on a declared change', () => {
  const { deps, wid } = ws('hash');
  const { planId, stepId, a, b } = seedOpeningStep(deps, wid, 'hs');
  declare(deps, wid, planId, stepId, a.number, 100000, 'hs-d1');
  declare(deps, wid, planId, stepId, b.number, -100000, 'hs-d2');

  const first = check(deps, wid, planId, stepId, 'hs-c1');
  const second = check(deps, wid, planId, stepId, 'hs-c2');
  assert.equal(second.checkHash, first.checkHash, 'stable inputs must produce a stable hash (locale is not an input)');
  assert.equal(second.checkId, first.checkId, 'unchanged inputs return the stored snapshot, not a second one');

  declare(deps, wid, planId, stepId, a.number, 99999, 'hs-d3');
  const third = check(deps, wid, planId, stepId, 'hs-c3');
  assert.notEqual(third.checkHash, first.checkHash, 'changing one declared figure must move the hash');
  assert.notEqual(third.checkId, first.checkId, 'a re-check under changed inputs mints a NEW snapshot (append-only)');

  // The prior snapshot SURVIVES byte-for-byte: the record of what an approver saw (§H-AUDIT).
  const kept = must(call(deps, 'migration_get_check', { workspaceId: wid, checkId: first.checkId }), 'get_check');
  assert.equal(kept.check.checkHash, first.checkHash);

  // And the G09 approval binding really binds: the stale hash is refused.
  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'hs-trial' }), 'trial');
  const stale = call(deps, 'migration_record_approval', { workspaceId: wid, planId, stepId, checkHash: first.checkHash, idempotencyKey: 'hs-appr' });
  assert.equal(stale.ok, false, 'an approval must not bind to a hash the step has moved past');
});

// --- ar_control is A16's number, byte-identical --------------------------------------------------

test('G11: ar_control on the live run is byte-identical to A16 listOpenItems for the same date', () => {
  const { deps, wid } = ws('arbyte');
  const { planId, stepId, a, b } = seedOpeningStep(deps, wid, 'ab');
  declare(deps, wid, planId, stepId, a.number, 100000, 'ab-d1');
  declare(deps, wid, planId, stepId, b.number, -100000, 'ab-d2');
  const live = check(deps, wid, planId, stepId, 'ab-live', 'live');
  const ar = byKind(live.controls, 'ar_control')[0];
  const a16 = must(call(deps, 'list_open_items', { workspaceId: wid, asOf: '2026-01-01' }), 'list_open_items');
  assert.equal(ar.computedMinor, a16.workspaceBaseTotalOpenMinor, "the control's figure IS A16's figure, not a second derivation");
  assert.equal(ar.status, a16.reconciled && a16.workspaceBaseTotalOpenMinor === 0 ? 'passed' : ar.status);
  // AR and AP are TWO controls, never one net figure (OR 958c Abs. 1 Ziff. 7).
  assert.equal(byKind(live.controls, 'ap_control').length, 1);
});

// --- source_as_at: staleness caught, absence reported, never a silent pass ----------------------

test('G11: source_as_at fails a stale export and reports not_computable, never passed, for a format with no date', () => {
  const { deps, wid } = ws('asat');
  const { planId, stepId, fileId } = seedOpeningStep(deps, wid, 'sa');

  // A generic CSV carries no as-of date: not_computable, with the file named. NEVER passed.
  const noDate = check(deps, wid, planId, stepId, 'sa-c1');
  const absent = byKind(noDate.controls, 'source_as_at')[0];
  assert.equal(absent.status, 'not_computable', 'absence of evidence is reported as absence of evidence');
  assert.equal(absent.scope, fileId);

  // The same file with a RECORDED as-of date nine days before the Stichtag: failed, gap named.
  deps.store.db.prepare('UPDATE migration_source_file SET as_at = ? WHERE plan_id = ? AND file_id = ?').run('2025-12-23', planId, fileId);
  const stale = check(deps, wid, planId, stepId, 'sa-c2');
  const staleCtl = byKind(stale.controls, 'source_as_at')[0];
  assert.equal(staleCtl.status, 'failed', 'a week-old export must not tie out silently green');
  assert.equal(staleCtl.computedMinor, 9, 'the gap in days is stated');
  assert.notEqual(stale.checkHash, noDate.checkHash, 'a source-file fact change moves the hash');

  // At the Stichtag itself: passed.
  deps.store.db.prepare('UPDATE migration_source_file SET as_at = ? WHERE plan_id = ? AND file_id = ?').run('2026-01-01', planId, fileId);
  const fresh = check(deps, wid, planId, stepId, 'sa-c3');
  assert.equal(byKind(fresh.controls, 'source_as_at')[0].status, 'passed');
});

// --- The two runs must agree: divergence is named ------------------------------------------------

test('G11: a live check that disagrees with the trial check reports diverged and names the control', () => {
  const { deps, wid } = ws('diverge');
  const { planId, stepId, a, b } = seedOpeningStep(deps, wid, 'dv');
  declare(deps, wid, planId, stepId, a.number, 100000, 'dv-d1');
  declare(deps, wid, planId, stepId, b.number, -100000, 'dv-d2');
  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'dv-trial' }), 'trial');
  const staged = call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'dv-commit' });
  assert.equal(staged.staged, true);
  deps.store.db.prepare('UPDATE migration_plan SET backup_ref = ? WHERE id = ?').run('backup-1', planId);
  must(call(deps, 'migration_record_approval', { workspaceId: wid, planId, stepId, checkHash: staged.checkHash, idempotencyKey: 'dv-appr' }), 'approval');
  must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'dv-commit' }), 'commit');

  // The live books now hold the opening position: the live run AGREES with the trial run.
  const agreeing = check(deps, wid, planId, stepId, 'dv-live-1', 'live');
  assert.equal(agreeing.diverged, false, 'a faithful commit must not diverge');

  // One extra posting dated at the Stichtag moves the live position away from what was checked.
  const accId = (number) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(wid, number).id;
  must(
    call(deps, 'post_entry', {
      workspaceId: wid,
      date: '2026-01-01',
      source: 'manual',
      description: 'Nachbuchung am Stichtag',
      lines: [
        { account: accId(a.number), debit: 5000 },
        { account: accId(b.number), credit: 5000 },
      ],
      idempotencyKey: 'dv-extra',
    }),
    'post_entry',
  );
  const diverged = check(deps, wid, planId, stepId, 'dv-live-2', 'live');
  assert.equal(diverged.diverged, true, 'a live position that moved must report diverged');
  assert.ok(
    diverged.divergedControls.some((c) => c.kind === 'trial_balance_matches_source'),
    'the diverged report names the differing control',
  );
});

// --- §H-TENANT: a neighbour reads nothing and waives nothing ------------------------------------

test('G11: checks and controls are invisible across the tenant fence', () => {
  const deps = freshDeps();
  const one = mintWorkspace(deps, 'Eins GmbH', 'tn-one');
  const two = mintWorkspace(deps, 'Zwei GmbH', 'tn-two');
  const { planId, stepId } = seedOpeningStep(deps, one.workspaceId, 'tn');
  const checked = check(deps, one.workspaceId, planId, stepId, 'tn-check');

  const foreignGet = call(deps, 'migration_get_check', { workspaceId: two.workspaceId, checkId: checked.checkId });
  assert.equal(foreignGet.ok, false);
  assert.equal(foreignGet.error, 'not_found');
  const foreignList = call(deps, 'migration_list_checks', { workspaceId: two.workspaceId, planId });
  assert.equal(foreignList.ok, false, "a neighbour must not list another workspace's checks");
  const foreignExport = call(deps, 'migration_export_check', { workspaceId: two.workspaceId, checkId: checked.checkId });
  assert.equal(foreignExport.ok, false);
  const anyControl = checked.controls[0];
  const foreignWaive = call(deps, 'migration_waive_control', { workspaceId: two.workspaceId, controlId: anyControl.controlId, reason: 'fremd', idempotencyKey: 'tn-w' });
  assert.equal(foreignWaive.ok, false, "a neighbour must not waive another workspace's control");
});

// --- The Prüfbericht: locale-neutral, carries waivers and the evidence chain --------------------

test('G11: the Prüfbericht export carries every control, waiver, source hash and the check hash, locale-neutral', () => {
  const { deps, wid } = ws('bericht');
  const { planId, stepId, a, b, fileId } = seedOpeningStep(deps, wid, 'pb');
  declare(deps, wid, planId, stepId, a.number, 90000, 'pb-d1');
  declare(deps, wid, planId, stepId, b.number, -100000, 'pb-d2');
  const checked = check(deps, wid, planId, stepId, 'pb-check');
  const failing = checked.controls.find((c) => c.status === 'failed');
  must(call(deps, 'migration_waive_control', { workspaceId: wid, controlId: failing.controlId, reason: 'Differenz beim Treuhänder dokumentiert', idempotencyKey: 'pb-w' }), 'waive');
  const rechecked = check(deps, wid, planId, stepId, 'pb-check-2');

  const exported = must(call(deps, 'migration_export_check', { workspaceId: wid, checkId: rechecked.checkId, format: 'json' }), 'export');
  const bericht = JSON.parse(exported.content);
  assert.equal(bericht.checkHash, rechecked.checkHash);
  assert.equal(bericht.waivers.length, 1);
  assert.equal(bericht.waivers[0].reason, 'Differenz beim Treuhänder dokumentiert');
  assert.ok(bericht.sourceFiles.some((f) => f.fileId === fileId && typeof f.sha256 === 'string'), 'the Beleg chain (sha256) is in the export');
  assert.ok(bericht.controls.every((c) => typeof c.status === 'string'), 'every control travels');
  // Locale-neutral machine layer: raw integers, ISO dates, no formatted money string anywhere.
  assert.ok(!exported.content.includes('CHF '), 'the machine layer must not carry formatted money');
  // An unsupported format is refused, naming what is supported.
  const bad = call(deps, 'migration_export_check', { workspaceId: wid, checkId: rechecked.checkId, format: 'docx' });
  assert.equal(bad.ok, false);
});
