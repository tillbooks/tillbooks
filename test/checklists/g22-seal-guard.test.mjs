/**
 * G22 §10.12 on the engine (D152, owner decision "Engine guard + fail-closed UI", 04.10.2026; the seal
 * path rebuilt after critic round 3). The seal stays on `close_year` (NOT_AUTOMATABLE, dialed
 * `close-period` by name). Without `runId` it refuses `year_close_in_progress` while an open
 * `year_close` run exists for the year, naming the run. With `runId` it runs only for an open
 * `year_close` run of this workspace for exactly that year whose `year_sealed` row is unblocked. The
 * full walk to a sealed run, through `close_year` with the run's id, is `g22-year-close.test.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { getAction } = await import('../../dist/api/registry.js');
const { callTool } = await import('../../dist/api/mcp.js');
const { handleRest } = await import('../../dist/api/rest.js');
const { makeContext } = await import('../../dist/core/context.js');
const { ledgerPorts } = await import('../../dist/core/ledger/index.js');
const { closeYearGuarded } = await import('../../dist/core/checklists/index.js');
const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
const { fixedClock } = await import('../../dist/core/clock.js');
const { sequenceIdGen } = await import('../../dist/core/ids.js');

let seq = 0;
const key = (tag) => `sg-${tag}-${(seq += 1)}`;

/** Two workspaces on one store at 15.02.2027, so FY 2026 has ended and a year run can start. */
function world() {
  const at = '2027-02-15T09:00:00.000Z';
  const store = new SqliteStore({ clock: fixedClock(at) });
  const deps = { store, clock: fixedClock(at), ids: sequenceIdGen(), actor: 'studio' };
  const mk = (name) => {
    const res = getAction('create_workspace').run(deps, { name, idempotencyKey: key(`ws-${name}`) });
    assert.equal(res.ok, true, JSON.stringify(res));
    store.db.prepare("UPDATE workspace SET legal_form = 'gmbh' WHERE id = ?").run(res.workspaceId);
    return res.workspaceId;
  };
  const a = mk('A');
  const b = mk('B');
  const call = (workspaceId, name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, store, a, b, call };
}

function startRun(w, workspaceId, templateId, period) {
  const res = w.call(workspaceId, 'checklist_start', { templateId, period, idempotencyKey: key('start') });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(typeof res.runId, 'string');
  return res.runId;
}

const sealed = (w, workspaceId, year) =>
  w.store.db.prepare("SELECT COUNT(*) AS n FROM period_lock WHERE workspace_id = ? AND period = ? AND kind = 'hard' AND reason = 'year_close'").get(workspaceId, year).n === 1;
const closes = (w, workspaceId) => w.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'close'").get(workspaceId).n;

test('without runId: an open year run blocks close_year over MCP and over REST, naming the run, and nothing moves', () => {
  const w = world();
  const runId = startRun(w, w.a, 'year_close', '2026');
  const viaMcp = JSON.parse(callTool(w.deps, 'close_year', { workspaceId: w.a, year: '2026', idempotencyKey: key('mcp') }).content[0].text);
  assert.equal(viaMcp.ok, false, JSON.stringify(viaMcp));
  assert.equal(viaMcp.error, 'year_close_in_progress');
  assert.equal(viaMcp.yearRunId, runId);
  assert.equal(viaMcp.fiscalYear, '2026');
  const viaRest = handleRest('close_year', { workspaceId: w.a, year: '2026', idempotencyKey: key('rest') }, w.deps);
  assert.equal(viaRest.body.ok, false, JSON.stringify(viaRest));
  assert.equal(viaRest.body.error, 'year_close_in_progress');
  assert.equal(viaRest.body.yearRunId, runId);
  assert.equal(sealed(w, w.a, '2026'), false);
  assert.equal(closes(w, w.a), 0);
});

test('with runId: the run\'s seal row must be unblocked, over MCP and over REST', () => {
  const w = world();
  const runId = startRun(w, w.a, 'year_close', '2026');
  const viaMcp = JSON.parse(callTool(w.deps, 'close_year', { workspaceId: w.a, year: '2026', runId, idempotencyKey: key('mcp-run') }).content[0].text);
  assert.equal(viaMcp.error, 'prerequisite_open', JSON.stringify(viaMcp));
  assert.equal(viaMcp.itemId, 'year_sealed');
  assert.equal(typeof viaMcp.prerequisiteItemId, 'string');
  const viaRest = handleRest('close_year', { workspaceId: w.a, year: '2026', runId, idempotencyKey: key('rest-run') }, w.deps);
  assert.equal(viaRest.body.error, 'prerequisite_open');
  assert.equal(sealed(w, w.a, '2026'), false);
  assert.equal(closes(w, w.a), 0);
});

test('with runId: every mismatch refuses with its own code', () => {
  const w = world();
  const yearRun = startRun(w, w.a, 'year_close', '2026');
  const monthRun = startRun(w, w.a, 'month_close', '2027-01');
  const otherRun = startRun(w, w.b, 'year_close', '2026');
  const close = (input) => w.call(w.a, 'close_year', { year: '2026', idempotencyKey: key('mm'), ...input });
  assert.equal(close({ runId: '' }).error, 'invalid_input');
  assert.equal(close({ runId: 42 }).error, 'invalid_input');
  assert.equal(close({ runId: 'chkrun_nope' }).error, 'not_found');
  // §H-TENANT: another workspace's run is simply not found here.
  assert.equal(close({ runId: otherRun }).error, 'not_found');
  assert.equal(close({ runId: monthRun }).error, 'run_not_year_close');
  const mismatch = w.call(w.a, 'close_year', { year: '2025', runId: yearRun, idempotencyKey: key('mm') });
  assert.equal(mismatch.error, 'run_year_mismatch');
  assert.equal(mismatch.runYear, '2026');
  must(w.call(w.a, 'checklist_abandon', { runId: yearRun, reason: 'Falsches Jahr gestartet.', idempotencyKey: key('ab') }));
  assert.equal(close({ runId: yearRun }).error, 'run_abandoned');
  assert.equal(sealed(w, w.a, '2026'), false);
  assert.equal(sealed(w, w.a, '2025'), false);
});

function must(res) {
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

test('an extra wire field cannot stand in for the run: only runId names it, and runId is validated', () => {
  const w = world();
  const runId = startRun(w, w.a, 'year_close', '2026');
  for (const extra of [{ sealingRunId: runId }, { internal: { sealingRunId: runId } }, { yearRunId: runId }]) {
    const res = w.call(w.a, 'close_year', { year: '2026', idempotencyKey: key('forge'), ...extra });
    assert.equal(res.error, 'year_close_in_progress', `${JSON.stringify(extra)}: ${JSON.stringify(res)}`);
  }
  assert.equal(sealed(w, w.a, '2026'), false);
});

test('the manage_periods gate comes first: no run detail reaches a caller who may not seal', () => {
  const w = world();
  const runId = startRun(w, w.a, 'year_close', '2026');
  const deny = { assert: (c) => (c === 'manage_periods' ? { ok: false, error: 'permission_denied', capability: c } : { ok: true }) };
  const ctx = makeContext(w.store, { workspaceId: w.a, actor: 'studio', clock: w.deps.clock, ids: w.deps.ids, ...ledgerPorts({ store: w.store, workspaceId: w.a, ids: w.deps.ids }), capabilities: deny });
  for (const input of [{ year: '2026', idempotencyKey: key('d') }, { year: '2026', runId, idempotencyKey: key('d') }]) {
    const res = closeYearGuarded(ctx, input);
    assert.equal(res.error, 'permission_denied', JSON.stringify(res));
    assert.equal(res.yearRunId, undefined);
  }
});

test('a different year is not blocked, an abandoned run hands the year back, a sealed year answers year_already_closed', () => {
  const w = world();
  const runId = startRun(w, w.a, 'year_close', '2026');
  must(w.call(w.a, 'close_year', { year: '2025', idempotencyKey: key('2025') }));
  assert.equal(w.call(w.a, 'close_year', { year: '2025', idempotencyKey: key('2025b') }).error, 'year_already_closed');
  must(w.call(w.a, 'checklist_abandon', { runId, reason: 'Falsches Jahr gestartet.', idempotencyKey: key('abandon') }));
  must(w.call(w.a, 'close_year', { year: '2026', idempotencyKey: key('after') }));
  assert.equal(w.call(w.a, 'close_year', { year: '2026', runId, idempotencyKey: key('sealed') }).error, 'year_already_closed');
});

test('§H-TENANT: another workspace\'s open run does not block this workspace', () => {
  const w = world();
  startRun(w, w.b, 'year_close', '2026');
  must(w.call(w.a, 'close_year', { year: '2026', idempotencyKey: key('tenant') }));
  assert.equal(w.call(w.b, 'close_year', { year: '2026', idempotencyKey: key('tenant-b') }).error, 'year_close_in_progress');
});

test('idempotency: a key that already sealed replays its result even once a run is open for the year', () => {
  const w = world();
  const k = key('replay');
  const first = must(w.call(w.a, 'close_year', { year: '2026', idempotencyKey: k }));
  // A run cannot be started on a sealed year, so plant an open one the way a race would leave it.
  w.store.db
    .prepare("INSERT INTO checklist_run (id, workspace_id, template_id, period_label, period_start, period_end, status, created_by, created_key, created_at) VALUES ('chkrun_race', ?, 'year_close', '2026', '2026-01-01', '2026-12-31', 'open', 'studio', 'race', '2027-02-15T09:00:00.000Z')")
    .run(w.a);
  assert.deepEqual(w.call(w.a, 'close_year', { year: '2026', idempotencyKey: k }), first);
  assert.deepEqual(w.call(w.a, 'close_year', { year: '2026', runId: 'chkrun_race', idempotencyKey: k }), first);
});
