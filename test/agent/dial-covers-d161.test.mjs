/**
 * D161: EVERY WRITE THAT TOUCHES THE BOOKS, A STATUTORY RECORD, WHAT LEAVES TILL, WHO HAS ACCESS, OR
 * DELETES FOR GOOD WAITS FOR THE PERSON BY DEFAULT.
 *
 * D160 moved the approval boundary from reversibility to consequence, and D161 recorded the map that
 * applies it: `docs/planning/reversibility/map.json` tags every write. A write tagged `books`,
 * `statutory`, `outbound`, `access` or `erase` is governed by default; the other tags are the closed
 * list of exemptions. Sixty-six tagged writes were not governed. This file holds all of them (and every
 * tagged write the map names) to the dial, and pins the four product calls of D161.3.
 *
 * THE POPULATION IS THE MAP, NOT A LIST HERE, read through the registry, which carries the map's class
 * and tag on every registration line (held equal by `test/planning/reversibility-map-parity.test.mjs`).
 * This file ships in the public mirror and reads no private doc; the map-reading forms of its
 * population, count and class assertions live in `test/planning/reversibility-map-d161.test.mjs`.
 * A write the registry tags and the dial does not govern is
 * named by the coverage test, unless `NOT_DIAL_GOVERNED` carries its reason AND the reason is one this
 * file accepts for a tagged write (`TAGGED_EXCLUSIONS`): human-only, or a pre-workspace verb the seam
 * cannot draft. Every other exclusion of a tagged write is a defect.
 *
 * HOW IT BITES: the coverage rule is a function of the maps it is handed. The bite test removes one
 * name-keyed verb, one input-keyed rule and one accepted exclusion, and each is named at once.
 *
 * THE SCHEDULER AND THE RULES ARE NOT THE AGENT SEAT. The two ticks are governed for the agent's OWN
 * call; the `till up` scheduler runs `run_due_automations` as `system` through `action.run`, and a G01
 * rule fires its verb through `invokerFor`. Neither meets the transport seam, which the last tests
 * here measure on rows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { createScheduler } from '../../dist/api/scheduler.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { makeContext } from '../../dist/core/context.js';
import {
  DIAL_CAPABILITIES,
  STRONG_DEFAULT_ASK_CAPABILITIES,
  DIAL_CAPABILITY_FOR_ACTION,
  INPUT_KEYED_DIAL_RULES,
  NOT_DIAL_GOVERNED,
  APPROVAL_CONFIRMS_FIELD,
  dialCapabilityForCall,
  dialCapabilitiesForVerb,
  approveDraftedAction,
  enqueueDraftedAction,
  setAgentDial,
} from '../../dist/core/agent/index.js';
import { DIAL_SEVERITY, CONSEQUENCE_ENTRY_FOR_ACTION } from '../../dist/core/agent/dialMap.js';
import { CONSEQUENCE_FOR_VERB, CONSEQUENCE_FOR_FAMILY, consequenceFor } from '../../dist/core/agent/consequences.js';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';
import { TAGGED_EXCLUSIONS, uncovered as sharedUncovered } from './approval-coverage.mjs';
import { D161_FAMILY } from './d161-family.mjs';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { defineRule, postTemplate, retireSeededChecklistRules } from '../automation/support.mjs';

/**
 * Every registered write's class and tag, as the registry declares them (`write:<class>:<tag>`). This
 * file ships in the public mirror, where the reviewed map (`docs/planning/reversibility/map.json`) does
 * not, so it reads the registry; `test/planning/reversibility-map-parity.test.mjs` holds the registry
 * equal to the map verb for verb, and `test/planning/reversibility-map-d161.test.mjs` runs the
 * map-reading forms of these assertions.
 */
const KINDS = Object.fromEntries(
  ACTIONS.filter((a) => a.kind === 'write').map((a) => [a.name, { verb: a.name, class: a.reversibility, tag: a.consequenceTag }]),
);
const GATED_TAGS = new Set(['books', 'statutory', 'outbound', 'access', 'erase']);
const WRITE_NAMES = new Set(ACTIONS.filter((a) => a.kind === 'write').map((a) => a.name));

/** Every write the registry tags as gated by default (D160.1). */
const TAGGED = Object.values(KINDS)
  .filter((row) => GATED_TAGS.has(row.tag))
  .map((row) => row.verb)
  .sort();

/**
 * The coverage rule, as a function of the maps it is handed, so the bite test can weaken them. It lives
 * in `approval-coverage.mjs` because the public approval claim is held to the SAME rule
 * (`test/web/positioning-claims.test.mjs`); the accepted exclusions (`TAGGED_EXCLUSIONS`) sit there too.
 * Its population is the registry's tagged writes, which the map-parity suite holds equal to `TAGGED`.
 */
const uncovered = (byName, inputKeyed, excluded) => sharedUncovered(byName, inputKeyed, excluded, TAGGED);


/** The verbs whose schema requires nothing beyond the tenant: governed by an input-keyed rule. */
const INPUT_KEYED_D161 = ['update_company_profile', 'quotes_accept', 'run_due_recurring', 'run_due_automations', 'time_approve'];

/** The input a conformance scenario must carry to be the GOVERNED call of an input-keyed verb. */
const GOVERNED_SHAPE = {
  update_company_profile: (input) => ({ ...input, mwstNo: 'CHE-116.281.710 MWST' }),
};

/**
 * A governed verb whose A24 capability the governed seat can never hold (A24 step 0). The seam checks
 * A24 before the dial, so the seat is denied with a deny row that names the family, and nothing drafts.
 */
const NEVER_HELD_BY_THE_SEAT = { agent_prose_delete: 'manage_agent_dial' };

const TRACE_AND_QUEUE = new Set(['agent_session', 'agent_turn', 'agent_call', 'agent_action', 'idempotency']);

/** Every business table, row for row: "the proposal changed nothing" is this digest staying equal. */
function digest(db) {
  const h = createHash('sha256');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name } of tables) {
    if (TRACE_AND_QUEUE.has(name)) continue;
    h.update(name);
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) h.update(JSON.stringify(row));
  }
  return h.digest('hex');
}

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);

// --- the population is the map ----------------------------------------------------------------------

test('every write the map tags books, statutory, outbound, access or erase is governed, or excluded for an accepted reason', () => {
  assert.ok(TAGGED.length >= 180, `the tagged population is real (${TAGGED.length} writes)`);
  for (const verb of TAGGED) assert.ok(WRITE_NAMES.has(verb), `${verb}: the map names a registered write`);
  assert.deepEqual(
    uncovered(),
    [],
    'these writes are tagged as gated by default (D160.1) yet run with no Vorschlag: govern them in src/core/agent/dialMap.ts',
  );
});

test('the D161 count: 66 newly governed (books 32, statutory 14, outbound 12, access 6, erase 2) and the four product calls', () => {
  const newly = Object.keys(D161_FAMILY).filter((v) => GATED_TAGS.has(KINDS[v].tag));
  assert.equal(newly.length, 66, 'the map\'s 66');
  const byTag = {};
  for (const v of newly) byTag[KINDS[v].tag] = (byTag[KINDS[v].tag] ?? 0) + 1;
  assert.deepEqual(byTag, { statutory: 14, books: 32, outbound: 12, access: 6, erase: 2 });
  for (const v of ['bank_channel_disconnect', 'update_company_profile', 'set_write_off_threshold', 'requisition_approve']) {
    assert.equal(GATED_TAGS.has(KINDS[v].tag), false, `${v}: a D161.3 product call, not a tag consequence`);
  }
});

test('IT BITES: un-governing one name-keyed verb, dropping one input-keyed rule or one accepted exclusion names it at once', () => {
  for (const verb of ['stock_move', 'bank_sync', 'files_link', 'mail_reindex', 'enable_plugin', 'notifications_deliver']) {
    const weakened = { ...DIAL_CAPABILITY_FOR_ACTION };
    delete weakened[verb];
    assert.deepEqual(uncovered(weakened), [verb], `${verb}: un-governed, it must surface`);
  }
  for (const verb of ['quotes_accept', 'run_due_recurring', 'run_due_automations', 'time_approve']) {
    assert.deepEqual(uncovered(DIAL_CAPABILITY_FOR_ACTION, INPUT_KEYED_DIAL_RULES.filter((r) => r.action !== verb)), [verb]);
  }
  const { set_agent_dial: _dropped, ...fewer } = NOT_DIAL_GOVERNED;
  assert.deepEqual(uncovered(DIAL_CAPABILITY_FOR_ACTION, INPUT_KEYED_DIAL_RULES, fewer), ['set_agent_dial']);
  // A reason this file does not accept for a tagged write is no cover either.
  assert.deepEqual(
    uncovered(DIAL_CAPABILITY_FOR_ACTION, INPUT_KEYED_DIAL_RULES, { ...NOT_DIAL_GOVERNED, approve_drafted_action: 'not needed, the agent rarely approves anything' }),
    ['approve_drafted_action'],
  );
});

// --- the families --------------------------------------------------------------------------------

test('each D161 verb sits in its family, by name or by its input-keyed rule', () => {
  for (const [verb, family] of Object.entries(D161_FAMILY)) {
    if (INPUT_KEYED_D161.includes(verb)) {
      assert.equal(DIAL_CAPABILITY_FOR_ACTION[verb], undefined, `${verb}: input-keyed, not by name`);
      assert.deepEqual(dialCapabilitiesForVerb(verb), [family], `${verb}: every rule names ${family}`);
    } else {
      assert.equal(DIAL_CAPABILITY_FOR_ACTION[verb], family, `${verb}: governed under ${family}`);
    }
    assert.equal(NOT_DIAL_GOVERNED[verb], undefined, `${verb}: governed now, no exclusion left`);
  }
});

test('stock is a real family with an ordinary ask: in the dial set, the severity order and the catalogue', () => {
  assert.ok(DIAL_CAPABILITIES.includes('stock'));
  assert.equal(STRONG_DEFAULT_ASK_CAPABILITIES.has('stock'), false);
  assert.ok(DIAL_SEVERITY.indexOf('stock') > DIAL_SEVERITY.indexOf('post'), 'stock sorts below the posting it never makes');
  assert.equal(CONSEQUENCE_FOR_FAMILY.stock.reversibility, 'correctable');
  const stock = Object.keys(DIAL_CAPABILITY_FOR_ACTION).filter((v) => DIAL_CAPABILITY_FOR_ACTION[v] === 'stock');
  assert.ok(stock.length > 10, `a new family needs more than ten verbs that fit no other (${stock.length})`);
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const row = human(deps, 'get_agent_dial', { workspaceId }).rows.find((r) => r.capability === 'stock');
  assert.deepEqual([row.stored, row.effective, row.strongDefault], ['ask', 'ask', false]);
  deps.store.close();
});

test('the input-keyed rules govern exactly the governed input: a name change, an unnamed quote and nothing else stay free', () => {
  assert.equal(dialCapabilityForCall('update_company_profile', { name: 'Neu AG', legalForm: 'ag', uid: 'CHE-116.281.710' }), undefined);
  assert.equal(dialCapabilityForCall('update_company_profile', { mwstNo: 'CHE-116.281.710 MWST' }), 'vat-file');
  assert.equal(dialCapabilityForCall('update_company_profile', { mwstNo: null }), 'vat-file', 'clearing the number is a change too');
  assert.equal(dialCapabilityForCall('quotes_accept', {}), undefined, 'neither door named: the verb refuses it itself');
  assert.equal(dialCapabilityForCall('quotes_accept', { quoteId: 'doc_1' }), 'issue');
  assert.equal(dialCapabilityForCall('quotes_accept', { token: 't' }), 'issue');
  assert.equal(dialCapabilityForCall('run_due_recurring', {}), 'issue');
  assert.equal(dialCapabilityForCall('run_due_automations', {}), 'customize');
  assert.equal(dialCapabilityForCall('time_approve', { entryIds: [] }), undefined, 'an empty selection approves nothing: the verb refuses it on every face');
  assert.equal(dialCapabilityForCall('time_approve', { entryIds: ['t1'] }), 'close-period');
});

// --- the consequence: own sentence, the map's class --------------------------------------------------

test('each D161 verb carries its own consequence in both locales, and its reversibility is the map\'s class', () => {
  for (const verb of Object.keys(D161_FAMILY)) {
    const own = CONSEQUENCE_FOR_VERB[verb];
    assert.ok(own, `${verb}: a sentence of its own`);
    assert.ok(own.en.length > 20 && own['de-CH'].length > 20, `${verb}: both locales`);
    assert.equal(own.reversibility, KINDS[verb].class, `${verb}: the catalogue class is the map's`);
    assert.equal(getAction(verb).consequence, own.en, `${verb}: the MCP description carries it`);
  }
});

// --- every consequence states the map's class (coordinator extra scope, D161) -----------------------

/** Every governed verb's resolved consequence, plus every verb with an entry of its own. */
function resolvedClasses(entries = CONSEQUENCE_FOR_VERB) {
  const verbs = new Set([...Object.keys(DIAL_CAPABILITY_FOR_ACTION), ...INPUT_KEYED_DIAL_RULES.map((r) => r.action), ...Object.keys(entries)]);
  return [...verbs].sort().map((verb) => {
    const family = DIAL_CAPABILITY_FOR_ACTION[verb] ?? INPUT_KEYED_DIAL_RULES.find((r) => r.action === verb)?.capability;
    const c = entries[verb] ?? CONSEQUENCE_FOR_FAMILY[family];
    return { verb, catalogue: c?.reversibility, map: KINDS[verb]?.class };
  });
}

test('every governed verb and every catalogue entry states the registered class (the reviewed map)', () => {
  const rows = resolvedClasses();
  assert.ok(rows.length > 180, `the population is real (${rows.length})`);
  const off = rows.filter((r) => r.map === undefined || r.catalogue !== r.map).map((r) => `${r.verb}: catalogue ${r.catalogue}, map ${r.map}`);
  assert.deepEqual(off, [], 'align the entry in src/core/agent/consequences.ts to the registered class (the reviewed map)');
  // The projection everything reads is the same resolution.
  for (const [verb, c] of Object.entries(CONSEQUENCE_ENTRY_FOR_ACTION)) assert.equal(c.reversibility, KINDS[verb].class, verb);
});

test('IT BITES: one entry with a class off the map is named', () => {
  const weakened = { ...CONSEQUENCE_FOR_VERB, time_lock: { ...CONSEQUENCE_FOR_VERB.time_lock, reversibility: 'reversible' } };
  const off = resolvedClasses(weakened).filter((r) => r.catalogue !== r.map).map((r) => r.verb);
  assert.deepEqual(off, ['time_lock']);
});

test('a final consequence says there is no way back, in both locales', () => {
  const NO_WAY_BACK_EN = /for good|no way back|can't|cannot|never|no undo|no unlock|no disconnect|\bfinal\b/i;
  const NO_WAY_BACK_DE = /endgültig|nicht|\bnie\b|kein|weder/;
  const entries = [...Object.entries(CONSEQUENCE_FOR_VERB), ...Object.entries(CONSEQUENCE_FOR_FAMILY).map(([f, c]) => [`family ${f}`, c])];
  for (const [label, c] of entries) {
    if (c.reversibility !== 'final') continue;
    assert.match(c.en, NO_WAY_BACK_EN, `${label} en`);
    assert.match(c['de-CH'], NO_WAY_BACK_DE, `${label} de-CH`);
  }
  assert.equal(consequenceFor('install_plugin').reversibility, 'correctable', 'the install has its own entry at the map\'s class');
});

// --- the seam: the agent proposes, the person decides -----------------------------------------------

test('CONFORMANCE: every D161 verb called by the agent seat over the real REST seam is a Vorschlag under its family that changes no business row', () => {
  const failures = [];
  for (const [verb, family] of Object.entries(D161_FAMILY)) {
    const fx = fixture();
    const base = SCENARIOS[verb](fx);
    const input = GOVERNED_SHAPE[verb] !== undefined ? GOVERNED_SHAPE[verb](base) : { ...base };
    const before = digest(fx.deps.store.db);
    const res = handleRest(verb, input, { ...fx.deps, actor: 'agent' }).body;
    const expectedReason = STRONG_DEFAULT_ASK_CAPABILITIES.has(family) ? 'force_ask' : 'dial_ask';
    const trace = fx.deps.store.db.prepare('SELECT mode, dial_capability FROM agent_call WHERE verb = ?').all(verb);
    if (NEVER_HELD_BY_THE_SEAT[verb] !== undefined) {
      // A24 answers before the dial: the seat never holds the capability, so it is denied, never drafted.
      if (res.error !== 'permission_denied' || res.capability !== NEVER_HELD_BY_THE_SEAT[verb]) failures.push(`${verb}: ${JSON.stringify(res).slice(0, 200)}`);
      if (JSON.stringify(trace) !== JSON.stringify([{ mode: 'deny', dial_capability: family }])) failures.push(`${verb}: traced as ${JSON.stringify(trace)}`);
    } else {
      if (res.drafted !== true) failures.push(`${verb}: not drafted: ${JSON.stringify(res).slice(0, 200)}`);
      else {
        if (res.dialCapability !== family) failures.push(`${verb}: drafted under ${res.dialCapability}, not ${family}`);
        if (res.reason !== expectedReason) failures.push(`${verb}: reason ${res.reason}, not ${expectedReason}`);
      }
      if (trace.map((r) => r.mode).join() !== 'draft') failures.push(`${verb}: traced as ${JSON.stringify(trace)}, not one draft`);
    }
    if (digest(fx.deps.store.db) !== before) failures.push(`${verb}: the proposal changed business data`);
    fx.deps.store.close();
  }
  assert.deepEqual(failures, []);
});

test('a person at the Studio is not dial-governed: each D161 verb answers the verb itself for the studio seat', () => {
  const failures = [];
  for (const verb of Object.keys(D161_FAMILY)) {
    const fx = fixture();
    const base = SCENARIOS[verb](fx);
    const input = GOVERNED_SHAPE[verb] !== undefined ? GOVERNED_SHAPE[verb](base) : { ...base };
    const res = handleRest(verb, input, { ...fx.deps, actor: 'studio' }).body;
    if (res.drafted === true) failures.push(`${verb}: drafted for a person`);
    fx.deps.store.close();
  }
  assert.deepEqual(failures, []);
});

test('update_company_profile: the agent renames freely, and a new MWST number is a vat-file Vorschlag the approval applies', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const profile = () => deps.store.db.prepare('SELECT name, mwst_no FROM workspace WHERE id = ?').get(workspaceId);

  const renamed = rest(deps, 'update_company_profile', { workspaceId, name: 'Seeblick Treuhand AG' });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(renamed.drafted, undefined, 'a rename stays free');
  assert.equal(profile().name, 'Seeblick Treuhand AG');

  const vat = mcp(deps, 'update_company_profile', { workspaceId, mwstNo: 'CHE-116.281.710 MWST' });
  assert.equal(vat.drafted, true, JSON.stringify(vat));
  assert.equal(vat.dialCapability, 'vat-file');
  assert.equal(vat.reason, 'force_ask', 'vat-file is a strong default');
  assert.equal(profile().mwst_no, null, 'the proposal changed nothing');

  const approved = human(deps, 'approve_drafted_action', { workspaceId, actionId: vat.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(profile().mwst_no, 'CHE-116.281.710 MWST', 'the approval applies it');
  deps.store.close();
});

test('bank_channel_disconnect and discard_payment_batch: the approval satisfies the verb\'s own confirm step', () => {
  assert.equal(APPROVAL_CONFIRMS_FIELD.bank_channel_disconnect, 'confirm');
  assert.equal(APPROVAL_CONFIRMS_FIELD.discard_payment_batch, 'confirmation');
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const agentCtx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
  const humanCtx = makeContext(deps.store, { workspaceId, actor: 'studio', clock: deps.clock, ids: deps.ids });
  for (const [verb, field] of [['bank_channel_disconnect', 'confirm'], ['discard_payment_batch', 'confirmation']]) {
    const queued = enqueueDraftedAction(agentCtx, { actionTool: verb, payload: { workspaceId, idempotencyKey: `k-${verb}` }, dialCapability: D161_FAMILY[verb] });
    let seen;
    const res = approveDraftedAction(humanCtx, (name, input) => { seen = input; return { ok: true }; }, { actionId: queued.actionId });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(seen[field], true, `${verb}: the approval is the confirmation`);
  }
  deps.store.close();
});

// --- the two human-only writes -----------------------------------------------------------------------

test('approve_drafted_action and set_agent_dial are human-only: the agent seat is refused on every face and in the engine', () => {
  for (const verb of ['approve_drafted_action', 'set_agent_dial']) {
    assert.equal(DIAL_CAPABILITY_FOR_ACTION[verb], undefined, `${verb}: never drafted`);
    assert.match(NOT_DIAL_GOVERNED[verb], TAGGED_EXCLUSIONS[verb]);
  }
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const drafted = rest(deps, 'stock_move', { workspaceId, itemId: 'i', locationId: 'l', qty: 1, reason: 'receipt', idempotencyKey: 'h1' });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));

  const viaRest = rest(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId });
  assert.equal(viaRest.error, 'permission_denied', JSON.stringify(viaRest));
  const grant = mcp(deps, 'set_agent_dial', { workspaceId, capability: 'stock', level: 'auto', idempotencyKey: 'g1' });
  assert.equal(grant.error, 'permission_denied', JSON.stringify(grant));
  assert.equal(setAgentDial(makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids }), { capability: 'stock', level: 'auto', idempotencyKey: 'g2' }).error, 'cannot_self_grant');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_dial WHERE workspace_id = ?').get(workspaceId).n, 0);
  deps.store.close();
});

test('IT BITES (engine belt): a SERVED agent member approving the local agent\'s Vorschlag is refused on the actor, even past A24', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const invite = human(deps, 'invite_member', { workspaceId, email: 'bot@seeblick.example', role: 'owner', kind: 'agent', idempotencyKey: 'inv-bot' });
  assert.equal(invite.ok, true, JSON.stringify(invite));
  const before = resolveServedActor(deps.store, 'bot@seeblick.example');
  assert.equal(getAction('accept_invite').run({ ...deps, actor: before.actor, subject: before.subject, identitySource: before.identitySource }, { token: invite.token }).ok, true);
  const id = resolveServedActor(deps.store, 'bot@seeblick.example');
  assert.notEqual(id.actor, 'agent', 'the bound member is a different actor from the local agent');

  const drafted = rest(deps, 'stock_move', { workspaceId, itemId: 'i', locationId: 'l', qty: 1, reason: 'receipt', idempotencyKey: 'h2' });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  // An embedder context: no A24 port (allow-all), the bound agent member as the actor, a DIFFERENT
  // actor from the local `agent` that drafted, so the self-approve check alone would let it through.
  const memberCtx = makeContext(deps.store, { workspaceId, actor: id.actor, clock: deps.clock, ids: deps.ids });
  const res = approveDraftedAction(memberCtx, () => {
    throw new Error('the invoker must not be reached by a governed seat');
  }, { actionId: drafted.actionId, allowFuture: true });
  assert.equal(res.error, 'cannot_self_approve', JSON.stringify(res));
  assert.equal(res.reason, 'governed_seat');
  assert.equal(deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(drafted.actionId).status, 'pending');
  deps.store.close();
});

// --- the scheduler and the rules are not the agent seat ----------------------------------------------

const ENTRIES = 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?';
const QUEUE = 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?';
const count = (deps, sql, id) => deps.store.db.prepare(sql).get(id).n;

test('SCHEDULER: the till up tick runs run_due_automations as system, ungated, while the agent\'s own call to it drafts', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Takt GmbH', 'd161-tick');
  retireSeededChecklistRules(deps, workspaceId);
  defineRule(deps, workspaceId, { name: 'Täglich', event: 'schedule.daily', tool: 'post_entry', template: postTemplate(accId) }, 'd161-rule');

  // The agent seat's own tick is a Vorschlag under customize, and fires nothing.
  const agentTick = rest({ ...deps, actor: 'agent' }, 'run_due_automations', { workspaceId });
  assert.equal(agentTick.drafted, true, JSON.stringify(agentTick));
  assert.equal(agentTick.dialCapability, 'customize');
  assert.equal(count(deps, ENTRIES, workspaceId), 0, 'the agent tick fired a rule');

  // The scheduler is not the agent seat: it fires the due rule at once, and queues nothing.
  const scheduler = createScheduler(deps, { now: () => new Date('2026-07-16T00:00:00.000Z'), bankAutoSync: false });
  scheduler.tickOnce();
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'the scheduler tick did not fire the due rule');
  assert.equal(count(deps, QUEUE, workspaceId), 1, 'the scheduler drafted (only the agent\'s own tick is queued)');
  deps.store.close();
});

test('RULES: a rule firing notifications_deliver (governed by name under send) delivers at once, with no Vorschlag', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Regel GmbH', 'd161-rule-ws');
  retireSeededChecklistRules(deps, workspaceId);
  defineRule(deps, workspaceId, {
    name: 'Neuer Kontakt melden',
    event: 'contact.created',
    tool: 'notifications_deliver',
    template: { userId: 'studio', event: 'contact.created', summaryI18nKey: 'notifications.summary.contact_created' },
  }, 'd161-ntf-rule');
  const inbox = () => deps.store.db.prepare('SELECT COUNT(*) AS n FROM inbox_item WHERE workspace_id = ?').get(workspaceId).n;
  assert.equal(inbox(), 0);

  const created = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Auslöser AG', idempotencyKey: 'd161-c1' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const runs = deps.store.db.prepare("SELECT status, error_code FROM automation_run WHERE workspace_id = ? AND action_tool = 'notifications_deliver'").all(workspaceId);
  assert.deepEqual(runs.map((r) => r.status), ['ok'], JSON.stringify(runs));
  assert.equal(inbox(), 1, 'the rule delivered the notice');
  assert.equal(count(deps, QUEUE, workspaceId), 0, 'the rule path drafted');

  // The agent seat calling the same verb directly proposes it.
  const agent = rest({ ...deps, actor: 'agent' }, 'notifications_deliver', {
    workspaceId, userId: 'studio', event: 'contact.created', summaryI18nKey: 'notifications.summary.contact_created', idempotencyKey: 'd161-n-agent',
  });
  assert.equal(agent.drafted, true, JSON.stringify(agent));
  assert.equal(agent.dialCapability, 'send');
  assert.equal(inbox(), 1);
  deps.store.close();
});

test('RULES: the recurring tick a person runs issues as before; the agent\'s own tick is a Vorschlag under issue', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Serie GmbH', 'd161-rec');
  const agentTick = rest(deps, 'run_due_recurring', { workspaceId });
  assert.equal(agentTick.drafted, true, JSON.stringify(agentTick));
  assert.equal(agentTick.dialCapability, 'issue');
  const personTick = rest({ ...deps, actor: 'studio' }, 'run_due_recurring', { workspaceId });
  assert.equal(personTick.ok, true, JSON.stringify(personTick));
  assert.equal(personTick.drafted, undefined, 'a person runs the tick directly');
  // And the approval of the agent's tick runs it as the approving person.
  const approved = human(deps, 'approve_drafted_action', { workspaceId, actionId: agentTick.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  deps.store.close();
});

// --- the portal accept: the seam resolves the token for this one verb --------------------------------

/** A live customer grant on a sent quote (the conformance fixture), and its accept input. */
function portalWorld() {
  const fx = fixture();
  const input = SCENARIOS.portal_quote_accept(fx);
  const status = () => fx.deps.store.db.prepare('SELECT status FROM document WHERE id = ?').get(input.quoteId).status;
  return { fx, input, status };
}

test('portal_quote_accept: an agent seat holding a live token gets a Vorschlag in the grant\'s workspace, and the quote stays sent', () => {
  const { fx, input, status } = portalWorld();
  assert.equal(status(), 'sent');
  const res = mcp({ ...fx.deps, actor: 'agent' }, 'portal_quote_accept', input);
  assert.equal(res.drafted, true, JSON.stringify(res));
  assert.equal(res.dialCapability, 'issue');
  assert.equal(status(), 'sent', 'the proposal accepted nothing');
  const queued = fx.deps.store.db.prepare("SELECT workspace_id, status, dial_capability FROM agent_action WHERE action_tool = 'portal_quote_accept'").all();
  assert.deepEqual(queued, [{ workspace_id: fx.workspaceId, status: 'pending', dial_capability: 'issue' }], 'queued in the grant\'s own workspace');
  // The token is a bearer secret TILL stores only hashed: the trace keeps the call without it.
  const trace = fx.deps.store.db.prepare("SELECT workspace_id, mode, args_json FROM agent_call WHERE verb = 'portal_quote_accept'").all();
  assert.equal(trace.length, 1);
  assert.equal(trace[0].mode, 'draft');
  assert.equal(trace[0].workspace_id, fx.workspaceId);
  assert.ok(!trace[0].args_json.includes(input.token), 'the trace row holds no token');
  assert.equal(JSON.parse(trace[0].args_json).tokenOmitted, true);

  // A person's approval replays it: the quote is accepted, through the portal door, once.
  const approved = human(fx.deps, 'approve_drafted_action', { workspaceId: fx.workspaceId, actionId: res.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(status(), 'accepted');
  const by = fx.deps.store.db.prepare('SELECT accepted_by FROM document WHERE id = ?').get(input.quoteId).accepted_by;
  assert.match(by, /^portal:/, 'accepted as the grant, by the portal\'s own delegation');
  fx.deps.store.close();
});

test('portal_quote_accept: a bad token gets exactly the refusal it got before, and the seam learns no tenant', () => {
  const variants = {
    unknown: (w) => ({ ...w.input, token: 'f'.repeat(64) }),
    absent: (w) => ({ quoteId: w.input.quoteId, idempotencyKey: w.input.idempotencyKey }),
    blank: (w) => ({ ...w.input, token: '' }),
    // A workspaceId the caller adds is not the verb's tenant: the token is, and it names nothing here.
    'stray tenant': (w) => ({ ...w.input, token: 'f'.repeat(64), workspaceId: w.fx.workspaceId }),
    expired: (w) => { w.fx.deps.store.db.prepare("UPDATE portal_grant SET expires_at = '2020-01-01'").run(); return w.input; },
    revoked: (w) => { w.fx.deps.store.db.prepare("UPDATE portal_grant SET revoked_at = '2026-07-01T00:00:00.000Z'").run(); return w.input; },
  };
  for (const [label, make] of Object.entries(variants)) {
    // Two identical worlds: the person's (hosted-page) call is the before; the agent's must equal it.
    const a = portalWorld();
    const b = portalWorld();
    const before = getAction('portal_quote_accept').run({ ...a.fx.deps, actor: 'studio' }, make(a));
    const agentRes = handleRest('portal_quote_accept', make(b), { ...b.fx.deps, actor: 'agent' }).body;
    assert.equal(before.ok, false, `${label}: ${JSON.stringify(before)}`);
    assert.deepEqual(agentRes, before, `${label}: the agent's refusal is the one every caller gets`);
    assert.equal(b.status(), 'sent', `${label}: nothing accepted`);
    assert.equal(b.fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_action').get().n, 0, `${label}: nothing queued`);
    assert.equal(b.fx.deps.store.db.prepare("SELECT COUNT(*) AS n FROM agent_call WHERE verb = 'portal_quote_accept'").get().n, 0, `${label}: no trace, no tenant learned`);
    a.fx.deps.store.close();
    b.fx.deps.store.close();
  }
});

test('portal_quote_accept: the hosted page (no agent seat) accepts at once, as before', () => {
  const { fx, input, status } = portalWorld();
  const res = handleRest('portal_quote_accept', input, { ...fx.deps, actor: 'studio' }).body;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.drafted, undefined);
  assert.equal(status(), 'accepted');
  fx.deps.store.close();
});
