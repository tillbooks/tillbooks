// N04 (D183), Dauerbuchungen: a Vorlage runs on a schedule, proposing (default) or posting, and recurring
// invoices are generated as drafts by the scheduler. The INVARIANTS a non-author critic reviews, each named
// in its test title:
//   S1 no double booking: one run per (workspace, series, PERIOD), across a re-run, a clear and re-set, a
//      second schedule, a cadence change, an approval and a re-tick;
//   S2 post is a person's act, checked LIVE at each run; catch-up periods and a changed Vorlage propose;
//   S3 due dates across month ends and leap years (A12 arithmetic, the 31st returns after a short month);
//   S4 a locked period and a cleared Vorlage skip with a note, never silently;
//   S5 recurring invoices: draft (default) never issues, honour_auto_issue follows the schedule, off does nothing.
//
// SYNTHETIC DATA ONLY: invented accounts and amounts in a fresh book.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { callTool } from '../../dist/api/mcp.js';
import { createScheduler } from '../../dist/api/scheduler.js';
import { makeContext } from '../../dist/core/context.js';
import { setBankStandard, clearBankStandard } from '../../dist/core/banking/bankStandards.js';
import { softCloseMonth } from '../../dist/core/ledger/index.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { approveDraftedAction } from '../../dist/core/agent/draftedActions.js';
import {
  dueDates,
  nextDueDate,
  periodOf,
  periodBounds,
  setVorlageSchedule,
  clearVorlageSchedule,
  listVorlageSchedules,
  runDauerbuchungenStep,
  scheduleRunNotes,
} from '../../dist/core/ledger/vorlageSchedule.js';
import { world, must, refused, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { ATTENTION_PROVIDERS } from '../../dist/core/attention/index.js';

afterEach(assertClaimInvariantHolds);

const at = (t, iso) => {
  t.clock.now = () => iso;
};
const leg = (t, number, side, amount) => ({ accountId: t.acc(number), taxCode: null, side, amount });
const RENT = 250000;

/** A world with a Vorlage "Miete" (6000 an 2800, the amount asked) and the scheduler's Dauerbuchungen step. */
function vorlageWorld() {
  const t = world();
  const vorlage = must(setBankStandard(t.ctx, { scope: 'manual', label: 'Miete', legs: [leg(t, '6000', 'debit', { kind: 'ask', label: 'Miete' }), leg(t, '2800', 'credit', { kind: 'rest' })], idempotencyKey: 'v-miete' })).standard.id;
  const scheduler = createScheduler(t.deps, { listWorkspaceIds: () => [t.workspaceId], runDue: () => undefined, bankAutoSync: false, ruleMiner: false, belegeingang: false, autobook: false, recurringInvoices: false });
  return { ...t, vorlage, tick: () => scheduler.autopilotTickOnce(t.workspaceId) };
}

let keys = 0;
const schedule = (t, input, ctx = t.ctx) => setVorlageSchedule(ctx, { vorlageId: t.vorlage, every: 'month', anchorDay: 31, start: '2026-01-01', mode: 'propose', asks: { 0: RENT }, idempotencyKey: `s-${(keys += 1)}`, ...input });
const runRows = (t) => t.store.db.prepare('SELECT * FROM vorlage_schedule_run WHERE workspace_id = ? ORDER BY period').all(t.workspaceId);
const periods = (t) => runRows(t).map((r) => `${r.period}:${r.outcome}${r.reason ? ':' + r.reason : ''}`);
const proposals = (t) => t.store.db.prepare("SELECT * FROM agent_action WHERE workspace_id = ? AND action_tool = 'post_entry' AND actor = 'system' ORDER BY rowid").all(t.workspaceId);
const posted = (t) => t.store.db.prepare("SELECT id, date FROM journal_entry WHERE workspace_id = ? AND status = 'posted' ORDER BY date").all(t.workspaceId);
const approve = (t, actionId) => must(approveDraftedAction(makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids }), (tool, input, actor) => getAction(tool).run({ ...t.deps, actor }, input), { actionId }));
const editVorlage = (t, key) => must(setBankStandard(t.ctx, { scope: 'manual', standardId: liveVorlage(t), label: 'Miete', legs: [leg(t, '6500', 'debit', { kind: 'ask', label: 'Miete' }), leg(t, '2800', 'credit', { kind: 'rest' })], idempotencyKey: key })).standard.id;
const liveVorlage = (t) => t.store.db.prepare("SELECT id FROM bank_standard WHERE workspace_id = ? AND scope = 'manual' AND superseded_at IS NULL ORDER BY rowid DESC").get(t.workspaceId).id;

// ================================================================================================
// S3 dates
// ================================================================================================

test('S3 due dates: the 31st clamps to each month end and returns after February; leap years keep the 29th', () => {
  const monthly = { every: 'month', anchorDay: 31, startDate: '2026-01-01', endDate: null };
  assert.deepEqual(dueDates(monthly, '2026-05-31'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  assert.deepEqual(dueDates({ ...monthly, startDate: '2028-01-15' }, '2028-03-31'), ['2028-01-31', '2028-02-29', '2028-03-31'], '2028 is a leap year');
  assert.deepEqual(dueDates({ every: 'quarter', anchorDay: 31, startDate: '2026-03-01', endDate: null }, '2026-12-31'), ['2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31']);
  assert.deepEqual(dueDates({ every: 'year', anchorDay: 29, startDate: '2028-02-01', endDate: null }, '2030-12-31'), ['2028-02-29', '2029-02-28', '2030-02-28']);
  assert.deepEqual(dueDates({ ...monthly, endDate: '2026-03-30' }, '2026-12-31'), ['2026-01-31', '2026-02-28'], 'the end date is the last day a run may fall on');
  assert.equal(nextDueDate(monthly, '2026-02-28'), '2026-03-31');
  assert.equal(nextDueDate({ ...monthly, endDate: '2026-02-28' }, '2026-02-28'), null);
  assert.deepEqual([periodOf('2026-02-28', 'month'), periodOf('2026-05-31', 'quarter'), periodOf('2026-12-31', 'year')], ['2026-02', '2026-Q2', '2026']);
  assert.deepEqual(periodBounds('2028-02'), { start: '2028-02-01', end: '2028-02-29' });
  assert.deepEqual(periodBounds('2026-Q4'), { start: '2026-10-01', end: '2026-12-31' });
});

// ================================================================================================
// Propose (the default) and catch-up
// ================================================================================================

test('propose: every missed period is drafted once as system, dated its due date, keyed schedule:<series>:<period>', () => {
  const t = vorlageWorld();
  const s = must(schedule(t, {})).schedule;
  assert.equal(s.mode, 'propose');
  at(t, '2026-03-15T08:00:00.000Z');
  t.tick();
  t.tick();
  assert.deepEqual(periods(t), ['2026-01:proposed', '2026-02:proposed'], 'catch-up: every missed period, once');
  const [jan, feb] = proposals(t);
  assert.deepEqual(
    { key: jan.idempotency_key, dial: jan.dial_capability, date: JSON.parse(jan.payload_json).date },
    { key: `schedule:${t.vorlage}:2026-01`, dial: null, date: '2026-01-31' },
  );
  assert.equal(JSON.parse(feb.payload_json).date, '2026-02-28');
  assert.equal(posted(t).length, 0, 'propose never posts');
  approve(t, jan.id);
  t.tick();
  assert.deepEqual(posted(t).map((e) => e.date), ['2026-01-31']);
  assert.equal(proposals(t).length, 2, 'an approval and a re-tick draft nothing new');
  const listed = must(listVorlageSchedules(t.ctx, { vorlageId: t.vorlage })).schedules[0];
  assert.equal(listed.nextRun, '2026-03-31', 'Nächste Ausführung');
});

// ================================================================================================
// S1 no double booking
// ================================================================================================

test('S1 one run per (series, period): a clear and re-set, a second schedule, and the schema itself', () => {
  const t = vorlageWorld();
  const first = must(schedule(t, {})).schedule;
  at(t, '2026-02-10T08:00:00.000Z');
  t.tick();
  must(clearVorlageSchedule(t.ctx, { scheduleId: first.scheduleId, idempotencyKey: 'clr' }));
  const reset = must(schedule(t, { anchorDay: 5 })).schedule;
  const replacing = must(schedule(t, { anchorDay: 1 }));
  assert.equal(replacing.replacedScheduleId, reset.scheduleId, 'one live schedule per series: a second one replaces it');
  assert.equal(must(listVorlageSchedules(t.ctx, {})).schedules.filter((x) => x.status === 'active').length, 1);
  t.tick();
  at(t, '2026-03-02T08:00:00.000Z');
  t.tick();
  assert.deepEqual(periods(t), ['2026-01:proposed', '2026-02:proposed', '2026-03:proposed'], 'January ran under the first schedule and never again; February and March once each, across three schedule rows');
  assert.throws(
    () =>
      t.store.db
        .prepare("INSERT INTO vorlage_schedule_run (id, workspace_id, series_id, period, due_date, schedule_id, outcome, reason, created_at, updated_at) VALUES ('x', ?, ?, '2026-03', '2026-03-01', ?, 'skipped', 'period_locked', ?, ?)")
        .run(t.workspaceId, t.vorlage, replacing.schedule.scheduleId, '2026-03-02', '2026-03-02'),
    /UNIQUE/,
  );
});

test('S1 cadence change: a monthly series re-set to quarterly starts at the first quarter after its latest run month', () => {
  const t = vorlageWorld();
  must(schedule(t, {}));
  at(t, '2026-02-28T08:00:00.000Z');
  t.tick();
  assert.deepEqual(periods(t), ['2026-01:proposed', '2026-02:proposed']);
  must(schedule(t, { every: 'quarter', anchorDay: 31 }));
  at(t, '2026-07-01T08:00:00.000Z');
  t.tick();
  assert.deepEqual(periods(t), ['2026-01:proposed', '2026-02:proposed', '2026-Q2:proposed'], 'Q1 holds February: never twice beats never skipped');
});

test('S1 a moved anchor day inside a period that already ran books nothing more in that period', () => {
  const t = vorlageWorld();
  must(schedule(t, { anchorDay: 1 }));
  at(t, '2026-01-20T08:00:00.000Z');
  t.tick();
  must(schedule(t, { anchorDay: 25 }));
  at(t, '2026-01-31T08:00:00.000Z');
  t.tick();
  assert.deepEqual(periods(t), ['2026-01:proposed']);
});

// ================================================================================================
// S2 post
// ================================================================================================

test('S2 post: the current period posts as the person who set it; older catch-up periods are proposed', () => {
  const t = vorlageWorld();
  must(schedule(t, { mode: 'post' }));
  at(t, '2026-03-31T08:00:00.000Z');
  t.tick();
  t.tick();
  assert.deepEqual(periods(t), ['2026-01:proposed:catch_up', '2026-02:proposed:catch_up', '2026-03:posted']);
  const [entry] = posted(t);
  assert.equal(entry.date, '2026-03-31');
  const by = t.store.db.prepare('SELECT created_by FROM journal_entry WHERE id = ?').get(entry.id).created_by;
  assert.equal(by, 'user_1', 'posted as the person, never as system');
  const memo = t.store.db.prepare("SELECT key FROM idempotency WHERE workspace_id = ? AND verb = 'post_entry'").all(t.workspaceId).map((r) => r.key);
  assert.ok(memo.some((k) => k.includes(`schedule:${t.vorlage}:2026-03`)), JSON.stringify(memo));
});

test('S2 post right checked live: a person who lost post gets a Vorschlag and a note instead', () => {
  const t = vorlageWorld();
  must(schedule(t, { mode: 'post', start: '2026-03-01' }));
  at(t, '2026-03-31T08:00:00.000Z');
  const report = runDauerbuchungenStep(makeContext(t.store, { workspaceId: t.workspaceId, actor: 'system', clock: t.clock, ids: t.ids }), {
    post: () => assert.fail('a person without post never posts'),
    holdsPost: () => false,
  });
  assert.deepEqual(report.runs.map((r) => [r.period, r.outcome, r.reason]), [['2026-03', 'proposed', 'no_post_right']]);
  assert.deepEqual(scheduleRunNotes(t.ctx).map((n) => n.reason), ['no_post_right']);
});

test('S2 an edited Vorlage drops post to propose until a person sets it again; a stale Vorschlag is re-proposed from the live version', () => {
  const t = vorlageWorld();
  must(schedule(t, { mode: 'post', start: '2026-03-01' }));
  const v2 = editVorlage(t, 'edit-1');
  at(t, '2026-03-31T08:00:00.000Z');
  t.tick();
  assert.deepEqual(periods(t), ['2026-03:proposed:vorlage_changed']);
  assert.equal(posted(t).length, 0, 'an edit never posts unattended');
  const [mar] = proposals(t);
  assert.equal(JSON.parse(mar.payload_json).template.standardId, v2, 'the run reads the live version');
  const v3 = editVorlage(t, 'edit-2');
  t.tick();
  const run = runRows(t)[0];
  assert.equal(run.version_id, v3, 'the run is re-pointed at the re-proposal');
  assert.equal(proposals(t).filter((p) => p.status === 'pending').length, 1, 'one live Vorschlag for the period');
  approve(t, run.action_id);
  t.tick();
  assert.equal(posted(t).length, 1);
  assert.equal(runRows(t).length, 1, 'still one run for March');
});

test('S2 an agent is refused mode post (human_only) but may set a schedule that proposes', () => {
  const t = vorlageWorld();
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  refused(schedule(t, { mode: 'post' }, agentCtx), 'human_only');
  const viaMcp = JSON.parse(callTool({ ...t.deps, actor: 'agent' }, 'set_vorlage_schedule', { workspaceId: t.workspaceId, vorlageId: t.vorlage, every: 'month', anchorDay: 1, start: '2026-01-01', mode: 'post', asks: { 0: RENT }, idempotencyKey: 'agent-post' }).content[0].text);
  assert.equal(viaMcp.ok, false, JSON.stringify(viaMcp));
  assert.equal(viaMcp.error, 'human_only');
});

// ================================================================================================
// S4 locked, cleared
// ================================================================================================

test('S4 a locked period is skipped with a note; a cleared Vorlage skips and ends the schedule', () => {
  const t = vorlageWorld();
  must(softCloseMonth(t.ctx, { period: '2026-01', idempotencyKey: 'close-jan' }));
  must(schedule(t, {}));
  at(t, '2026-02-28T08:00:00.000Z');
  t.tick();
  assert.deepEqual(periods(t), ['2026-01:skipped:period_locked', '2026-02:proposed']);
  assert.deepEqual(scheduleRunNotes(t.ctx).map((n) => [n.period, n.reason]), [['2026-01', 'period_locked']]);
  must(clearBankStandard(t.ctx, { standardId: liveVorlage(t), idempotencyKey: 'clear-v' }));
  at(t, '2026-03-31T08:00:00.000Z');
  t.tick();
  t.tick();
  assert.deepEqual(periods(t).slice(-1), ['2026-03:skipped:vorlage_cleared']);
  assert.equal(must(listVorlageSchedules(t.ctx, {})).schedules[0].status, 'ended');
  assert.equal(posted(t).length, 0);
});

// ================================================================================================
// S5 recurring invoices
// ================================================================================================

function recurringWorld(autoIssue) {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const human = (name, input) => getAction(name).run({ ...deps, actor: 'studio' }, { workspaceId, ...input });
  assert.equal(human('vat_seed_defaults', {}).ok, true);
  assert.equal(human('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }).ok, true);
  const abo = human('create_contact', { partyRole: 'customer', name: 'Abo Beispiel AG', idempotencyKey: 'c-abo' });
  const created = human('create_recurring_schedule', {
    contactId: abo.contact.id,
    lines: [{ description: 'Abo', unitPriceMinor: 10000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-16',
    dueDays: 30,
    autoIssue,
    idempotencyKey: 'h-sched',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const scheduler = createScheduler(deps, { listWorkspaceIds: () => [workspaceId], runDue: () => undefined, bankAutoSync: false, ruleMiner: false, belegeingang: false, autobook: false, dauerbuchungen: false });
  const statuses = () => deps.store.db.prepare("SELECT status FROM document WHERE workspace_id = ? AND type = 'invoice'").all(workspaceId).map((r) => r.status);
  const set = (value) => assert.equal(human('settings_set', { key: 'recurring.auto_generate', value, reason: 'N04 test', idempotencyKey: `rag-${value}` }).ok, true);
  return { tick: () => scheduler.autopilotTickOnce(workspaceId), statuses, set };
}

test('S5 recurring invoices: draft (default) never issues even an autoIssue schedule; honour_auto_issue issues; off does nothing', () => {
  const draft = recurringWorld(true);
  draft.tick();
  draft.tick();
  assert.deepEqual(draft.statuses(), ['draft'], 'the default generates the due invoice as a draft, once');
  const honour = recurringWorld(true);
  honour.set('honour_auto_issue');
  honour.tick();
  assert.equal(honour.statuses().length, 1);
  assert.notEqual(honour.statuses()[0], 'draft', 'the schedule asked to issue, and the setting honours it');
  const review = recurringWorld(false);
  review.set('honour_auto_issue');
  review.tick();
  assert.deepEqual(review.statuses(), ['draft'], 'a review schedule stays a draft under honour_auto_issue');
  const off = recurringWorld(true);
  off.set('off');
  off.tick();
  assert.deepEqual(off.statuses(), [], 'off generates nothing');
});

test('S5 the recurring setting is human-only: an agent cannot switch it', () => {
  const t = vorlageWorld();
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  refused(settingsSet(agentCtx, { key: 'recurring.auto_generate', value: 'honour_auto_issue', reason: 'agent', idempotencyKey: 'ag' }), 'human_only');
  refused(settingsSet(agentCtx, { key: 'rules.autobook_amount_headroom', value: 500, reason: 'agent', idempotencyKey: 'ag2' }), 'human_only');
});

test('critic F5: a schedule an agent set keeps at most rules.vorlage_agent_open_max Vorschläge waiting, none skipped, and its card names the agent', () => {
  const t = vorlageWorld();
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  must(schedule(t, { start: '2024-01-01' }, agentCtx));
  at(t, '2026-03-15T08:00:00.000Z');
  t.tick();
  t.tick();
  assert.deepEqual(periods(t), ['2024-01:proposed', '2024-02:proposed', '2024-03:proposed'], 'three waiting (the default), not 24 a tick');
  approve(t, runRows(t)[0].action_id);
  t.tick();
  assert.deepEqual(periods(t).slice(-1), ['2024-04:proposed'], 'the next period follows once a person decided one');
  const items = ATTENTION_PROVIDERS.find((p) => p.queueId === 'agent_action').list(t.ctx, { limit: 50 });
  const card = items.find((i) => i.entityId === runRows(t)[1].action_id);
  assert.deepEqual(card.scheduledBy, { actor: 'agent', agent: true });
  // A person's schedule is bounded only by the per-tick catch-up cap.
  const u = vorlageWorld();
  must(schedule(u, { start: '2025-01-01' }));
  at(u, '2026-03-15T08:00:00.000Z');
  u.tick();
  assert.equal(runRows(u).length, 14);
});
