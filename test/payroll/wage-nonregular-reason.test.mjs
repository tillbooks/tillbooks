// A34 money path: the reason and the audit of a non-regular payroll run (D173, owner decision Q14,
// 15.10.2026).
//
// `payroll.nonregular_reason` = none | correction (default) | all decides when a bonus, 13th-salary or
// correction run needs a non-blank `runKindReason`; without one it is refused `reason_required` on every
// face (engine and preview, MCP, REST), writing nothing. The reason, when given, goes into the entry
// description. EVERY non-regular post writes one audit row whose entity kind names the run kind
// (`payroll_run_bonus`, `payroll_run_thirteenth`, `payroll_run_correction`), whatever the setting; a
// replay writes no second one. Q13: supplementary with a non-regular run stays allowed.
//
// SYNTHETIC BY CONSTRUCTION: no employee, no name, no AHV number; an invented aggregate on the shipped
// KMU chart.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wageJournalPost } from '../../dist/core/payroll/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { settingDef } from '../../dist/core/settings/registry.js';
import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';

/** The MCP face through the transport dispatch (`runGoverned`), as an agent host calls it. */
const mcpCall = (deps, input) => JSON.parse(callTool(deps, 'wage_journal_post', input).content[0].text);
import { fixture } from '../api/conformance-contract.mjs';
import { makeContext } from '../../dist/core/context.js';
import { setup, counts, wageLines, secondWorkspace } from './support.mjs';

const DATE = '2026-12-05';
const KEY = 'payroll.nonregular_reason';
const KINDS = ['bonus', 'thirteenth', 'correction'];
const AUDIT = { bonus: 'payroll_run_bonus', thirteenth: 'payroll_run_thirteenth', correction: 'payroll_run_correction' };

function must(res, what = 'call') {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}
const post = (ctx, key, extra = {}) =>
  wageJournalPost(ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: key, ...extra });
const preview = (ctx, extra = {}) => wageJournalPost(ctx, { lines: wageLines(), entryDate: DATE, idempotencyKey: 'pv', ...extra });
const setMode = (ctx, value) => must(settingsSet(ctx, { key: KEY, value, reason: 'Testfall', idempotencyKey: `m-${value}` }), `set ${value}`);
const audits = (t, kind) =>
  t.store.db.prepare('SELECT entity_id AS id, actor FROM audit_log WHERE workspace_id = ? AND entity_kind = ? ORDER BY rowid').all(t.workspaceId, kind);
const description = (t, entryId) => t.store.db.prepare('SELECT description FROM journal_entry WHERE id = ?').get(entryId).description;

/** Whether `mode` requires a reason for `kind`: the decided table. */
const requires = (mode, kind) => mode === 'all' || (mode === 'correction' && kind === 'correction');

test('D173 Q14 registry: payroll.nonregular_reason is none | correction | all, default correction, owned by post, drafted under post', () => {
  const s = settingDef(KEY);
  assert.deepEqual(s.schema, { type: 'enum', values: ['none', 'correction', 'all'] });
  assert.equal(s.default, 'correction');
  assert.equal(s.owningCapability, 'post');
  assert.equal(s.dialCapability, 'post');
});

for (const mode of ['default', 'none', 'correction', 'all']) {
  test(`D173 Q14 setting ${mode}: each kind without a reason is refused or posts as decided, with or without the reason`, () => {
    const t = setup();
    if (mode !== 'default') setMode(t.ctx, mode);
    const effective = mode === 'default' ? 'correction' : mode;
    for (const kind of KINDS) {
      const before = counts(t.store, t.workspaceId);
      const auditBefore = audits(t, AUDIT[kind]).length;
      for (const blank of [undefined, '', '  ']) {
        const extra = { runKind: kind, ...(blank === undefined ? {} : { runKindReason: blank }) };
        const res = post(t.ctx, `${kind}-${String(blank)}`, extra);
        const pv = preview(t.ctx, extra);
        if (requires(effective, kind)) {
          assert.equal(res.error, 'reason_required', `${mode}/${kind}: refused`);
          assert.equal(res.field, 'runKindReason');
          assert.equal(pv.error, 'reason_required', `${mode}/${kind}: the preview refuses too`);
          assert.deepEqual(counts(t.store, t.workspaceId), before, `${mode}/${kind}: nothing written`);
          assert.equal(audits(t, AUDIT[kind]).length, auditBefore, `${mode}/${kind}: no audit row for a refusal`);
        } else {
          must(res, `${mode}/${kind} without a reason`);
          must(pv, `${mode}/${kind} preview`);
          break; // one accepted post per kind is enough for the "not required" branch
        }
      }
      const withReason = must(post(t.ctx, `${kind}-r`, { runKind: kind, runKindReason: 'Nachzahlung Dezember', description: 'Lohn' }), `${mode}/${kind} with a reason`);
      assert.equal(withReason.runKindReason, 'Nachzahlung Dezember');
      assert.match(description(t, withReason.postedEntryId), /^Lohn \((Bonus|13\. Monatslohn|Korrektur): Nachzahlung Dezember\)$/);
    }
  });
}

test('D173 Q14 audit: every non-regular post writes exactly one audit row naming its kind, even when no reason is required; a replay writes none', () => {
  const t = setup();
  setMode(t.ctx, 'none');
  for (const kind of KINDS) {
    const p = must(post(t.ctx, `a-${kind}`, { runKind: kind }), kind);
    assert.deepEqual(audits(t, AUDIT[kind]).map((a) => a.id), [p.wageJournalPostId], `${kind}: one row, on the posting`);
    assert.equal(audits(t, AUDIT[kind])[0].actor, t.ctx.actor, `${kind}: the actor`);
    const before = counts(t.store, t.workspaceId);
    must(post(t.ctx, `a-${kind}`, { runKind: kind }), `${kind} replay`);
    assert.equal(audits(t, AUDIT[kind]).length, 1, `${kind}: the replay writes no second audit row`);
    assert.deepEqual(counts(t.store, t.workspaceId), before);
  }
  // A regular post writes no run-kind audit row, and a regular run takes no run-kind reason.
  const reg = must(post(t.ctx, 'reg'));
  for (const kind of KINDS) assert.ok(!audits(t, AUDIT[kind]).some((a) => a.id === reg.wageJournalPostId));
  assert.equal(post(t.ctx, 'reg-r', { runKindReason: 'wozu' }).error, 'invalid_input');
});

test('D173 Q14 §H-TENANT: another workspace set to none does not loosen this one, and its audit rows stay its own', () => {
  const t = setup();
  const other = secondWorkspace(t);
  setMode(other.ctx, 'none');
  must(wageJournalPost(other.ctx, { lines: wageLines(), entryDate: DATE, confirm: true, runKind: 'correction', idempotencyKey: 'o' }), 'other book: no reason needed');
  assert.equal(post(t.ctx, 'c', { runKind: 'correction' }).error, 'reason_required', 'this book keeps the default');
  assert.equal(audits(t, AUDIT.correction).length, 0, 'the other book\'s audit row is not here');
});

test('D173 Q13: supplementary with a non-regular run stays allowed, both reasons kept', () => {
  const t = setup();
  const p = must(post(t.ctx, 's', { runKind: 'correction', runKindReason: 'Satz falsch', supplementary: true, supplementaryReason: 'zweite Korrektur', description: 'Lohn' }));
  assert.equal(description(t, p.postedEntryId), 'Lohn (Nachtragsbuchung: zweite Korrektur; Korrektur: Satz falsch)');
  assert.equal(audits(t, 'payroll_supplementary').length, 1);
  assert.equal(audits(t, AUDIT.correction).length, 1);
});

test('D173 Q14 faces: a required reason missing is reason_required on REST and MCP (never drafted); with it the post goes through', () => {
  const fx = fixture();
  const lines = [
    { accountNumber: '5000', debitMinor: 500000 },
    { accountNumber: '5700', debitMinor: 50000 },
    { accountNumber: '2260', creditMinor: 550000 },
  ];
  const base = { workspaceId: fx.workspaceId, lines, entryDate: DATE, confirm: true, runKind: 'correction' };
  const rest = handleRest('wage_journal_post', { ...base, idempotencyKey: 'f-rest' }, fx.deps).body;
  assert.equal(rest.error, 'reason_required', JSON.stringify(rest));
  const mcp = mcpCall(fx.deps, { ...base, runKindReason: '   ', idempotencyKey: 'f-mcp' });
  assert.equal(mcp.error, 'reason_required', JSON.stringify(mcp));
  const pv = handleRest('wage_journal_post', { ...base, confirm: undefined, idempotencyKey: 'f-pv' }, fx.deps).body;
  assert.equal(pv.error, 'reason_required', 'the preview face refuses too');
  const okRest = handleRest('wage_journal_post', { ...base, runKindReason: 'Satz falsch', idempotencyKey: 'f-ok' }, fx.deps).body;
  assert.equal(okRest.ok, true, JSON.stringify(okRest));
  assert.equal(getAction('wage_journal_post').inputSchema.properties.runKindReason.type, 'string');
});

test('critic r3: a replay returns the stored original even after the reason setting was tightened (engine)', () => {
  const t = setup();
  const first = must(post(t.ctx, 'k1', { runKind: 'bonus' }), 'bonus without a reason under the default');
  const before = counts(t.store, t.workspaceId);
  setMode(t.ctx, 'all');
  const replay = post(t.ctx, 'k1', { runKind: 'bonus' });
  assert.equal(replay.ok, true, `the replay answers the stored result: ${JSON.stringify(replay)}`);
  assert.equal(replay.wageJournalPostId, first.wageJournalPostId);
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'nothing written');
  assert.equal(audits(t, AUDIT.bonus).length, 1, 'no second audit row');
  // A FRESH call under the tightened setting is still refused.
  assert.equal(post(t.ctx, 'k2', { runKind: 'bonus' }).error, 'reason_required');
});

test('critic r3: the same replay on the REST and MCP faces returns the stored original; a fresh call is refused', () => {
  const fx = fixture();
  const lines = [
    { accountNumber: '5000', debitMinor: 500000 },
    { accountNumber: '5700', debitMinor: 50000 },
    { accountNumber: '2260', creditMinor: 550000 },
  ];
  const base = { workspaceId: fx.workspaceId, lines, entryDate: DATE, confirm: true, runKind: 'bonus' };
  const firstRest = handleRest('wage_journal_post', { ...base, idempotencyKey: 'k-rest' }, fx.deps).body;
  assert.equal(firstRest.ok, true, JSON.stringify(firstRest));
  const firstMcp = mcpCall(fx.deps, { ...base, idempotencyKey: 'k-mcp' });
  assert.equal(firstMcp.ok, true, JSON.stringify(firstMcp));
  const ctx = makeContext(fx.deps.store, { workspaceId: fx.workspaceId, actor: 'studio', clock: fx.deps.clock, ids: fx.deps.ids });
  must(settingsSet(ctx, { key: KEY, value: 'all', reason: 'strenger', idempotencyKey: 'tighten' }), 'tighten');
  const replayRest = handleRest('wage_journal_post', { ...base, idempotencyKey: 'k-rest' }, fx.deps).body;
  assert.notEqual(replayRest.error, 'reason_required', JSON.stringify(replayRest));
  // The agent seat drafts: the replay answers the SAME Vorschlag (only `replayed` differs).
  const same = (a, b) => assert.deepEqual({ ...a, replayed: undefined }, { ...b, replayed: undefined });
  same(replayRest, firstRest);
  const replayMcp = mcpCall(fx.deps, { ...base, idempotencyKey: 'k-mcp' });
  same(replayMcp, firstMcp);
  assert.equal(handleRest('wage_journal_post', { ...base, idempotencyKey: 'k-fresh' }, fx.deps).body.error, 'reason_required');
  // A human seat executes: post under the loosened setting, tighten, replay on REST and MCP.
  const human = { ...fx.deps, actor: 'studio' };
  must(settingsSet(ctx, { key: KEY, value: 'none', reason: 'lockerer', idempotencyKey: 'loosen' }), 'loosen');
  const ranRest = handleRest('wage_journal_post', { ...base, idempotencyKey: 'h-rest' }, human).body;
  assert.equal(typeof ranRest.wageJournalPostId, 'string', `executed, not drafted: ${JSON.stringify(ranRest)}`);
  const ranMcp = mcpCall(human, { ...base, idempotencyKey: 'h-mcp' });
  assert.equal(typeof ranMcp.wageJournalPostId, 'string', JSON.stringify(ranMcp));
  must(settingsSet(ctx, { key: KEY, value: 'all', reason: 'wieder strenger', idempotencyKey: 'tighten2' }), 'tighten again');
  assert.deepEqual(handleRest('wage_journal_post', { ...base, idempotencyKey: 'h-rest' }, human).body, ranRest, 'REST replays the executed original');
  assert.deepEqual(mcpCall(human, { ...base, idempotencyKey: 'h-mcp' }), ranMcp, 'MCP replays the executed original');
  assert.equal(handleRest('wage_journal_post', { ...base, idempotencyKey: 'h-fresh' }, human).body.error, 'reason_required');
  assert.equal(mcpCall(fx.deps, { ...base, idempotencyKey: 'k-fresh2' }).error, 'reason_required');
});

// critic r4: the "key already used" lookup of the pre-draft check is scoped to the workspace and ignores a
// stale Vorschlag; each test kills one of those two conditions.
const R4_LINES = [
  { accountNumber: '5000', debitMinor: 500000 },
  { accountNumber: '5700', debitMinor: 50000 },
  { accountNumber: '2260', creditMinor: 550000 },
];
const draftsUnder = (fx, workspaceId, key) =>
  fx.deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND action_tool = 'wage_journal_post' AND idempotency_key = ?")
    .get(workspaceId, key).n;

test('critic r4 §H-TENANT: a same-key Vorschlag in workspace A does not let a reasonless call in workspace B (setting all) be drafted', () => {
  const fx = fixture();
  const a = { workspaceId: fx.workspaceId, lines: R4_LINES, entryDate: DATE, confirm: true, runKind: 'bonus', idempotencyKey: 'shared' };
  const drafted = handleRest('wage_journal_post', a, fx.deps).body;
  assert.equal(drafted.drafted, true, `workspace A drafts the bonus (no reason needed by default): ${JSON.stringify(drafted)}`);
  const human = { ...fx.deps, actor: 'studio' };
  const wsB = getAction('create_workspace').run(human, { name: 'Nachbar Lohn AG', idempotencyKey: 'ws-b' });
  assert.equal(wsB.ok, true, JSON.stringify(wsB));
  const ctxB = makeContext(fx.deps.store, { workspaceId: wsB.workspaceId, actor: 'studio', clock: fx.deps.clock, ids: fx.deps.ids });
  must(settingsSet(ctxB, { key: KEY, value: 'all', reason: 'streng', idempotencyKey: 'b-all' }), 'B to all');
  const b = { ...a, workspaceId: wsB.workspaceId };
  assert.equal(handleRest('wage_journal_post', b, fx.deps).body.error, 'reason_required', 'REST in B is refused');
  assert.equal(mcpCall(fx.deps, b).error, 'reason_required', 'MCP in B is refused');
  assert.equal(draftsUnder(fx, wsB.workspaceId, 'shared'), 0, 'no Vorschlag added in B');
  assert.equal(draftsUnder(fx, fx.workspaceId, 'shared'), 1, 'A still holds its one');
});

test('critic r4: a stale Vorschlag under the key does not count as a replay; the reasonless call (setting all) is refused, nothing added', () => {
  const fx = fixture();
  const call = { workspaceId: fx.workspaceId, lines: R4_LINES, entryDate: DATE, confirm: true, runKind: 'bonus', idempotencyKey: 'went-stale' };
  const drafted = handleRest('wage_journal_post', call, fx.deps).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  fx.deps.store.db.prepare("UPDATE agent_action SET status = 'stale' WHERE workspace_id = ? AND idempotency_key = ?").run(fx.workspaceId, 'went-stale');
  const ctx = makeContext(fx.deps.store, { workspaceId: fx.workspaceId, actor: 'studio', clock: fx.deps.clock, ids: fx.deps.ids });
  must(settingsSet(ctx, { key: KEY, value: 'all', reason: 'streng', idempotencyKey: 'to-all' }), 'to all');
  assert.equal(handleRest('wage_journal_post', call, fx.deps).body.error, 'reason_required', 'REST is refused');
  assert.equal(mcpCall(fx.deps, call).error, 'reason_required', 'MCP is refused');
  assert.equal(draftsUnder(fx, fx.workspaceId, 'went-stale'), 1, 'only the stale row: no new Vorschlag');
});
