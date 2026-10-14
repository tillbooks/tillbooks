/**
 * WHAT CANNOT BE UNDONE WAITS FOR A HUMAN (D156 points 3 to 5, 10.10.2026).
 *
 * Before this file only 77 of the 448 write verbs ran through the agent approval dial, and the local
 * agent sits in the owner seat, so it anonymised and merged contacts, deleted files, hard-deleted
 * master data, rewrote a Bankkonto's IBAN and switched on egress with no approval card. The population
 * is now DERIVED, not remembered: the G01 denylist tags each verb with its criterion legs
 * (`NOT_AUTOMATABLE_LEGS`), and every leg (a) "cannot be undone by another verb" and leg (f) "alters a
 * payment destination" write must be dial-governed (by name or by an input-keyed rule) or named in
 * `NOT_DIAL_GOVERNED` with its reason. A second net catches the writes the denylist does not list:
 * any write whose NAME says it deletes, purges, erases, anonymises, merges, discards, resets, unsets
 * or revokes.
 *
 * D158 WIDENED IT, after a non-author critic found five irreversible writes outside every net
 * (`set_opening_balances`, `time_lock`, `stock_stocktake_commit`, `inventory_stocktake_commit`,
 * `delivery_note_issue`): a seal, a lock or an issue never matched an erasing name. The population now
 * also holds every write whose catalogue consequence is `final` (`CONSEQUENCE_FOR_VERB`, the one
 * source of reversibility) and every write whose name says it seals, locks, commits, issues, closes,
 * finalises or posts. The bite test un-governs `time_lock` and the coverage check names it.
 *
 * The D158 critic's round 1 widened it once more: `migration_abandon_plan` (the twin of the governed
 * `migration_close_plan`) sat on denylist leg (b) and matched no name. The population now takes leg
 * (b) too (legs a, b and f), and `abandon` joins the sealing names.
 *
 * HOW IT BITES: the coverage check is a function of the map it is handed, and the bite test hands it
 * the real map with `contacts_anonymise` removed: the verb is named at once. The behavioural tests
 * drive the REAL transport seam (`handleRest` and MCP `callTool`) as the agent seat: an erase verb
 * returns a Vorschlag and touches nothing, `confirmed: true` from the agent changes nothing, the agent
 * cannot approve or grant its own way past it, and the human's approval is what runs the verb.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { makeContext } from '../../dist/core/context.js';
import {
  DIAL_CAPABILITIES,
  STRONG_DEFAULT_ASK_CAPABILITIES,
  DIAL_CAPABILITY_FOR_ACTION,
  INPUT_KEYED_DIAL_RULES,
  NOT_DIAL_GOVERNED,
  APPROVAL_CONFIRMS_FIELD,
  APPROVAL_CONFIRM_NOT_SET,
  dialCapabilityForCall,
  approveDraftedAction,
  enqueueDraftedAction,
  setAgentDial,
} from '../../dist/core/agent/index.js';
import { CONSEQUENCE_FOR_VERB } from '../../dist/core/agent/consequences.js';
import { denylistVerbsOnLeg } from '../../dist/core/automation/denylist.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);
const approve = (deps, workspaceId, actionId) => human(deps, 'approve_drafted_action', { workspaceId, actionId });

const WRITES = ACTIONS.filter((a) => a.kind === 'write');
const WRITE_NAMES = new Set(WRITES.map((a) => a.name));

/** A write whose name says it removes something, the second net beside the denylist legs. */
const ERASING_NAME = /delete|purge|erase|anonymi|merge|discard|wipe|reset|unset|revoke|destroy/;

/**
 * D156 critic F2: a write whose name says it sends, transmits, publishes, exports, connects, grants,
 * syncs or opens a portal, the third net: what leaves the machine or opens access from outside.
 */
const EGRESS_NAME = /send|transmit|publish|export|connect|grant|sync|portal|ebill|share/;

/**
 * D158: a write whose name says it seals, locks, commits, issues, closes, finalises or posts, the fourth
 * net: the act that makes something final (a period, a count, a document, a position). `opening` joins
 * it: an opening position is the one posting the books start from, and `set_opening_balances` (the
 * first of the five the critic found) is named by neither "post" nor any other pattern.
 */
const SEALING_NAME = /seal|lock|commit|issue|close|finali[sz]e|post|opening|abandon/;

/** D158: every write the one consequence catalogue says has no way back inside TILL. */
const FINAL_WRITES = Object.entries(CONSEQUENCE_FOR_VERB)
  .filter(([verb, c]) => c.reversibility === 'final' && WRITE_NAMES.has(verb))
  .map(([verb]) => verb);

/**
 * The writes nothing may leave ungoverned in silence: leg (a), leg (f), the erasing and egress names,
 * and since D158 the sealing names and every `final` consequence.
 */
const POPULATION = [
  ...new Set([
    ...denylistVerbsOnLeg('a'),
    ...denylistVerbsOnLeg('b'),
    ...denylistVerbsOnLeg('f'),
    ...WRITES.map((a) => a.name).filter((n) => ERASING_NAME.test(n) || EGRESS_NAME.test(n) || SEALING_NAME.test(n)),
    ...FINAL_WRITES,
  ]),
].sort();

/** The coverage rule, as a function of the map, so the bite test can hand it a weakened one. */
function uncovered(byName, inputKeyed = INPUT_KEYED_DIAL_RULES, excluded = NOT_DIAL_GOVERNED) {
  const keyed = new Set(inputKeyed.map((r) => r.action));
  return POPULATION.filter((verb) => byName[verb] === undefined && !keyed.has(verb) && excluded[verb] === undefined);
}

/** The verbs this change governs, with their family (the table in the report reads the same). */
const NEWLY_GOVERNED = {
  contacts_anonymise: 'erase',
  contacts_merge: 'erase',
  files_delete: 'erase',
  delete_account: 'erase',
  delete_cost_center: 'erase',
  delete_draft: 'erase',
  delete_item: 'erase',
  item_categories_delete: 'erase',
  price_lists_delete: 'erase',
  price_lists_unset_price: 'erase',
  sign_requests_delete_draft: 'erase',
  time_delete: 'erase',
  project_delete: 'erase',
  discard_testmandant: 'erase',
  discard_orphan_testmandant: 'erase',
  discard_demo_workspace: 'erase',
  gl_archive_purge: 'erase',
  env_reset: 'erase',
  env_delete: 'erase',
  env_copy: 'erase',
  delete_backup: 'erase',
  reports_delete: 'erase',
  sync_publish_enable: 'share',
  vendor_portal_grant: 'share',
  implementation_project_close: 'go-live',
  migration_close_plan: 'go-live',
  // D156 critic F2 and Q6. D157 (owner decision 3): portal_grant_create left the dial (a draft link
  // opens nothing, NOT_DIAL_GOVERNED); the send, which activates it, stays under share.
  portal_grant_send: 'share',
  ebill_transmit: 'send',
  quotes_send: 'send',
  sign_requests_send: 'send',
  bank_channel_connect: 'pay',
  migration_record_approval: 'go-live',
};

/** A draftable input synthesized from the schema: the seam drafts BEFORE the verb reads any row. */
function draftableInput(action, workspaceId) {
  const input = { workspaceId };
  for (const field of action.inputSchema.required) {
    if (field === 'workspaceId') continue;
    const type = action.inputSchema.properties[field]?.type;
    input[field] = type === 'number' || type === 'integer' ? 1 : type === 'boolean' ? true : type === 'array' ? [] : type === 'object' ? {} : `probe-${field}`;
  }
  if ('idempotencyKey' in action.inputSchema.properties && input.idempotencyKey === undefined) input.idempotencyKey = `probe-${action.name}`;
  return input;
}

// --- the population ------------------------------------------------------------------------------

test('every leg (a), (b) and (f) write, every write named as an erasure, egress or seal, and every final write is governed or excluded in writing', () => {
  assert.ok(POPULATION.length >= 40, `the population is real (${POPULATION.length} verbs), not an empty pass`);
  assert.deepEqual(
    uncovered(DIAL_CAPABILITY_FOR_ACTION),
    [],
    'these writes cannot be undone (or alter a payment destination) yet an agent seat runs them with no Vorschlag: govern them in DIAL_CAPABILITY_FOR_ACTION (src/core/agent/dialMap.ts) or give the reason in NOT_DIAL_GOVERNED',
  );
});

test('D158: the population holds every final consequence and every sealing name, the five the critic found among them', () => {
  for (const verb of ['set_opening_balances', 'time_lock', 'stock_stocktake_commit', 'inventory_stocktake_commit', 'delivery_note_issue']) {
    assert.ok(POPULATION.includes(verb), `${verb}: in the population`);
  }
  assert.ok(FINAL_WRITES.length >= 30, `the final net is real (${FINAL_WRITES.length} verbs)`);
  for (const verb of FINAL_WRITES) assert.ok(POPULATION.includes(verb), `${verb}: a final write is in the population`);
  // The leg nets alone would not have seen them: the widening is what brings each one in.
  const legsAndNames = new Set([...denylistVerbsOnLeg('a'), ...denylistVerbsOnLeg('f')]);
  for (const verb of ['time_lock', 'delivery_note_issue', 'set_opening_balances']) {
    assert.ok(!legsAndNames.has(verb) && !ERASING_NAME.test(verb) && !EGRESS_NAME.test(verb), `${verb}: only the D158 nets reach it`);
  }
});

test('IT BITES (D158): un-governing time_lock is named at once, and so is each of the other four', () => {
  for (const verb of ['time_lock', 'set_opening_balances', 'stock_stocktake_commit', 'inventory_stocktake_commit', 'delivery_note_issue', 'checklist_abandon', 'migration_abandon_plan', 'approve_entry', 'match_bill']) {
    const weakened = { ...DIAL_CAPABILITY_FOR_ACTION };
    delete weakened[verb];
    assert.deepEqual(uncovered(weakened), [verb], `${verb}: un-governed, it must surface`);
  }
  // Critic round 1: leg (b) is load-bearing on its own (migration_abandon_plan matches no name but
  // `abandon`), and so is the `abandon` name: each net alone names it once the other is removed.
  assert.ok(denylistVerbsOnLeg('b').includes('migration_abandon_plan') && SEALING_NAME.test('migration_abandon_plan'));
  // A leg (b) exclusion is load-bearing too. (D161 governed the two this used to name,
  // `vat_saldo_declaration_basis` under vat-file and `goods_receipt_post` under stock, so it now drops
  // the leg (b) exclusion `accrual_create` and the D158 surfaced `po_close_short`.)
  assert.ok(denylistVerbsOnLeg('b').includes('accrual_create'), 'premise: accrual_create sits on leg (b)');
  const { accrual_create: _ac, ...noAccrual } = NOT_DIAL_GOVERNED;
  assert.deepEqual(uncovered(DIAL_CAPABILITY_FOR_ACTION, INPUT_KEYED_DIAL_RULES, noAccrual), ['accrual_create']);
  // An exclusion added for a D158 surfaced verb is load-bearing too.
  const { po_close_short: _pc, ...fewer } = NOT_DIAL_GOVERNED;
  assert.deepEqual(uncovered(DIAL_CAPABILITY_FOR_ACTION, INPUT_KEYED_DIAL_RULES, fewer), ['po_close_short']);
  // D161: the two the old cases named are governed now, so un-governing either is named too.
  for (const verb of ['vat_saldo_declaration_basis', 'goods_receipt_post']) {
    const weakened = { ...DIAL_CAPABILITY_FOR_ACTION };
    delete weakened[verb];
    assert.deepEqual(uncovered(weakened), [verb], `${verb}: un-governed, it must surface`);
  }
});

test('IT BITES: un-governing one erase verb is named at once', () => {
  const weakened = { ...DIAL_CAPABILITY_FOR_ACTION };
  delete weakened.contacts_anonymise;
  assert.deepEqual(uncovered(weakened), ['contacts_anonymise']);
  // The egress net is load-bearing too: un-govern the customer-portal send and it is named.
  const noPortal = { ...DIAL_CAPABILITY_FOR_ACTION };
  delete noPortal.portal_grant_send;
  assert.deepEqual(uncovered(noPortal), ['portal_grant_send']);
  // D157: the ungoverned create is covered by its written reason, and only by it.
  const { portal_grant_create: _create, ...noCreateReason } = NOT_DIAL_GOVERNED;
  assert.deepEqual(uncovered(DIAL_CAPABILITY_FOR_ACTION, INPUT_KEYED_DIAL_RULES, noCreateReason), ['portal_grant_create']);
  // And the input-keyed rule is load-bearing for the Bankkonto, not decorative.
  const noBankRule = INPUT_KEYED_DIAL_RULES.filter((r) => r.action !== 'update_bank_account');
  assert.deepEqual(uncovered(DIAL_CAPABILITY_FOR_ACTION, noBankRule), ['update_bank_account']);
  // And an exclusion is load-bearing too: drop one reason and its verb surfaces.
  const { vendor_portal_revoke: _dropped, ...fewer } = NOT_DIAL_GOVERNED;
  assert.deepEqual(uncovered(DIAL_CAPABILITY_FOR_ACTION, INPUT_KEYED_DIAL_RULES, fewer), ['vendor_portal_revoke']);
});

test('NOT_DIAL_GOVERNED holds no stale entry: each is a registered, ungoverned write with a real reason', () => {
  const keyed = new Set(INPUT_KEYED_DIAL_RULES.map((r) => r.action));
  for (const [verb, reason] of Object.entries(NOT_DIAL_GOVERNED)) {
    assert.ok(WRITE_NAMES.has(verb), `${verb}: a registered write`);
    assert.equal(DIAL_CAPABILITY_FOR_ACTION[verb], undefined, `${verb}: governed by name now, drop the exclusion`);
    assert.ok(!keyed.has(verb), `${verb}: governed by an input-keyed rule now, drop the exclusion`);
    assert.ok(typeof reason === 'string' && reason.length > 40, `${verb}: a reason is a statement about the code`);
  }
  assert.match(NOT_DIAL_GOVERNED.restore_backup, /pre-workspace/);
  assert.match(NOT_DIAL_GOVERNED.restore_backup, /brand-new workspace/);
});

test('the newly governed verbs sit in their family, and each states its own consequence in both locales', () => {
  for (const [verb, family] of Object.entries(NEWLY_GOVERNED)) {
    assert.equal(DIAL_CAPABILITY_FOR_ACTION[verb], family, `${verb}: governed under ${family}`);
    const own = CONSEQUENCE_FOR_VERB[verb];
    assert.ok(own, `${verb}: a sentence of its own, not only the family fallback`);
    assert.ok(own.en.length > 20 && own['de-CH'].length > 20, `${verb}: both locales`);
    assert.equal(getAction(verb).consequence, own.en, `${verb}: the MCP description carries it`);
  }
  assert.ok(CONSEQUENCE_FOR_VERB.update_bank_account, 'the input-keyed Bankkonto rule has its own sentence');
  for (const verb of Object.keys(NEWLY_GOVERNED).filter((v) => NEWLY_GOVERNED[v] === 'erase')) {
    assert.equal(CONSEQUENCE_FOR_VERB[verb].reversibility, 'final', `${verb}: an erasure has no way back`);
  }
});

test('erase and share are dial families with an ORDINARY ask default (D156.4), not strong defaults', () => {
  for (const family of ['erase', 'share']) {
    assert.ok(DIAL_CAPABILITIES.includes(family), `${family} is a dial capability`);
    assert.equal(STRONG_DEFAULT_ASK_CAPABILITIES.has(family), false, `${family}: an ordinary ask`);
  }
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const dial = human(deps, 'get_agent_dial', { workspaceId });
  for (const family of ['erase', 'share']) {
    const row = dial.rows.find((r) => r.capability === family);
    assert.deepEqual([row.stored, row.effective, row.strongDefault], ['ask', 'ask', false], `${family}: ask by default`);
  }
  deps.store.close();
});

// --- the seam: a governed erase verb proposes, it does not execute ---------------------------------

test('CONFORMANCE: every name-keyed erase, share and close verb called by the agent seat returns a Vorschlag, never an execution', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  for (const verb of Object.keys(NEWLY_GOVERNED)) {
    const input = draftableInput(getAction(verb), workspaceId);
    const res = rest(deps, verb, input);
    assert.equal(res.ok, true, `${verb}: ${JSON.stringify(res)}`);
    assert.equal(res.drafted, true, `${verb}: the agent seat proposes, it does not act`);
    assert.equal(res.dialCapability, NEWLY_GOVERNED[verb], `${verb}: drafted under its family`);
    assert.equal(res.reason, 'dial_ask', `${verb}: the ordinary ask, not a forced one`);
    const pending = deps.store.db
      .prepare("SELECT status, dial_capability FROM agent_action WHERE workspace_id = ? AND action_tool = ?")
      .all(workspaceId, verb);
    assert.deepEqual(pending, [{ status: 'pending', dial_capability: NEWLY_GOVERNED[verb] }], `${verb}: one pending Vorschlag`);
    const trace = deps.store.db.prepare('SELECT mode FROM agent_call WHERE workspace_id = ? AND verb = ?').all(workspaceId, verb);
    assert.deepEqual(trace.map((r) => r.mode), ['draft'], `${verb}: traced as a draft, never an execute`);
  }
  deps.store.close();
});

test('contacts_anonymise over MCP: the agent proposes, the contact is untouched until a human approves', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const created = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Hanna Probe', email: 'hanna@example.ch', idempotencyKey: 'c1' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const contactId = created.contact.id;
  const nameOf = () => deps.store.db.prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?').get(workspaceId, contactId).name;

  const drafted = mcp(deps, 'contacts_anonymise', { workspaceId, contactId, idempotencyKey: 'anon-1' });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(drafted.dialCapability, 'erase');
  assert.equal(nameOf(), 'Hanna Probe', 'nothing was erased by the proposal');

  const approved = approve(deps, workspaceId, drafted.actionId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.notEqual(nameOf(), 'Hanna Probe', 'the human approval is what erases');
  deps.store.close();
});

test('D157: the agent seat prepares a customer portal draft freely, and activating it waits for a human', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const created = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Portal Probe AG', idempotencyKey: 'pc' });
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.portal_grant_create, undefined, 'the create is not dial-governed');
  assert.match(NOT_DIAL_GOVERNED.portal_grant_create, /^a draft link opens nothing until portal_grant_send, which stays governed/);
  assert.equal(CONSEQUENCE_FOR_VERB.portal_grant_create, undefined, 'an ungoverned write carries no consequence sentence');
  assert.equal(getAction('portal_grant_create').consequence, undefined);

  // The agent's create EXECUTES (no Vorschlag) and lands a draft whose token opens nothing.
  const draft = rest(deps, 'portal_grant_create', { workspaceId, contactId: created.contact.id, scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30', idempotencyKey: 'pg' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.drafted, undefined, 'preparing a draft link is free for the agent');
  assert.equal(draft.grant.status, 'draft');
  assert.equal(human(deps, 'portal_resolve', { token: draft.tokenOnce }).error, 'grant_denied');

  // The agent's send, confirmed:true included, is a Vorschlag under share: the link stays dead.
  const send = mcp(deps, 'portal_grant_send', { workspaceId, grantId: draft.grantId, confirmed: true, idempotencyKey: 'ps' });
  assert.equal(send.drafted, true, JSON.stringify(send));
  assert.equal(send.dialCapability, 'share');
  assert.equal(human(deps, 'portal_resolve', { token: draft.tokenOnce }).error, 'grant_denied', 'the proposal opened the link');

  // The human approval is what opens it.
  const approved = approve(deps, workspaceId, send.actionId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(human(deps, 'portal_resolve', { token: draft.tokenOnce }).ok, true, 'the approved send did not activate the link');
  deps.store.close();
});

// --- point 5: confirmed:true from the agent is not a way past the dial ------------------------------

async function uploadAsAgent(deps, workspaceId, seed) {
  const up = rest(deps, 'files_upload', {
    workspaceId,
    title: `Beleg ${seed}`,
    filename: `${seed}.pdf`,
    mime: 'application/pdf',
    contentBase64: Buffer.from(`inhalt ${seed}`).toString('base64'),
    idempotencyKey: `${seed}-up`,
  });
  assert.equal(up.ok, true, JSON.stringify(up));
  return up.file.id;
}

const fileExists = (deps, workspaceId, fileId) =>
  deps.store.db.prepare('SELECT 1 AS p FROM stored_file WHERE workspace_id = ? AND id = ?').get(workspaceId, fileId) !== undefined;

test('files_delete: an agent passing confirmed:true on its own still DRAFTS; the file survives until the human approves', async () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const fileId = await uploadAsAgent(deps, workspaceId, 'f1');

  const res = rest(deps, 'files_delete', { workspaceId, fileId, confirmed: true, idempotencyKey: 'del-1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.drafted, true, 'confirmed:true is the agent saying yes to itself: the dial still asks');
  assert.equal(res.deleted, undefined);
  assert.equal(fileExists(deps, workspaceId, fileId), true, 'nothing was erased');

  const approved = approve(deps, workspaceId, res.actionId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.result.deleted, true, 'the approval runs the deletion');
  assert.equal(fileExists(deps, workspaceId, fileId), false);
  deps.store.close();
});

test('files_delete: an approved draft the agent made WITHOUT confirmed satisfies the confirm step (no second staging)', async () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const fileId = await uploadAsAgent(deps, workspaceId, 'f2');

  const res = rest(deps, 'files_delete', { workspaceId, fileId, idempotencyKey: 'del-2' });
  assert.equal(res.drafted, true, JSON.stringify(res));
  assert.equal(
    deps.store.db.prepare('SELECT pending_delete FROM stored_file WHERE workspace_id = ? AND id = ?').get(workspaceId, fileId).pending_delete,
    0,
    'the proposal stages nothing on the row either',
  );
  const approved = approve(deps, workspaceId, res.actionId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.result.deleted, true);
  assert.equal(approved.result.staged, undefined, 'the approval IS the confirmation');
  deps.store.close();
});

test('the approval replay carries the confirm field for every confirm-gated erase verb, and leaves the stored payload alone', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const agentCtx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
  const humanCtx = makeContext(deps.store, { workspaceId, actor: 'studio', clock: deps.clock, ids: deps.ids });
  assert.deepEqual(Object.keys(APPROVAL_CONFIRMS_FIELD).filter((v) => DIAL_CAPABILITY_FOR_ACTION[v] === undefined), [], 'only governed verbs');
  for (const [verb, field] of Object.entries(APPROVAL_CONFIRMS_FIELD)) {
    assert.ok(field in getAction(verb).inputSchema.properties, `${verb}: '${field}' is a real input field`);
    const payload = { workspaceId, probe: verb, idempotencyKey: `k-${verb}` };
    const queued = enqueueDraftedAction(agentCtx, { actionTool: verb, payload, dialCapability: DIAL_CAPABILITY_FOR_ACTION[verb] });
    let seen;
    const res = approveDraftedAction(humanCtx, (name, input, actor) => {
      seen = { name, input, actor };
      return { ok: true };
    }, { actionId: queued.actionId });
    assert.equal(res.ok, true, `${verb}: ${JSON.stringify(res)}`);
    assert.equal(seen.name, verb);
    assert.equal(seen.actor, 'studio', `${verb}: replayed as the approving human`);
    assert.equal(seen.input[field], true, `${verb}: the approval satisfies '${field}'`);
    const stored = JSON.parse(deps.store.db.prepare('SELECT payload_json FROM agent_action WHERE id = ?').get(queued.actionId).payload_json);
    assert.equal(stored[field], undefined, `${verb}: the stored payload is what the agent drafted`);
  }
  // A verb outside the map replays its payload untouched.
  const plain = enqueueDraftedAction(agentCtx, { actionTool: 'contacts_merge', payload: { workspaceId, sourceId: 's', targetId: 't' }, dialCapability: 'erase' });
  let plainInput;
  approveDraftedAction(humanCtx, (_n, input) => { plainInput = input; return { ok: true }; }, { actionId: plain.actionId });
  assert.equal('confirmed' in plainInput, false);
  deps.store.close();
});

test('every governed verb with a confirm step is either satisfied by the approval or excluded in writing', () => {
  const CONFIRM_LIKE = /^confirm/;
  for (const [verb] of Object.entries(DIAL_CAPABILITY_FOR_ACTION)) {
    const fields = Object.keys(getAction(verb).inputSchema.properties).filter((f) => CONFIRM_LIKE.test(f));
    if (fields.length === 0) continue;
    const set = APPROVAL_CONFIRMS_FIELD[verb];
    const notSet = APPROVAL_CONFIRM_NOT_SET[verb];
    assert.ok((set === undefined) !== (notSet === undefined), `${verb} (${fields.join(', ')}): in exactly one of APPROVAL_CONFIRMS_FIELD and APPROVAL_CONFIRM_NOT_SET`);
    if (set !== undefined) assert.ok(fields.includes(set), `${verb}: '${set}' is its confirm field`);
  }
  for (const verb of Object.keys(APPROVAL_CONFIRM_NOT_SET)) assert.ok(DIAL_CAPABILITY_FOR_ACTION[verb], `${verb}: a governed verb`);
});

test('TABLE: for every confirm-gated governed verb, an agent passing the confirm field itself still drafts and nothing runs', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  for (const [verb, field] of Object.entries(APPROVAL_CONFIRMS_FIELD)) {
    const input = { ...draftableInput(getAction(verb), workspaceId), [field]: true };
    const res = rest(deps, verb, input);
    assert.equal(res.ok, true, `${verb}: ${JSON.stringify(res)}`);
    assert.equal(res.drafted, true, `${verb}: '${field}: true' from the agent is not a way past the dial`);
    const trace = deps.store.db.prepare('SELECT mode FROM agent_call WHERE workspace_id = ? AND verb = ?').all(workspaceId, verb);
    assert.deepEqual(trace.map((r) => r.mode), ['draft'], `${verb}: traced as a draft only`);
  }
  deps.store.close();
});

test('wage_journal_post end to end: an agent draft WITHOUT confirm posts once on approval (it used to replay as a preview)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const postedCount = () =>
    deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(workspaceId).n;
  const before = postedCount();
  const drafted = rest(deps, 'wage_journal_post', {
    workspaceId,
    entryDate: '2026-05-31',
    lines: [
      { accountNumber: '5000', debitMinor: 500000, description: 'Bruttolohn' },
      { accountNumber: '5700', debitMinor: 50000, description: 'AG-Sozialbeitraege' },
      { accountNumber: '2260', creditMinor: 550000, description: 'Nettolohn' },
    ],
    idempotencyKey: 'wage-05',
  });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(postedCount(), before, 'the proposal posts nothing');
  const approved = approve(deps, workspaceId, drafted.actionId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(postedCount(), before + 1, 'the approval posts the wage journal, not a preview');
  // Approve-twice settles: the stored result replays, nothing posts again (§H-IDEMPOTENT).
  assert.equal(approve(deps, workspaceId, drafted.actionId).ok, true);
  assert.equal(postedCount(), before + 1);
  deps.store.close();
});

test('files_delete called past the seam by a SERVED agent member stages, like the local agent (isGovernedSeat)', async () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const fileId = await uploadAsAgent(deps, workspaceId, 'f3');
  const invite = human(deps, 'invite_member', { workspaceId, email: 'bot@seeblick.example', role: 'owner', kind: 'agent', idempotencyKey: 'inv-bot' });
  assert.equal(invite.ok, true, JSON.stringify(invite));
  const served = () => {
    const id = resolveServedActor(deps.store, 'bot@seeblick.example');
    return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
  };
  assert.equal(getAction('accept_invite').run(served(), { token: invite.token }).ok, true);
  const bot = served();

  const staged = getAction('files_delete').run(bot, { workspaceId, fileId, idempotencyKey: 'bot-del' });
  assert.equal(staged.ok, true, JSON.stringify(staged));
  assert.equal(staged.staged, true, 'the in-verb belt stages a served agent member too');
  assert.equal(fileExists(deps, workspaceId, fileId), true);
  // Through the seam the same member drafts, confirmed or not.
  const drafted = rest(bot, 'files_delete', { workspaceId, fileId, confirmed: true, idempotencyKey: 'bot-del-2' });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(fileExists(deps, workspaceId, fileId), true);
  deps.store.close();
});

// --- the agent cannot approve or grant its own way past the new families ----------------------------

test('the agent can neither approve its own erase Vorschlag nor grant itself erase or share', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const drafted = rest(deps, 'contacts_merge', { workspaceId, sourceId: 'a', targetId: 'b', idempotencyKey: 'm1' });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));

  for (const allowFuture of [false, true]) {
    const self = rest(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId, allowFuture });
    assert.equal(self.ok, false);
    assert.ok(self.error === 'permission_denied' || self.error === 'cannot_self_approve', self.error);
  }
  const engineSelf = approveDraftedAction(
    makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids }),
    () => {
      throw new Error('the invoker must not be reached on a refused self-approve');
    },
    { actionId: drafted.actionId, allowFuture: true },
  );
  assert.equal(engineSelf.error, 'cannot_self_approve');

  for (const capability of ['erase', 'share']) {
    const grant = rest(deps, 'set_agent_dial', { workspaceId, capability, level: 'auto', idempotencyKey: `g-${capability}` });
    assert.equal(grant.ok, false, `${capability}: ${JSON.stringify(grant)}`);
    assert.ok(grant.error === 'permission_denied' || grant.error === 'cannot_self_grant', grant.error);
    const engine = setAgentDial(makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids }), {
      capability,
      level: 'auto',
      idempotencyKey: `ge-${capability}`,
    });
    assert.equal(engine.error, 'cannot_self_grant');
  }
  const dial = human(deps, 'get_agent_dial', { workspaceId });
  assert.equal(dial.levels.erase, 'ask');
  assert.equal(dial.levels.share, 'ask');
  assert.equal(
    deps.store.db.prepare("SELECT status FROM agent_action WHERE workspace_id = ? AND id = ?").get(workspaceId, drafted.actionId).status,
    'pending',
  );
  deps.store.close();
});

test('a HUMAN grant of erase to auto lets the agent erase; revoking it to ask drafts again', async () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const g = human(deps, 'set_agent_dial', { workspaceId, capability: 'erase', level: 'auto', idempotencyKey: 'h-g' });
  assert.equal(g.ok, true, JSON.stringify(g));
  const fileId = await uploadAsAgent(deps, workspaceId, 'f4');
  const done = rest(deps, 'files_delete', { workspaceId, fileId, confirmed: true, idempotencyKey: 'auto-del' });
  assert.equal(done.deleted, true, JSON.stringify(done));
  human(deps, 'set_agent_dial', { workspaceId, capability: 'erase', level: 'ask', idempotencyKey: 'h-r' });
  const fileId2 = await uploadAsAgent(deps, workspaceId, 'f5');
  const again = rest(deps, 'files_delete', { workspaceId, fileId: fileId2, confirmed: true, idempotencyKey: 'ask-del' });
  assert.equal(again.drafted, true, JSON.stringify(again));
  deps.store.close();
});

// --- the Bankkonto: payment details draft at pay, a rename stays free -------------------------------

test('update_bank_account: a rename executes, an IBAN, currency or ledger-account change drafts under pay', () => {
  assert.equal(dialCapabilityForCall('update_bank_account', { bankAccountId: 'b', name: 'Neu' }), undefined);
  for (const field of ['iban', 'currency', 'ledgerAccountId']) {
    assert.equal(dialCapabilityForCall('update_bank_account', { bankAccountId: 'b', [field]: 'x' }), 'pay', field);
  }

  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const ledger = deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, '1020').id;
  const created = human(deps, 'create_bank_account', { workspaceId, name: 'PostFinance', iban: 'CH9300762011623852957', ledgerAccountId: ledger, idempotencyKey: 'ba' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const bankAccountId = created.bankAccountId;
  const ibanOf = () => deps.store.db.prepare('SELECT iban, name FROM bank_account WHERE workspace_id = ? AND id = ?').get(workspaceId, bankAccountId);

  const renamed = rest(deps, 'update_bank_account', { workspaceId, bankAccountId, name: 'Geschäftskonto', idempotencyKey: 'rn' });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(renamed.drafted, undefined, 'a rename is cosmetic and stays free');
  assert.equal(ibanOf().name, 'Geschäftskonto');

  const moved = rest(deps, 'update_bank_account', { workspaceId, bankAccountId, iban: 'CH5604835012345678009', idempotencyKey: 'ib' });
  assert.equal(moved.drafted, true, JSON.stringify(moved));
  assert.equal(moved.dialCapability, 'pay');
  assert.equal(ibanOf().iban, 'CH9300762011623852957', 'the IBAN is untouched by the proposal');
  const approved = approve(deps, workspaceId, moved.actionId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(ibanOf().iban, 'CH5604835012345678009', 'the approval applies it');
  deps.store.close();
});

// --- Q6: the G09 approval a money-path commit is gated on is a human's, or a drafted proposal ------

test('migration_record_approval: the agent seat proposes, the approval is recorded as the approving human', async () => {
  const { SCENARIOS, fixture } = await import('../api/conformance-contract.mjs');
  const fx = fixture();
  const input = SCENARIOS.migration_record_approval(fx);
  const approvals = () => fx.deps.store.db.prepare('SELECT actor FROM migration_approval WHERE workspace_id = ?').all(fx.workspaceId);
  assert.deepEqual(approvals(), []);

  const drafted = rest({ ...fx.deps, actor: 'agent' }, 'migration_record_approval', input);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(drafted.dialCapability, 'go-live');
  assert.deepEqual(approvals(), [], 'the agent records no approval of its own');

  const approved = approve(fx.deps, fx.workspaceId, drafted.actionId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(approvals(), [{ actor: 'studio' }], 'the approval row names the human who approved');
  fx.deps.store.close();
});

// --- critic nit: an environment verb reads the most restrictive dial on the instance ---------------

test('env_delete, env_reset and env_copy execute at auto only when EVERY workspace on the instance granted erase', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Echte Bücher AG', 'ws-a').workspaceId;
  const b = mintWorkspace(deps, 'Spielwiese GmbH', 'ws-b').workspaceId;
  assert.notEqual(a, b);
  const lastCall = (workspaceId, verb) =>
    deps.store.db.prepare('SELECT mode, decision_reason FROM agent_call WHERE workspace_id = ? AND verb = ? ORDER BY rowid DESC LIMIT 1').get(workspaceId, verb);

  // A grant in the scratch workspace alone does not authorise an instance-wide wipe from it.
  assert.equal(human(deps, 'set_agent_dial', { workspaceId: b, capability: 'erase', level: 'auto', idempotencyKey: 'g-b' }).ok, true);
  for (const verb of ['env_delete', 'env_reset', 'env_copy']) {
    const input = verb === 'env_copy' ? { workspaceId: b, source: 'staging', target: 'dev', idempotencyKey: `${verb}-1` } : { workspaceId: b, name: 'dev', idempotencyKey: `${verb}-1` };
    const res = rest(deps, verb, input);
    assert.equal(res.drafted, true, `${verb}: ${JSON.stringify(res)}`);
    assert.equal(lastCall(b, verb).decision_reason, 'dial_ask');
  }
  // A per-workspace verb in the same workspace follows that workspace's own grant, as before.
  assert.equal(rest(deps, 'contacts_merge', { workspaceId: b, sourceId: 'x', targetId: 'y', idempotencyKey: 'm-b' }).drafted, undefined);

  // Once every workspace granted it, the env verb runs (its own landscape checks answer).
  assert.equal(human(deps, 'set_agent_dial', { workspaceId: a, capability: 'erase', level: 'auto', idempotencyKey: 'g-a' }).ok, true);
  rest(deps, 'env_delete', { workspaceId: b, name: 'dev', idempotencyKey: 'env_delete-2' });
  assert.deepEqual(lastCall(b, 'env_delete'), { mode: 'execute', decision_reason: 'dial_auto' });
  deps.store.close();
});
