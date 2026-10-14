/**
 * CRITIC ROUND 4 PROBES on cl-periods (the rebuilt seal path). Non-author, adversarial.
 *
 * R4-1: `lock_period {period: YYYY, kind: 'hard', reason: 'year_close'}` writes the very row every
 * reader treats as THE year seal (`yearSealedOf`, `hardCloseYear`'s already-closed check, the
 * `seal_on_year` probe, `unlock_period`'s `hard_lock_sealed`), without the P&L sweep and without the
 * G22 §10.12 run guard. `lock_period` is automatable (only `unlock_period` is denied), so a stored
 * rule seals a year unattended, and a human or agent call skips the guided run that "owns its year".
 * After it, `close_year` answers `year_already_closed` forever: the P&L is never carried into 2970.
 *
 * Each test asserts the SAFE outcome, so it failed while the hole was open. ADOPTED as regression tests
 * for the fix (D152, 04.10.2026): `lock_period` refuses the seal reasons (`vat_filed`, `year_close`)
 * with `reserved_lock_reason` from every caller, an automation rule included; `close_year` and A07's
 * `vat_mark_filed` still write their seals through engine-internal paths; ordinary locks are unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { getAction } = await import('../../dist/api/registry.js');
const { callTool } = await import('../../dist/api/mcp.js');
const { handleRest } = await import('../../dist/api/rest.js');
const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
const { fixedClock } = await import('../../dist/core/clock.js');
const { sequenceIdGen } = await import('../../dist/core/ids.js');

let seq = 0;
const key = (tag) => `r4-${tag}-${(seq += 1)}`;

function world(actor = 'studio') {
  const at = '2027-02-15T09:00:00.000Z';
  const store = new SqliteStore({ clock: fixedClock(at) });
  const deps = { store, clock: fixedClock(at), ids: sequenceIdGen(), actor };
  const res = getAction('create_workspace').run(deps, { name: 'R4 GmbH', idempotencyKey: key('ws') });
  assert.equal(res.ok, true, JSON.stringify(res));
  const ws = res.workspaceId;
  store.db.prepare("UPDATE workspace SET legal_form = 'gmbh' WHERE id = ?").run(ws);
  const call = (name, input) => getAction(name).run(deps, { workspaceId: ws, ...input });
  const accId = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, n).id;
  // Some 2026 P&L, so the close has something to sweep.
  const posted = call('post_entry', {
    date: '2026-03-01', source: 'manual', description: 'Büromaterial', idempotencyKey: key('post'),
    lines: [{ account: accId('6500'), debit: 5000 }, { account: accId('1000'), credit: 5000 }],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  return { deps, store, ws, call };
}

const sealed = (w) =>
  w.store.db.prepare("SELECT COUNT(*) AS n FROM period_lock WHERE workspace_id = ? AND period = '2026' AND kind = 'hard' AND reason = 'year_close'").get(w.ws).n === 1;
const closes = (w) => w.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'close'").get(w.ws).n;

const lockRow = (w, period) => w.store.db.prepare('SELECT kind, reason FROM period_lock WHERE workspace_id = ? AND period = ?').get(w.ws, period);

test('R4-1a (fixed): an automation rule naming lock_period with year_close saves, fires, and is refused reserved_lock_reason', () => {
  const w = world();
  const rule = w.call('create_automation_rule', {
    name: 'Jahr sperren',
    trigger: { event: 'contact.created' },
    action: { tool: 'lock_period', inputTemplate: { period: '2026', kind: 'hard', reason: 'year_close' } },
    enabled: true,
    idempotencyKey: key('rule'),
  });
  // lock_period stays automatable for ordinary locks; the seal reason is what the verb refuses.
  assert.equal(rule.ok, true, JSON.stringify(rule));
  const c = w.call('create_contact', { partyRole: 'customer', name: 'Kunde', idempotencyKey: key('c') });
  assert.equal(c.ok, true, JSON.stringify(c));
  const runs = w.store.db.prepare('SELECT status, error_code FROM automation_run WHERE workspace_id = ? AND rule_id = ?').all(w.ws, rule.rule.ruleId);
  assert.deepEqual(runs.map((r) => ({ ...r })), [{ status: 'failed', error_code: 'reserved_lock_reason' }]);
  assert.equal(sealed(w), false, 'a stored rule sealed FY 2026 unattended (lock_period reason=year_close)');
  assert.equal(lockRow(w, '2026'), undefined);
});

test('R4-1b (fixed): lock_period cannot write the year_close seal past an open run; the run guard stands', () => {
  const w = world();
  const run = w.call('checklist_start', { templateId: 'year_close', period: '2026', idempotencyKey: key('start') });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(w.call('close_year', { year: '2026', idempotencyKey: key('cy') }).error, 'year_close_in_progress');
  const lp = w.call('lock_period', { period: '2026', kind: 'hard', reason: 'year_close', idempotencyKey: key('lp') });
  assert.equal(lp.error, 'reserved_lock_reason', JSON.stringify(lp));
  assert.deepEqual(lp.reserved, ['vat_filed', 'year_close']);
  assert.equal(sealed(w), false, 'lock_period wrote the year_close seal past the open run');
});

test('R4-1c (fixed): the refused forgery leaves close_year free to seal WITH its sweep', () => {
  const w = world();
  assert.equal(w.call('lock_period', { period: '2026', kind: 'hard', reason: 'year_close', idempotencyKey: key('lp') }).error, 'reserved_lock_reason');
  const cy = w.call('close_year', { year: '2026', idempotencyKey: key('cy') });
  assert.equal(cy.ok, true, JSON.stringify(cy));
  assert.equal(sealed(w), true);
  assert.ok(closes(w) > 0, 'the seal came with its closing entry');
});

test('R4-1d (fixed): after the refused forgery the open run still reads its seal row OPEN', () => {
  const w = world();
  const run = w.call('checklist_start', { templateId: 'year_close', period: '2026', idempotencyKey: key('start') });
  assert.equal(w.call('lock_period', { period: '2026', kind: 'hard', reason: 'year_close', idempotencyKey: key('lp') }).error, 'reserved_lock_reason');
  const view = w.call('checklist_get', { runId: run.runId });
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(view.items.find((i) => i.itemId === 'year_sealed').status, 'open');
  assert.equal(closes(w), 0);
});

test('R4-1: both seal reasons are refused over MCP and over REST, a month as well as a year', () => {
  const w = world();
  for (const [period, reason] of [['2026', 'year_close'], ['2026-03', 'vat_filed'], ['2026', 'vat_filed'], ['2026-03', 'year_close']]) {
    const viaMcp = JSON.parse(callTool(w.deps, 'lock_period', { workspaceId: w.ws, period, kind: 'hard', reason, idempotencyKey: key('mcp') }).content[0].text);
    assert.equal(viaMcp.error, 'reserved_lock_reason', JSON.stringify(viaMcp));
    const viaRest = handleRest('lock_period', { workspaceId: w.ws, period, kind: 'hard', reason, idempotencyKey: key('rest') }, w.deps);
    assert.equal(viaRest.body.error, 'reserved_lock_reason', JSON.stringify(viaRest));
    // A soft "seal" is refused too: the reason, not the kind, is what readers trust.
    assert.equal(w.call('lock_period', { period, kind: 'soft', reason, idempotencyKey: key('soft') }).error, 'reserved_lock_reason');
    assert.equal(lockRow(w, period), undefined, `${period} ${reason} wrote a lock`);
  }
});

test('R4-1: ordinary locks are unchanged: a hard lock with an ordinary reason locks, and unlock still opens it', () => {
  const w = world();
  const hard = w.call('lock_period', { period: '2026-05', kind: 'hard', reason: 'treuhaender_review', idempotencyKey: key('hard') });
  assert.equal(hard.ok, true, JSON.stringify(hard));
  assert.deepEqual({ ...lockRow(w, '2026-05') }, { kind: 'hard', reason: 'treuhaender_review' });
  const plain = w.call('lock_period', { period: '2026-06', kind: 'hard', idempotencyKey: key('plain') });
  assert.equal(plain.ok, true, JSON.stringify(plain));
  const soft = w.call('lock_period', { period: '2026', kind: 'soft', idempotencyKey: key('soft') });
  assert.equal(soft.ok, true, JSON.stringify(soft));
  assert.equal(w.call('unlock_period', { period: '2026-05', idempotencyKey: key('unlock') }).ok, true);
});

test('R4-1: vat_mark_filed still writes the filing seal through its internal path', () => {
  const w = world();
  assert.equal(w.call('vat_seed_defaults', {}).ok, true);
  assert.equal(w.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }).ok, true);
  const filed = w.call('vat_mark_filed', { period: '2026-Q1', idempotencyKey: key('file') });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  for (const m of ['2026-01', '2026-02', '2026-03']) assert.deepEqual({ ...lockRow(w, m) }, { kind: 'hard', reason: 'vat_filed' });
  assert.equal(w.call('unlock_period', { period: '2026-02', idempotencyKey: key('u') }).error, 'hard_lock_sealed');
});

test('R4-2 (holds): a replayed seal key answers the same with and without runId', () => {
  const w = world();
  const k = key('seal');
  const first = w.call('close_year', { year: '2026', idempotencyKey: k });
  assert.equal(first.ok, true, JSON.stringify(first));
  const posted = closes(w);
  const run = w.call('checklist_start', { templateId: 'year_close', period: '2026', idempotencyKey: key('start') });
  // A sealed year starts no run.
  assert.equal(run.error, 'year_already_closed', JSON.stringify(run));
  assert.deepEqual(w.call('close_year', { year: '2026', idempotencyKey: k }), first);
  assert.deepEqual(w.call('close_year', { year: '2026', runId: 'chkrun_whatever', idempotencyKey: k }), first);
  assert.equal(w.call('close_year', { year: '2026', idempotencyKey: key('other') }).error, 'year_already_closed');
  assert.equal(closes(w), posted, 'a replay or a re-close posted again');
});
