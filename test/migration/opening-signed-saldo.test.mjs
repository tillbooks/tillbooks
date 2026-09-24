/**
 * G18, the turnkey signed-`Saldo` opening-balances import (the money-path engine fix that retires
 * `scripts/migration/saldenliste-to-opening.mjs`). A bexio Saldenliste/Bilanz states ONE signed figure
 * per account; this proves it imports with NO preprocessing:
 *   - a signed `balance`/`Saldo` column is split the Swiss way (debit carries a positive balance,
 *     credit a negative one) and posts as A04's single balanced opening entry;
 *   - a hierarchical Bilanz's group/subtotal rows (no postable account) are SKIPPED and RECORDED,
 *     never double-counted and never silently dropped (owner decision, 2026-08-29);
 *   - `trial_balance_balanced` and `trial_balance_matches_source` read through the SAME builder the
 *     commit posts through, so check and commit see one number.
 *
 * MONEY-PATH NOTE (CLAUDE.md): the invariants below (append-only, idempotent-on-ROWS, §H-TENANT) are
 * drafted by the capability author; the non-author critic on this capability must confirm they bite
 * before the branch lands.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);
const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

function ws(deps, seed, name = 'Bilanz GmbH') {
  const { workspaceId } = mintWorkspace(deps, name, `${seed}-ws`);
  return workspaceId;
}

/** All account numbers currently in a workspace's chart. */
function chartNumbers(deps, wid) {
  return new Set(must(call(deps, 'list_accounts', { workspaceId: wid }), 'list_accounts').accounts.map((a) => a.number));
}

/** The lowest integer strings NOT postable in `present` (a Bilanz group subtotal is never a leaf). */
function nonChartNumbers(present, howMany = 1) {
  const out = [];
  for (let n = 1; out.length < howMany; n++) {
    const s = String(n);
    if (!present.has(s)) out.push(s);
  }
  return out;
}

/** Row counts a "posts nothing" / "idempotent on ROWS" claim is asserted ON (never on ok alone). */
function rowCounts(deps, wid) {
  const one = (sql) => deps.store.db.prepare(sql).get(wid).c;
  return {
    entries: one('SELECT COUNT(*) AS c FROM journal_entry WHERE workspace_id = ?'),
    lines: one(
      'SELECT COUNT(*) AS c FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?',
    ),
  };
}

/** Bind the G04 backup seam the way the G09 suites do, so a first live money-path commit is allowed. */
function grantBackup(deps, planId) {
  deps.store.db.prepare('UPDATE migration_plan SET backup_ref = ? WHERE id = ?').run('backup-1', planId);
}

/**
 * Upload a signed-`Saldo` opening source (`account,balance`) and walk it to a trial-loaded step.
 * `rows` are `{ account, balance }` (balance a signed major-unit string). `declares` are the operator's
 * per-account `trial_balance_matches_source` expectations (net minor).
 */
function seedSignedStep(deps, wid, seed, rows, declares) {
  const csv = 'account,balance\n' + rows.map((r) => `${r.account},${r.balance}`).join('\n') + '\n';
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
    call(deps, 'migration_create_plan', {
      workspaceId: wid,
      sourceSystem: 'csv',
      cutoverDate: '2026-01-01',
      localePack: 'ch',
      idempotencyKey: `${seed}-plan`,
    }),
    'create_plan',
  ).planId;
  must(call(deps, 'migration_discover_source', { workspaceId: wid, fileIds: [up.file.id], planId }), 'discover');
  const scope = must(
    call(deps, 'migration_set_scope', {
      workspaceId: wid,
      planId,
      classes: [{ dataClass: 'opening_balances', include: true }],
      idempotencyKey: `${seed}-scope`,
    }),
    'set_scope',
  );
  const stepId = scope.steps[0].stepId;
  (declares ?? []).forEach((d, i) =>
    must(
      call(deps, 'migration_declare_control_total', {
        workspaceId: wid,
        planId,
        stepId,
        kind: 'trial_balance_matches_source',
        scope: d.scope,
        declaredMinor: d.declaredMinor,
        idempotencyKey: `${seed}-decl-${i}`,
      }),
      'declare',
    ),
  );
  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: `${seed}-trial` }), 'trial');
  return { planId, stepId };
}

/** The money-path commit dance: first call stages (no approval yet), then backup + approval, then commit. */
function commitMoneyPath(deps, wid, planId, stepId, key) {
  const staged = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: key }), 'stage');
  assert.equal(staged.staged, true, `first money-path commit must draft-stage: ${JSON.stringify(staged)}`);
  grantBackup(deps, planId);
  must(
    call(deps, 'migration_record_approval', { workspaceId: wid, planId, stepId, checkHash: staged.checkHash, idempotencyKey: `${key}-appr` }),
    'approval',
  );
  return must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: key }), 'commit');
}

const byKind = (controls, kind) => controls.filter((c) => c.kind === kind);
const readLines = (deps, wid) => new Map(must(call(deps, 'get_opening_balances', { workspaceId: wid }), 'readback').lines.map((l) => [l.number, l]));

// --- The turnkey Bilanz: signed split + group skip + per-account tie-out -------------------------

test('G18: a raw signed-Saldo Bilanz imports turnkey, splitting the sign and skipping group rows', () => {
  const deps = freshDeps();
  const wid = ws(deps, 'turnkey');
  const present = chartNumbers(deps, wid);
  const [a, b, c] = [...present].slice(0, 3); // three real, postable KMU leaves
  const [group] = nonChartNumbers(present, 1); // a Bilanz subtotal, not a postable account

  // Leaves balance to zero (bexio sign convention). The group subtotal carries the asset total; were it
  // NOT skipped, the computed side would be imbalanced by 140000 and `trial_balance_balanced` would
  // fail. It IS skipped, so the kept set sums to zero.
  const rows = [
    { account: a, balance: '100000.00' }, // asset, positive -> debit 10'000'000 Rappen
    { account: b, balance: '40000.00' }, // asset, positive -> debit 4'000'000
    { account: c, balance: '-140000.00' }, // equity/liability, negative -> credit 14'000'000
    { account: group, balance: '140000.00' }, // group subtotal: NOT postable -> skipped
  ];
  const declares = [
    { scope: a, declaredMinor: 10000000 },
    { scope: b, declaredMinor: 4000000 },
    { scope: c, declaredMinor: -14000000 },
  ];
  const { planId, stepId } = seedSignedStep(deps, wid, 'tk', rows, declares);

  const checked = must(
    call(deps, 'migration_check_step', { workspaceId: wid, planId, stepId, against: 'testmandant', idempotencyKey: 'tk-check' }),
    'check',
  );
  assert.equal(byKind(checked.controls, 'trial_balance_balanced')[0].status, 'passed', 'balanced must pass once the group is excluded');
  const matches = byKind(checked.controls, 'trial_balance_matches_source');
  for (const scope of [a, b, c]) {
    assert.equal(matches.find((m) => m.scope === scope).status, 'passed', `per-account tie-out for ${scope} must pass`);
  }
  assert.equal(matches.find((m) => m.scope === group), undefined, 'a group subtotal must not appear as a computed account');
  assert.equal(checked.controls.some((ctl) => ctl.status === 'failed' || ctl.status === 'not_asserted'), false, 'no control blocks the commit');

  const committed = commitMoneyPath(deps, wid, planId, stepId, 'tk-commit');
  assert.equal(committed.created.length, 1, 'one opening entry regardless of row count (D86)');
  assert.equal(committed.skipped.length, 1, 'the one group row is recorded as skipped');

  // Read back: exactly the three leaves, split into the right sides. The group is absent.
  const posted = readLines(deps, wid);
  assert.equal(posted.get(a).debitMinor, 10000000, 'positive balance became a debit');
  assert.equal(posted.get(a).creditMinor, 0);
  assert.equal(posted.get(c).creditMinor, 14000000, 'negative balance became a credit');
  assert.equal(posted.get(c).debitMinor, 0);
  assert.equal(posted.has(group), false, 'the group subtotal was never posted');
});

// --- Money-path invariant: idempotent on ROWS ---------------------------------------------------

test('G18: re-committing the signed-Saldo import is idempotent on ROWS (same entry, ledger unmoved)', () => {
  const deps = freshDeps();
  const wid = ws(deps, 'idem');
  const present = chartNumbers(deps, wid);
  const [a, c] = [...present].slice(0, 2);
  const { planId, stepId } = seedSignedStep(
    deps,
    wid,
    'id',
    [
      { account: a, balance: '50000.00' },
      { account: c, balance: '-50000.00' },
    ],
    [
      { scope: a, declaredMinor: 5000000 },
      { scope: c, declaredMinor: -5000000 },
    ],
  );
  const first = commitMoneyPath(deps, wid, planId, stepId, 'id-commit');
  assert.ok(first.openingEntryId, 'the commit reported its opening entry id');
  const after = rowCounts(deps, wid);

  // The SAME commit key replays the memoized result: same entry, and the ledger moves zero times.
  const replay = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'id-commit' }), 're-commit');
  assert.equal(replay.openingEntryId, first.openingEntryId, 'a replay returns the same opening entry');
  assert.deepEqual(rowCounts(deps, wid), after, 'a replay posts nothing new (asserted on ROWS)');
});

// --- Money-path invariant: append-only (the posted opening entry is immutable) -------------------

test('G18: the signed-Saldo opening entry is append-only (UPDATE/DELETE refused below the engine)', () => {
  const deps = freshDeps();
  const wid = ws(deps, 'immut');
  const present = chartNumbers(deps, wid);
  const [a, c] = [...present].slice(0, 2);
  const { planId, stepId } = seedSignedStep(
    deps,
    wid,
    'im',
    [
      { account: a, balance: '25000.00' },
      { account: c, balance: '-25000.00' },
    ],
    [
      { scope: a, declaredMinor: 2500000 },
      { scope: c, declaredMinor: -2500000 },
    ],
  );
  const committed = commitMoneyPath(deps, wid, planId, stepId, 'im-commit');
  const entryId = committed.openingEntryId;

  assert.throws(
    () => deps.store.db.prepare('UPDATE journal_entry SET description = ? WHERE id = ? AND workspace_id = ?').run('x', entryId, wid),
    /immutable|posted/i,
    'a posted opening entry must refuse UPDATE',
  );
  assert.throws(
    () => deps.store.db.prepare('DELETE FROM journal_entry WHERE id = ? AND workspace_id = ?').run(entryId, wid),
    /immutable|posted/i,
    'a posted opening entry must refuse DELETE',
  );
});

// --- Money-path invariant: §H-TENANT (postability is resolved in THIS workspace only) ------------

test('G18: §H-TENANT: a number postable only in a NEIGHBOUR is skipped here, never posted', () => {
  const deps = freshDeps();
  const mine = ws(deps, 'mine', 'Zweiter Mandant');
  const neighbour = ws(deps, 'nbr', 'Erster Mandant');
  const present = chartNumbers(deps, mine);
  const [a, c] = [...present].slice(0, 2);
  const [foreign] = nonChartNumbers(present, 1); // not in MY chart

  // The neighbour DOES hold `foreign` as a real postable account; mine does not.
  must(
    call(deps, 'create_account', { workspaceId: neighbour, number: foreign, name: 'Nur beim Nachbarn', type: 'asset', idempotencyKey: 'nbr-acct' }),
    'neighbour create_account',
  );
  assert.equal(chartNumbers(deps, mine).has(foreign), false, 'the neighbour account must not leak into my chart');

  const { planId, stepId } = seedSignedStep(
    deps,
    mine,
    'tn',
    [
      { account: a, balance: '30000.00' },
      { account: c, balance: '-30000.00' },
      { account: foreign, balance: '9999.00' }, // resolvable only in the neighbour -> must skip here
    ],
    [
      { scope: a, declaredMinor: 3000000 },
      { scope: c, declaredMinor: -3000000 },
    ],
  );
  const committed = commitMoneyPath(deps, mine, planId, stepId, 'tn-commit');
  assert.equal(committed.skipped.length, 1, 'the neighbour-only account is skipped in my workspace');
  assert.equal(readLines(deps, mine).has(foreign), false, 'a number postable only in the neighbour was never posted here');
});
