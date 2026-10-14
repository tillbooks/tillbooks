/**
 * D158: THE FIVE IRREVERSIBLE WRITES THE D156 SWEEP MISSED WAIT FOR A HUMAN, AND THE OPENING POSITION
 * KEEPS A04's PARITY UNDER THE DIAL.
 *
 * A non-author critic found five agent writes that cannot be undone and still ran with no Vorschlag:
 * `set_opening_balances` (a posting), `time_lock`, `stock_stocktake_commit`,
 * `inventory_stocktake_commit` and `delivery_note_issue`. The widened coverage net
 * (`dial-covers-irreversible.test.mjs`) surfaced a sixth, `checklist_abandon`. Each is now governed by
 * name; this file drives the REAL transport seam (`handleRest`, MCP `callTool`) as the agent seat over
 * each verb's REAL conformance fixture.
 *
 * `set_opening_balances` used to carry a written exception: drafting at the seam answered 200 for an
 * unbalanced set before the verb's own `unbalanced` refusal ran. The root fix is generic: a verb may
 * declare its own pure validation (`ActionDef.prevalidate`), and the seam runs it before it drafts. So
 * the refusal is the SAME Result, drafted or direct, over REST and MCP, and nothing is queued.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { DIAL_CAPABILITY_FOR_ACTION, dialCapabilityForCall } from '../../dist/core/agent/index.js';
import { CONSEQUENCE_FOR_VERB } from '../../dist/core/agent/consequences.js';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';

/** The D158 verbs and the family each is governed under. */
const D158 = {
  set_opening_balances: 'post',
  time_lock: 'close-period',
  stock_stocktake_commit: 'close-period',
  inventory_stocktake_commit: 'close-period',
  delivery_note_issue: 'issue',
  checklist_abandon: 'close-period',
  // D158 critic round 1: leg (b) and the `abandon` name brought these in. Abandoning moved to `erase`
  // on 11.10.2026: it deletes the Testmandant these books created, beside discard_testmandant.
  migration_abandon_plan: 'erase',
  approve_entry: 'close-period',
  match_bill: 'pay',
};

const AGENT_TABLES = new Set(['agent_session', 'agent_turn', 'agent_call', 'agent_action']);

/** Every business table, row for row: "the proposal changed nothing" is this digest staying equal. */
function digest(db) {
  const h = createHash('sha256');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name } of tables) {
    if (AGENT_TABLES.has(name)) continue;
    h.update(name);
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) h.update(JSON.stringify(row));
  }
  return h.digest('hex');
}

const agent = (fx) => ({ ...fx.deps, actor: 'agent' });
const human = (fx) => ({ ...fx.deps, actor: 'studio' });
const rest = (deps, name, input) => handleRest(name, input, deps);
const mcp = (deps, name, input) => JSON.parse(callTool(deps, name, input).content[0].text);
const approve = (fx, actionId) => getAction('approve_drafted_action').run(human(fx), { workspaceId: fx.workspaceId, actionId });
const drafts = (fx, verb) =>
  fx.deps.store.db.prepare('SELECT id, status, dial_capability, resolved_by FROM agent_action WHERE workspace_id = ? AND action_tool = ?').all(fx.workspaceId, verb);
const trace = (fx, verb) =>
  fx.deps.store.db.prepare('SELECT mode, decision_reason, dial_capability FROM agent_call WHERE workspace_id = ? AND verb = ? ORDER BY rowid').all(fx.workspaceId, verb);

/** What each verb did, read off the rows it writes, so "ran exactly once, as the approver" is measured. */
const EFFECT = {
  set_opening_balances: (fx) =>
    fx.deps.store.db
      .prepare("SELECT created_by AS actor FROM journal_entry WHERE workspace_id = ? AND source = 'import' AND status = 'posted'")
      .all(fx.workspaceId),
  time_lock: (fx) =>
    fx.deps.store.db.prepare("SELECT 'n/a' AS actor FROM time_entry WHERE workspace_id = ? AND status = 'locked'").all(fx.workspaceId),
  stock_stocktake_commit: (fx) =>
    fx.deps.store.db.prepare("SELECT committed_by AS actor FROM stocktake_session WHERE workspace_id = ? AND status = 'committed'").all(fx.workspaceId),
  inventory_stocktake_commit: (fx) =>
    fx.deps.store.db.prepare("SELECT committed_by AS actor FROM cycle_count_session WHERE workspace_id = ? AND status = 'committed'").all(fx.workspaceId),
  // The note's `actor` is the audit name the call carries (the scenario's 'Lageristin'); the approver
  // is asserted on the draft row instead.
  delivery_note_issue: (fx) =>
    fx.deps.store.db.prepare("SELECT 'n/a' AS actor FROM delivery_note WHERE workspace_id = ? AND status = 'issued'").all(fx.workspaceId),
  checklist_abandon: (fx) =>
    fx.deps.store.db.prepare("SELECT abandoned_by AS actor FROM checklist_run WHERE workspace_id = ? AND status = 'abandoned'").all(fx.workspaceId),
  migration_abandon_plan: (fx) =>
    fx.deps.store.db.prepare("SELECT 'n/a' AS actor FROM migration_plan WHERE workspace_id = ? AND status = 'abandoned'").all(fx.workspaceId),
  approve_entry: (fx) =>
    fx.deps.store.db.prepare("SELECT reviewer AS actor FROM entry_review WHERE workspace_id = ? AND status = 'approved'").all(fx.workspaceId),
  match_bill: (fx) =>
    fx.deps.store.db.prepare("SELECT 'n/a' AS actor FROM po_match WHERE workspace_id = ? AND status IN ('matched', 'overridden')").all(fx.workspaceId),
};

// --- the map and the catalogue ---------------------------------------------------------------------

test('each D158 verb is governed by name under its family, with a consequence of its own in both locales', () => {
  for (const [verb, family] of Object.entries(D158)) {
    assert.equal(DIAL_CAPABILITY_FOR_ACTION[verb], family, `${verb}: governed under ${family}`);
    const own = CONSEQUENCE_FOR_VERB[verb];
    assert.ok(own, `${verb}: a sentence of its own`);
    assert.ok(own.en.length > 40 && own['de-CH'].length > 40, `${verb}: both locales`);
    assert.equal(getAction(verb).consequence, own.en, `${verb}: the MCP description carries it`);
  }
  // Reversibility, checked against the code (see the comments in consequences.ts).
  assert.equal(CONSEQUENCE_FOR_VERB.set_opening_balances.reversibility, 'correctable', 'a correcting entry and a fresh position');
  assert.equal(CONSEQUENCE_FOR_VERB.time_lock.reversibility, 'final', 'no unlock, and locked time is never billed');
  assert.equal(CONSEQUENCE_FOR_VERB.delivery_note_issue.reversibility, 'final', 'issued is terminal');
  assert.equal(CONSEQUENCE_FOR_VERB.checklist_abandon.reversibility, 'final');
  assert.equal(CONSEQUENCE_FOR_VERB.migration_abandon_plan.reversibility, 'final', 'closePlan refuses an abandoned plan for good');
  assert.equal(CONSEQUENCE_FOR_VERB.match_bill.reversibility, 'final', 'no unmatch');
  // D161 (the reviewed map): the sign-off stays on record beside the flag that supersedes it, so the
  // act is correctable; the stocktake seal itself never reopens, so the commit is final.
  assert.equal(CONSEQUENCE_FOR_VERB.approve_entry.reversibility, 'correctable', 'a later flag supersedes the sign-off, which stays');
  for (const verb of ['stock_stocktake_commit', 'inventory_stocktake_commit']) {
    assert.equal(CONSEQUENCE_FOR_VERB[verb].reversibility, 'final', `${verb}: the count is sealed for good, the stock is corrected by a new adjustment`);
  }
});

// --- the agent gets a proposal --------------------------------------------------------------------

for (const face of ['REST', 'MCP']) {
  test(`${face}: the agent seat gets a Vorschlag for each D158 verb, its own confirmed:true included, and nothing changes`, () => {
    for (const [verb, family] of Object.entries(D158)) {
      const fx = fixture();
      const input = { ...SCENARIOS[verb](fx), confirmed: true };
      const before = digest(fx.deps.store.db);
      const res = face === 'REST' ? rest(agent(fx), verb, input).body : mcp(agent(fx), verb, input);
      assert.equal(res.ok, true, `${verb}: ${JSON.stringify(res)}`);
      assert.equal(res.drafted, true, `${verb}: the agent proposes, it does not act`);
      assert.equal(res.dialCapability, family, `${verb}: drafted under ${family}`);
      assert.equal(res.reason, 'dial_ask', `${verb}: the ordinary ask`);
      assert.equal(digest(fx.deps.store.db), before, `${verb}: the proposal changed nothing`);
      assert.deepEqual(drafts(fx, verb).map((d) => [d.status, d.dial_capability]), [['pending', family]], `${verb}: one pending Vorschlag`);
      assert.deepEqual(trace(fx, verb).map((r) => r.mode), ['draft'], `${verb}: traced as a draft only`);
      assert.deepEqual(EFFECT[verb](fx), [], `${verb}: nothing of its effect exists yet`);
      fx.deps.store.close();
    }
  });
}

test('a human at the Studio is not dial-governed: each D158 verb runs at once for the studio seat', () => {
  for (const verb of Object.keys(D158)) {
    const fx = fixture();
    const res = rest(human(fx), verb, SCENARIOS[verb](fx)).body;
    assert.equal(res.ok, true, `${verb}: ${JSON.stringify(res)}`);
    assert.equal(res.drafted, undefined, `${verb}: executed, not drafted`);
    assert.equal(EFFECT[verb](fx).length > 0, true, `${verb}: its effect exists`);
    fx.deps.store.close();
  }
});

// --- the approval replays exactly once, as the approver ---------------------------------------------

test('APPROVAL: each D158 Vorschlag replays exactly once, as the approving human, and a second approve settles', () => {
  for (const verb of Object.keys(D158)) {
    const fx = fixture();
    const drafted = rest(agent(fx), verb, SCENARIOS[verb](fx)).body;
    assert.equal(drafted.drafted, true, `${verb}: ${JSON.stringify(drafted)}`);

    const approved = approve(fx, drafted.actionId);
    assert.equal(approved.ok, true, `${verb}: ${JSON.stringify(approved)}`);
    assert.equal(approved.status, 'executed', verb);
    const effect = EFFECT[verb](fx);
    assert.ok(effect.length > 0, `${verb}: the approval is what runs it`);
    for (const row of effect) {
      if (row.actor !== 'n/a') assert.equal(row.actor, 'studio', `${verb}: stamped with the approver, never the agent`);
    }
    assert.deepEqual(drafts(fx, verb).map((d) => [d.status, d.resolved_by]), [['executed', 'studio']], `${verb}: resolved by the human`);

    // Exactly once: approving again replays the stored result and writes nothing.
    const between = digest(fx.deps.store.db);
    const again = approve(fx, drafted.actionId);
    assert.deepEqual(again, JSON.parse(JSON.stringify(approved.result)), `${verb}: approve-twice answers the stored result`);
    assert.equal(digest(fx.deps.store.db), between, `${verb}: approve-twice changed nothing`);
    // And the agent retrying its own call with the same key gets the executed result, not a second run.
    const payload = JSON.parse(fx.deps.store.db.prepare('SELECT payload_json FROM agent_action WHERE id = ?').get(drafted.actionId).payload_json);
    const retried = rest(agent(fx), verb, payload).body;
    assert.equal(retried.ok, true, `${verb}: ${JSON.stringify(retried)}`);
    assert.equal(retried.drafted, undefined, `${verb}: the settled draft is not proposed again`);
    assert.equal(digest(fx.deps.store.db), between, `${verb}: the agent's same-key retry changed nothing`);
    assert.equal(drafts(fx, verb).length, 1, `${verb}: still one Vorschlag`);
    fx.deps.store.close();
  }
});

test('the agent cannot approve its own D158 Vorschlag', () => {
  const fx = fixture();
  const drafted = rest(agent(fx), 'time_lock', SCENARIOS.time_lock(fx)).body;
  const self = rest(agent(fx), 'approve_drafted_action', { workspaceId: fx.workspaceId, actionId: drafted.actionId }).body;
  assert.equal(self.ok, false);
  assert.ok(self.error === 'permission_denied' || self.error === 'cannot_self_approve', self.error);
  assert.deepEqual(EFFECT.time_lock(fx), [], 'nothing was locked');
  fx.deps.store.close();
});

// --- set_opening_balances: the same refusal, drafted or direct ------------------------------------

/** Inputs the verb refuses, each with the code it refuses them with. */
function invalidOpenings(fx) {
  return [
    ['unbalanced', { workspaceId: fx.workspaceId, lines: [{ account: '1020', debitMinor: 100 }, { account: '2800', creditMinor: 40 }], idempotencyKey: 'bad-unb' }],
    ['unknown_account', { workspaceId: fx.workspaceId, lines: [{ account: '9999', debitMinor: 100 }, { account: '2800', creditMinor: 100 }], idempotencyKey: 'bad-acc' }],
    ['invalid_line', { workspaceId: fx.workspaceId, lines: [{ account: '1020', debitMinor: 100, creditMinor: 100 }], idempotencyKey: 'bad-line' }],
    ['unknown_account', {
      workspaceId: fx.workspaceId,
      lines: [{ account: '1020', debitMinor: 100 }, { account: '2800', creditMinor: 40 }],
      differenceAccount: '9998',
      idempotencyKey: 'bad-diff',
    }],
  ];
}

test('PARITY: an invalid opening set is refused with the IDENTICAL Result drafted (ask) or direct, over REST and MCP, and nothing is queued', () => {
  for (const [code, input] of invalidOpenings(fixture())) {
    // Four worlds, one per path, each byte-identical at the start (pinned clock and id sequence).
    const direct = fixture();
    const viaRest = fixture();
    const viaMcp = fixture();
    const viaAuto = fixture();
    const granted = getAction('set_agent_dial').run(human(viaAuto), { workspaceId: viaAuto.workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'grant' });
    assert.equal(granted.ok, true, JSON.stringify(granted));

    const registry = direct.call('set_opening_balances', input);
    assert.equal(registry.ok, false);
    assert.equal(registry.error, code, JSON.stringify(registry));

    const before = digest(viaRest.deps.store.db);
    const r = rest(agent(viaRest), 'set_opening_balances', input);
    assert.equal(r.status, 422, `${code}: REST answers 422, never a 200 Vorschlag`);
    assert.deepEqual(r.body, registry, `${code}: REST drafted path == registry`);
    assert.deepEqual(mcp(agent(viaMcp), 'set_opening_balances', input), registry, `${code}: MCP drafted path == registry`);
    const auto = rest(agent(viaAuto), 'set_opening_balances', input);
    assert.deepEqual(auto.body, registry, `${code}: the direct (auto) path == registry`);

    for (const fx of [viaRest, viaMcp]) {
      assert.deepEqual(drafts(fx, 'set_opening_balances'), [], `${code}: no Vorschlag was queued`);
      assert.deepEqual(trace(fx, 'set_opening_balances'), [{ mode: 'deny', decision_reason: 'not_draftable', dial_capability: 'post' }], `${code}: traced as the not-draftable refusal`);
    }
    assert.equal(digest(viaRest.deps.store.db), before, `${code}: nothing changed`);
    for (const fx of [direct, viaRest, viaMcp, viaAuto]) fx.deps.store.close();
  }
});

test('PARITY: a state refusal (the year already has its opening position) is identical drafted or direct too', () => {
  const fx = fixture();
  const first = SCENARIOS.set_opening_balances(fx);
  assert.equal(fx.call('set_opening_balances', first).ok, true);
  const second = { ...first, idempotencyKey: 'sob-second' };
  const direct = getAction('set_opening_balances').run(human(fx), second);
  assert.equal(direct.error, 'opening_balance_already_set');
  const drafted = rest(agent(fx), 'set_opening_balances', second);
  assert.equal(drafted.status, 422);
  assert.deepEqual(drafted.body, direct);
  assert.deepEqual(drafts(fx, 'set_opening_balances'), []);
  fx.deps.store.close();
});

test('prevalidate is generic and pure: declared on the action, never named at the seam, and it writes nothing', () => {
  const action = getAction('set_opening_balances');
  assert.equal(typeof action.prevalidate, 'function', 'the verb declares its pre-draft validation');
  const seam = readFileSync(fileURLToPath(new URL('../../src/api/agent-gate.ts', import.meta.url)), 'utf8');
  assert.match(seam, /action\.prevalidate\?\.\(deps, input\)/, 'the seam calls the hook');
  assert.doesNotMatch(seam, /set_opening_balances|'[a-z]+_[a-z_]+' *[=!]==? *action\.name|action\.name *[=!]==? *'/, 'the seam special-cases no verb');

  const fx = fixture();
  const valid = SCENARIOS.set_opening_balances(fx);
  const before = digest(fx.deps.store.db);
  const changesBefore = fx.deps.store.db.prepare('SELECT total_changes() AS n').get().n;
  assert.equal(action.prevalidate(agent(fx), valid), undefined, 'a set the verb would post passes');
  assert.equal(action.prevalidate(agent(fx), { ...valid, lines: valid.lines.slice(0, 3) }).error, 'unbalanced');
  assert.equal(fx.deps.store.db.prepare('SELECT total_changes() AS n').get().n, changesBefore, 'not one row written, not even rolled back');
  assert.equal(digest(fx.deps.store.db), before);
  // A key the verb already used replays rather than refusing, so the seam's own replay can answer it.
  assert.equal(fx.call('set_opening_balances', valid).ok, true);
  assert.equal(action.prevalidate(agent(fx), valid), undefined, 'a used key is a replay, not a refusal');
  fx.deps.store.close();
});

// --- the incomplete-call seam refusal still holds -----------------------------------------------------

test('an incomplete call to a D158 verb is still refused at the seam, never drafted and never run', () => {
  for (const [verb, family] of Object.entries(D158)) {
    const fx = fixture();
    const input = SCENARIOS[verb](fx);
    const field = getAction(verb).inputSchema.required.find((f) => f !== 'workspaceId');
    const before = digest(fx.deps.store.db);
    for (const variant of ['omit', 'blank']) {
      const broken = { ...input };
      if (variant === 'omit') delete broken[field];
      else broken[field] = '';
      const res = rest(agent(fx), verb, broken).body;
      assert.deepEqual([res.ok, res.error, res.field], [false, 'invalid_input', field], `${verb} ${variant} ${field}: ${JSON.stringify(res)}`);
    }
    assert.deepEqual(trace(fx, verb), [
      { mode: 'deny', decision_reason: 'not_draftable', dial_capability: family },
      { mode: 'deny', decision_reason: 'not_draftable', dial_capability: family },
    ]);
    assert.deepEqual(drafts(fx, verb), []);
    assert.equal(digest(fx.deps.store.db), before, `${verb}: nothing changed`);
    fx.deps.store.close();
  }
});

// --- the claims the consequence sentences make, measured ---------------------------------------------

test('checklist_abandon: the period gets no new run of the same checklist (the sentence says so)', () => {
  const fx = fixture();
  const input = SCENARIOS.checklist_abandon(fx);
  assert.equal(fx.call('checklist_abandon', input).ok, true);
  const restarted = fx.call('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: 'chk-restart' });
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  assert.equal(restarted.created, false, 'the abandoned run is handed back, no fresh one');
  assert.equal(restarted.runId, input.runId);
  assert.equal(restarted.status, 'abandoned');
  fx.deps.store.close();
});

test('time_lock: locked time can no longer be billed (the sentence says so)', () => {
  const fx = fixture();
  const input = SCENARIOS.time_lock(fx);
  const locked = fx.call('time_lock', input);
  assert.equal(locked.ok, true, JSON.stringify(locked));
  const entryId = locked.entryIds[0];
  const contactId = fx.deps.store.db.prepare("SELECT id FROM contact WHERE workspace_id = ? AND name = 'Sperrung AG'").get(fx.workspaceId).id;
  const billed = fx.call('billing_generate_invoice', { contactId, timeEntryIds: [entryId], idempotencyKey: 'tl-bill' });
  assert.equal(billed.ok, false, JSON.stringify(billed));
  assert.equal(billed.error, 'not_billable');
  fx.deps.store.close();
});

test('dialCapabilityForCall resolves each D158 verb by name, whatever its input', () => {
  for (const [verb, family] of Object.entries(D158)) assert.equal(dialCapabilityForCall(verb, {}), family);
});

// --- import_opening_balances: the same refusal, drafted or direct (D158 finding 3) -----------------

const IMPORT_MAPPING = { account: 'Konto', debit: 'Soll', credit: 'Haben' };

/** Import files the verb refuses, each with the code it refuses them with. */
function invalidImports(fx) {
  const file = (rows, key, extra = {}) => ({ workspaceId: fx.workspaceId, format: 'csv', mapping: IMPORT_MAPPING, rows, idempotencyKey: key, ...extra });
  return [
    ['unbalanced', file([{ Konto: '1020', Soll: "12'500.00", Haben: '' }, { Konto: '2800', Soll: '', Haben: "12'000.00" }], 'imp-unb')],
    ['unmapped_account', file([{ Konto: '1020', Soll: '100.00', Haben: '' }, { Konto: '9999', Soll: '', Haben: '100.00' }], 'imp-unm')],
    ['duplicate_account', file([{ Konto: '1020', Soll: '100.00', Haben: '' }, { Konto: '1020', Soll: '', Haben: '100.00' }], 'imp-dup')],
    ['unknown_account', file([{ Konto: '1020', Soll: '100.00', Haben: '' }, { Konto: '2800', Soll: '', Haben: '40.00' }], 'imp-diff', { differenceAccount: '9998' })],
  ];
}

test('PARITY: an invalid import file is refused with the IDENTICAL Result drafted (ask) or direct, over REST and MCP, and nothing is queued', () => {
  assert.equal(typeof getAction('import_opening_balances').prevalidate, 'function', 'the import declares its pre-draft validation');
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.import_opening_balances, 'post');
  for (const [code, input] of invalidImports(fixture())) {
    const direct = fixture();
    const viaRest = fixture();
    const viaMcp = fixture();
    const viaAuto = fixture();
    assert.equal(getAction('set_agent_dial').run(human(viaAuto), { workspaceId: viaAuto.workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'grant' }).ok, true);

    const registry = direct.call('import_opening_balances', input);
    assert.equal(registry.ok, false);
    assert.equal(registry.error, code, JSON.stringify(registry));

    const before = digest(viaRest.deps.store.db);
    const r = rest(agent(viaRest), 'import_opening_balances', input);
    assert.equal(r.status, 422, `${code}: REST answers 422, never a 200 Vorschlag`);
    assert.deepEqual(r.body, registry, `${code}: REST drafted path == registry`);
    assert.deepEqual(mcp(agent(viaMcp), 'import_opening_balances', input), registry, `${code}: MCP drafted path == registry`);
    assert.deepEqual(rest(agent(viaAuto), 'import_opening_balances', input).body, registry, `${code}: the direct (auto) path == registry`);
    for (const fx of [viaRest, viaMcp]) {
      assert.deepEqual(drafts(fx, 'import_opening_balances'), [], `${code}: no Vorschlag was queued`);
      assert.deepEqual(trace(fx, 'import_opening_balances'), [{ mode: 'deny', decision_reason: 'not_draftable', dial_capability: 'post' }]);
    }
    assert.equal(digest(viaRest.deps.store.db), before, `${code}: nothing changed`);
    for (const fx of [direct, viaRest, viaMcp, viaAuto]) fx.deps.store.close();
  }
});

test('import_opening_balances: a valid file is a Vorschlag that changes nothing, and the approval posts it once as the approver', () => {
  const fx = fixture();
  const input = SCENARIOS.import_opening_balances(fx);
  const before = digest(fx.deps.store.db);
  const drafted = rest(agent(fx), 'import_opening_balances', input).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(digest(fx.deps.store.db), before);
  const approved = approve(fx, drafted.actionId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(EFFECT.set_opening_balances(fx), [{ actor: 'studio' }]);
  const between = digest(fx.deps.store.db);
  // The agent's same-key retry replays (the import's checks pass, the opening key replays): no refusal.
  const retried = rest(agent(fx), 'import_opening_balances', input).body;
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.drafted, undefined);
  assert.equal(digest(fx.deps.store.db), between);
  fx.deps.store.close();
});

test('migration_abandon_plan (critic round 1): an agent with confirmed:true can no longer abandon a live plan; the approval does', () => {
  const fx = fixture();
  const input = SCENARIOS.migration_abandon_plan(fx);
  const status = () => fx.deps.store.db.prepare('SELECT status FROM migration_plan WHERE workspace_id = ? AND id = ?').get(fx.workspaceId, input.planId).status;
  const before = status();
  const drafted = rest(agent(fx), 'migration_abandon_plan', input).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(status(), before, 'the plan is untouched by the proposal');
  // Drafted WITHOUT confirmed, the approval is the confirmation (no needs_confirmation after approval).
  const fx2 = fixture();
  const bare = { ...SCENARIOS.migration_abandon_plan(fx2) };
  delete bare.confirmed;
  const drafted2 = rest(agent(fx2), 'migration_abandon_plan', bare).body;
  assert.equal(drafted2.drafted, true, JSON.stringify(drafted2));
  const approved = approve(fx2, drafted2.actionId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(fx2.deps.store.db.prepare("SELECT status FROM migration_plan WHERE workspace_id = ?").get(fx2.workspaceId).status, 'abandoned');
  fx.deps.store.close();
  fx2.deps.store.close();
});
