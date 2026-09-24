/**
 * A35 the trust read model and the dial map: the evidence the Vertrauen tab renders, and the closed
 * §H-ENUM maps the governed dispatch routes by. Data honesty is asserted where it is derived: every
 * payload states its window, the dash-versus-zero rule is derivable from the counts, and the
 * suggest threshold never fires over a rejection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { getAction } from '../../dist/api/registry.js';
import {
  DIAL_CAPABILITIES,
  DIAL_CAPABILITY_FOR_ACTION,
  CONSEQUENCE_FOR_ACTION,
  TRUST_SUGGEST_THRESHOLD,
} from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function rest(deps, name, input) {
  return handleRest(name, input, deps).body;
}

/** REST as a HUMAN (studio) seat: ungoverned, so the write runs directly and opens no session. */
function human(deps, name, input) {
  return handleRest(name, input, { ...deps, actor: 'studio' }).body;
}

function postArgs(workspaceId, accId, key) {
  return {
    workspaceId,
    date: '2026-06-12',
    source: 'manual',
    idempotencyKey: key,
    lines: [
      { account: accId('6500'), debit: 1000 },
      { account: accId('1020'), credit: 1000 },
    ],
  };
}

test('agent_trust_summary: one row per governed capability, every figure inside a stated window, counts on real rows', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);

  // Empty workspace: one row per governed capability (the closed set), all counts zero: the Studio renders `-`.
  const empty = rest(deps, 'agent_trust_summary', { workspaceId });
  assert.equal(empty.ok, true);
  assert.equal(empty.rows.length, DIAL_CAPABILITIES.length);
  assert.ok(typeof empty.window.from === 'string' && typeof empty.window.to === 'string', 'no figure without its window');
  for (const row of empty.rows) assert.deepEqual([row.proposed, row.approved, row.rejected, row.autoExecuted], [0, 0, 0, 0]);

  // One draft approved, one rejected, one auto execution: the counts land in the right columns.
  const d1 = rest(deps, 'post_entry', postArgs(workspaceId, accId, 't1'));
  const d2 = rest(deps, 'post_entry', postArgs(workspaceId, accId, 't2'));
  getAction('approve_drafted_action').run({ ...deps, actor: 'studio' }, { workspaceId, actionId: d1.actionId });
  getAction('reject_drafted_action').run({ ...deps, actor: 'studio' }, { workspaceId, actionId: d2.actionId });
  rest({ ...deps, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'tg' });
  rest(deps, 'post_entry', postArgs(workspaceId, accId, 't3'));

  const after = rest(deps, 'agent_trust_summary', { workspaceId });
  const post = after.rows.find((r) => r.capability === 'post');
  assert.equal(post.proposed, 2, 'two drafts were proposed');
  assert.equal(post.approved, 1);
  assert.equal(post.rejected, 1);
  assert.equal(post.autoExecuted, 1, 'the auto path counts through the trace, not the queue');
  assert.equal(post.stored, 'auto');
  assert.equal(post.effective, 'auto');
  assert.ok(post.lastAt !== null);

  // The dash-versus-zero rule is derivable: `dun` had nothing proposed (dash territory), `post` did.
  const dun = after.rows.find((r) => r.capability === 'dun');
  assert.equal(dun.proposed, 0);
  deps.store.close();
});

test('suggestGrant: fires only past the threshold with ZERO rejections, never on a granted capability', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);

  // TRUST_SUGGEST_THRESHOLD clean approvals.
  for (let i = 0; i < TRUST_SUGGEST_THRESHOLD; i += 1) {
    const drafted = rest(deps, 'post_entry', postArgs(workspaceId, accId, `sg-${i}`));
    const approved = getAction('approve_drafted_action').run(
      { ...deps, actor: 'studio' },
      { workspaceId, actionId: drafted.actionId },
    );
    assert.equal(approved.ok, true);
  }
  const clean = rest(deps, 'agent_trust_summary', { workspaceId });
  assert.equal(clean.rows.find((r) => r.capability === 'post').suggestGrant, true, 'earned by rhythm');
  assert.equal(clean.suggestThreshold, TRUST_SUGGEST_THRESHOLD);

  // One rejection kills the suggestion: a valve does not argue past a no.
  const d = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'sg-rej'));
  getAction('reject_drafted_action').run({ ...deps, actor: 'studio' }, { workspaceId, actionId: d.actionId });
  const rejected = rest(deps, 'agent_trust_summary', { workspaceId });
  assert.equal(rejected.rows.find((r) => r.capability === 'post').suggestGrant, false);

  // A granted capability needs no suggestion.
  rest({ ...deps, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: 'issue', level: 'auto', idempotencyKey: 'sg-g' });
  const granted = rest(deps, 'agent_trust_summary', { workspaceId });
  assert.equal(granted.rows.find((r) => r.capability === 'issue').suggestGrant, false);
  deps.store.close();
});

test('the dial map is closed and sane: real write verbs, real capabilities, no bare-tenant draftable', () => {
  for (const [name, capability] of Object.entries(DIAL_CAPABILITY_FOR_ACTION)) {
    const action = getAction(name);
    assert.ok(action !== undefined, `${name}: the dial map names a verb that exists`);
    assert.equal(action.kind, 'write', `${name}: only writes are dial-governed`);
    assert.ok(DIAL_CAPABILITIES.includes(capability), `${name}: '${capability}' is a real dial capability`);
    const extraRequired = action.inputSchema.required.filter((f) => f !== 'workspaceId');
    assert.ok(extraRequired.length > 0, `${name}: at least one required field beyond the tenant, so a bare probe cannot draft`);
  }
  // Every dial-capability family is populated (the "at least one verb per governed family" gate).
  const covered = new Set(Object.values(DIAL_CAPABILITY_FOR_ACTION));
  for (const capability of DIAL_CAPABILITIES) assert.ok(covered.has(capability), `family '${capability}' has a verb`);
});

test('ActionDef.consequence: every mapped verb carries its sentence, and only real verbs are named', () => {
  for (const name of Object.keys(DIAL_CAPABILITY_FOR_ACTION)) {
    const action = getAction(name);
    assert.equal(typeof action.consequence, 'string', `${name}: a dial-governed verb states its consequence`);
    assert.ok(action.consequence.length > 20, `${name}: a consequence is a sentence, not a label`);
  }
  for (const name of Object.keys(CONSEQUENCE_FOR_ACTION)) {
    assert.ok(getAction(name) !== undefined, `${name}: CONSEQUENCE_FOR_ACTION names only registered verbs`);
  }
});

test('the two D-added dial capabilities exist and each governs its named cutover verbs', () => {
  // close-period seals a period; go-live is the migration cutover. Both are closed §H-ENUM members.
  assert.ok(DIAL_CAPABILITIES.includes('close-period'), 'close-period is a real dial capability');
  assert.ok(DIAL_CAPABILITIES.includes('go-live'), 'go-live is a real dial capability');
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.close_year, 'close-period');
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.lock_period, 'close-period');
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.go_productive, 'go-live');
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.import_open_items, 'go-live');
  // F-08 (b), 2026-09-05: the soft, reversible period verbs are GOVERNED too. "A soft close carries no
  // engine consequence" was the earlier reading, and J4.6 measured its cost: an ungoverned close_month
  // ran before the human approved the drafted revaluation, and the approval then failed period_locked.
  // Sealing a month against posting, and undoing a human's seal, are governed acts either way.
  for (const soft of ['close_month', 'reopen_month', 'unlock_period']) {
    assert.equal(DIAL_CAPABILITY_FOR_ACTION[soft], 'close-period', `${soft} is governed under close-period`);
  }
});

test('a newly-mapped verb DRAFTS under the dial for the agent seat, writing nothing (close-period, go-live, pay)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  // close-period: lock_period at the default `ask` dial drafts. Its period_lock row is NOT written.
  const lock = rest(deps, 'lock_period', { workspaceId, period: '2026-06', kind: 'hard', idempotencyKey: 'd-lock' });
  assert.equal(lock.ok, true);
  assert.equal(lock.drafted, true, 'an ungranted agent lock_period drafts, never seals');
  assert.equal(lock.dialCapability, 'close-period');
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM period_lock WHERE workspace_id = ?').get(workspaceId).n,
    0,
    'a drafted lock writes NO period_lock row',
  );

  // go-live: go_productive drafts under go-live (its inputs are present, so drafting is on the table).
  const go = rest(deps, 'go_productive', { workspaceId, planId: 'plan_x', confirmedName: 'Muster GmbH', idempotencyKey: 'd-go' });
  assert.equal(go.drafted, true, 'an ungranted agent go_productive drafts, never promotes');
  assert.equal(go.dialCapability, 'go-live');

  // pay: mark_batch_paid drafts under pay (batch-1 remap onto the existing family).
  const paid = rest(deps, 'mark_batch_paid', { workspaceId, batchId: 'batch_x', confirmation: true, valueDate: '2026-06-30', idempotencyKey: 'd-pay' });
  assert.equal(paid.drafted, true, 'an ungranted agent mark_batch_paid drafts, never settles');
  assert.equal(paid.dialCapability, 'pay');

  // Each drafted write is one agent_call row in mode 'draft', and no journal entry was minted.
  const drafts = deps.store.db.prepare("SELECT verb FROM agent_call WHERE workspace_id = ? AND mode = 'draft' ORDER BY verb").all(workspaceId);
  assert.deepEqual(drafts.map((r) => r.verb).sort(), ['go_productive', 'lock_period', 'mark_batch_paid']);
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n, 0);
  deps.store.close();
});

test('agent_trust_summary reports the two new capabilities, defaulting to ask', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const summary = human(deps, 'agent_trust_summary', { workspaceId });
  assert.equal(summary.ok, true);
  const byCap = new Map(summary.rows.map((r) => [r.capability, r]));
  for (const cap of ['close-period', 'go-live']) {
    const row = byCap.get(cap);
    assert.ok(row !== undefined, `${cap} has a Vertrauen row`);
    assert.equal(row.stored, 'ask', `${cap} defaults to ask`);
    assert.equal(row.effective, 'ask');
  }
  deps.store.close();
});
