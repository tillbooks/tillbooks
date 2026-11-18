// @ts-nocheck
/**
 * D209 AMENDMENT (owner, 18.11.2026, after an automated security review: TILL cannot verify a quote the agent
 * supplies): filing the VAT return (`vat-file`), installing or starting a plugin (`plugin-install`) and sharing
 * data with someone outside (`share`) ALWAYS wait for a person's click; the owner's word never approves them.
 *
 * Written for a NON-AUTHOR critic to read: each test counts the rows that prove it, never a returned `ok` alone.
 *
 *  - each of the three families refuses on the owner's word (`permission_denied`, `owner_word_excluded`, the
 *    family named, `approveAt`), the Vorschlag stays pending with no history and no audit row, and the SAME
 *    Vorschlag then runs on a person's click;
 *  - a non-excluded verb (`import_bank_statement`) still approves on the owner's word;
 *  - a call that drafts under several families, one of them excluded, refuses even when the stored family is
 *    not excluded (every family `dialCapabilitiesForCall` names is tested); no readable family fails closed;
 *  - D172: the set is the human-only setting `agent.owner_word_excluded` (default the three); a person may
 *    shrink or grow it, the agent cannot change it, a bad value is refused, and a row whose setter no longer
 *    holds the right never shrinks the default (fail closed);
 *  - tenant isolation: one workspace's setting changes nothing in another;
 *  - whoami names the families in force.
 *
 * All data is synthetic (fresh in-memory workspaces, invented names and bank lines).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { ownerWordExclusionFor } from '../../dist/core/agent/decisionGrant.js';
import { freshDeps, mintWorkspace, manualPost } from './support.mjs';

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const mcp = (deps, name, input) => JSON.parse(callTool(deps, name, input).content[0].text);
const asStudio = (deps) => ({ ...deps, actor: 'studio' });
const asAgent = (deps) => ({ ...deps, actor: 'agent' });
const human = (deps, name, input) => getAction(name).run(asStudio(deps), input);

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
const rowOf = (w, id) => w.deps.store.db.prepare('SELECT status, history_json FROM agent_action WHERE workspace_id = ? AND id = ?').get(w.ws, id);
const historyOf = (w, id) => JSON.parse(rowOf(w, id).history_json ?? '[]');
const auditRows = (w, id) =>
  count(w.deps.store.db, "SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_kind = 'agent_action' AND entity_id = ? AND action = 'approve_on_owner_word'", w.ws, id);

// The fixture clock is pinned at 2026-07-16T00:00:00Z (`support.mjs`), so every draft is made then.
const WORD = { quote: 'Ja, das ist genehmigt, bitte ausführen.', saidAt: '2026-07-16T00:00:00Z' };

function world(seed, deps = freshDeps()) {
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Muster GmbH', `${seed}-ws`);
  return { deps, ws: workspaceId, accId };
}

let n = 0;
function setSetting(w, key, value) {
  n += 1;
  const r = human(w.deps, 'settings_set', { workspaceId: w.ws, key, value, reason: 'D209 amendment test', idempotencyKey: `ex-${n}` });
  assert.equal(r.ok, true, JSON.stringify(r));
}
const wordOn = (w) => setSetting(w, 'agent.approve_on_owner_word', 'on');

/** The refusal every excluded case must give, and the untouched row behind it. */
function assertRefusedFor(w, id, r, family) {
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.error, 'permission_denied', JSON.stringify(r));
  assert.equal(r.reason, 'owner_word_excluded');
  assert.equal(r.ownerWordExclusion, 'excluded_family');
  assert.equal(r.family, family);
  assert.equal(r.setting, 'agent.owner_word_excluded');
  assert.equal(r.capability, 'manage_agent_dial');
  assert.equal(rowOf(w, id).status, 'pending', 'the Vorschlag waits for the person');
  assert.deepEqual(historyOf(w, id), [], 'no decision recorded');
  assert.equal(auditRows(w, id), 0, 'no owner\'s-word audit row');
}

// --- the three families ---------------------------------------------------------------------------

test('vat-file: the owner\'s word never approves it (both doors); a person\'s click still runs it', () => {
  const w = world('vat');
  wordOn(w);
  const d = rest(asAgent(w.deps), 'update_company_profile', { workspaceId: w.ws, mwstNo: 'CHE-123.456.788 MWST' });
  assert.equal(d.drafted, true, JSON.stringify(d));
  const mwstNo = () => w.deps.store.db.prepare('SELECT mwst_no AS v FROM workspace WHERE id = ?').get(w.ws).v;
  const before = mwstNo();

  const viaRest = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId, ownerWord: WORD });
  assertRefusedFor(w, d.actionId, viaRest, 'vat-file');
  assert.equal(viaRest.approveAt?.path, '/agent', 'the refusal points to where the person approves');
  const viaMcp = mcp(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId, ownerWord: WORD });
  assertRefusedFor(w, d.actionId, viaMcp, 'vat-file');
  const batch = rest(asAgent(w.deps), 'approve_drafted_actions', { workspaceId: w.ws, ids: [d.actionId], ownerWord: WORD });
  assert.equal(batch.okCount ?? 0, 0, JSON.stringify(batch));
  assertRefusedFor(w, d.actionId, batch.items[0].refusal, 'vat-file');
  assert.equal(mwstNo(), before, 'nothing ran');

  const click = human(w.deps, 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId });
  assert.equal(click.ok, true, JSON.stringify(click));
  assert.equal(rowOf(w, d.actionId).status, 'executed');
  assert.equal(mwstNo(), 'CHE-123.456.788 MWST', 'the person\'s click ran it');
  w.deps.store.close();
});

test('share: the owner\'s word never sends a feedback report out; a person\'s click still writes it', () => {
  // The support verbs read the support directory per call (`TILL_SUPPORT_DIR`): a throwaway one, never ~/.till.
  const dir = mkdtempSync(join(tmpdir(), 'till-d209ex-'));
  const saved = process.env.TILL_SUPPORT_DIR;
  process.env.TILL_SUPPORT_DIR = dir;
  try {
    const w = world('share');
    wordOn(w);
    const d = rest(asAgent(w.deps), 'prepare_feedback', { workspaceId: w.ws, subject: 'Testbericht', message: 'Erfundener Text.', idempotencyKey: 'd209-excluded-share-1' });
    assert.equal(d.drafted, true, JSON.stringify(d));
    const reports = () => {
      try {
        return readdirSync(join(dir, 'feedback')).length;
      } catch {
        return 0;
      }
    };

    assertRefusedFor(w, d.actionId, rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId, ownerWord: WORD }), 'share');
    assert.equal(reports(), 0, 'no report written');

    const click = human(w.deps, 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId });
    assert.equal(click.ok, true, JSON.stringify(click));
    assert.equal(rowOf(w, d.actionId).status, 'executed');
    assert.equal(reports(), 1, 'the person\'s click wrote it');
    w.deps.store.close();
  } finally {
    if (saved === undefined) delete process.env.TILL_SUPPORT_DIR;
    else process.env.TILL_SUPPORT_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin-install: the owner\'s word never starts a plugin; a person\'s click still does', () => {
  const w = world('plug');
  const payload = 'plugin-d209ex';
  const installed = human(w.deps, 'install_plugin', {
    workspaceId: w.ws,
    source: 'local',
    packageRef: {
      manifest: {
        name: 'Extension d209ex',
        version: '1.0.0',
        compat_range: '^1.0.0',
        sha256: createHash('sha256').update(payload).digest('hex'),
        capabilities: [{ kind: 'mcp_tool', name: 'acme_d209ex' }],
        permissions: { requested: [] },
      },
      payload,
    },
    idempotencyKey: 'plug-install',
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const pluginId = installed.plugin.id;
  assert.equal(human(w.deps, 'disable_plugin', { workspaceId: w.ws, pluginId, idempotencyKey: 'plug-off' }).ok, true);
  const statusOf = () => w.deps.store.db.prepare('SELECT status FROM plugin_manifests WHERE workspace_id = ? AND id = ?').get(w.ws, pluginId).status;
  wordOn(w);

  const d = rest(asAgent(w.deps), 'enable_plugin', { workspaceId: w.ws, pluginId, idempotencyKey: 'plug-on' });
  assert.equal(d.drafted, true, JSON.stringify(d));
  assertRefusedFor(w, d.actionId, rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId, ownerWord: WORD }), 'plugin-install');
  assert.equal(statusOf(), 'disabled', 'nothing started');

  const click = human(w.deps, 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId });
  assert.equal(click.ok, true, JSON.stringify(click));
  assert.equal(statusOf(), 'installed', 'the person\'s click started it');
  w.deps.store.close();
});

// --- what still runs on the owner's word ----------------------------------------------------------

test('a non-excluded verb: an import_bank_statement Vorschlag still runs on the owner\'s word, recorded once', () => {
  const w = world('imp');
  const created = human(w.deps, 'create_bank_account', {
    workspaceId: w.ws, name: 'Kantonalbank Test', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: w.accId('1020'), idempotencyKey: 'imp-bank',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const d = rest(asAgent(w.deps), 'import_bank_statement', {
    workspaceId: w.ws, bankAccountId: created.bankAccountId, content: 'Datum;Text;Betrag\n02.03.2026;Lieferant Muster;-25.00\n',
    mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' }, idempotencyKey: 'imp-csv',
  });
  assert.equal(d.drafted, true, JSON.stringify(d));
  wordOn(w);
  const r = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId, ownerWord: WORD });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ? AND bank_account_id = ?', w.ws, created.bankAccountId), 1);
  assert.equal(historyOf(w, d.actionId).filter((e) => e.event === 'decided_on_owner_word').length, 1);
  assert.equal(auditRows(w, d.actionId), 1);
  w.deps.store.close();
});

// --- every family the call can draft under --------------------------------------------------------

const REFUND = { workspaceId: 'w', bankTxnId: 't', target: { kind: 'contact', contactId: 'c', refundVat: 'keep', overrideReason: 'Kunde bleibt' }, idempotencyKey: 'k' };

test('several families: a call whose input also drafts under vat-file refuses, whatever family is stored', () => {
  const excluded = new Set(['vat-file', 'plugin-install', 'share']);
  // Stored under `pay` (not excluded); the refundVat input also governs it under vat-file.
  const hit = ownerWordExclusionFor(null, { action_tool: 'book_bank_line', dial_capability: 'pay', payload_json: JSON.stringify(REFUND) }, excluded);
  assert.equal(hit.kind, 'excluded_family');
  assert.equal(hit.family, 'vat-file');
  assert.deepEqual(hit.families, ['vat-file']);
  // The same line without refundVat is a plain pay decision: approvable on the owner's word.
  const plain = { ...REFUND, target: { kind: 'contact', contactId: 'c' } };
  assert.equal(ownerWordExclusionFor(null, { action_tool: 'book_bank_line', dial_capability: 'pay', payload_json: JSON.stringify(plain) }, excluded), null);
  // No readable family, or an unreadable payload: fail closed.
  assert.deepEqual(ownerWordExclusionFor(null, { action_tool: 'no_such_verb', dial_capability: null, payload_json: '{}' }, excluded), { kind: 'no_dial_family' });
  assert.deepEqual(ownerWordExclusionFor(null, { action_tool: 'post_entry', dial_capability: 'post', payload_json: 'not json' }, excluded), { kind: 'unreadable' });

  // End to end on rows: the engine refuses before it reads the bank line, and writes nothing.
  const w = world('multi');
  wordOn(w);
  const insert = w.deps.store.db.prepare("INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, created_at) VALUES (?, ?, 'agent', ?, ?, ?, 'pending', '2026-07-16T00:00:00Z')");
  insert.run('agent_action_multi', w.ws, 'pay', 'book_bank_line', JSON.stringify({ ...REFUND, workspaceId: w.ws }));
  assertRefusedFor(w, 'agent_action_multi', rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: 'agent_action_multi', ownerWord: WORD }), 'vat-file');
  insert.run('agent_action_nofam', w.ws, null, 'no_such_verb', JSON.stringify({ workspaceId: w.ws }));
  const nofam = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: 'agent_action_nofam', ownerWord: WORD });
  assert.equal(nofam.reason, 'owner_word_excluded', JSON.stringify(nofam));
  assert.equal(nofam.ownerWordExclusion, 'no_dial_family');
  assert.equal(rowOf(w, 'agent_action_nofam').status, 'pending');
  w.deps.store.close();
});

// --- D172: the setting ----------------------------------------------------------------------------

test('the setting: default the three; a person may shrink or grow it; the agent cannot change it; a bad value is refused', () => {
  const w = world('set');
  wordOn(w);
  const d = rest(asAgent(w.deps), 'update_company_profile', { workspaceId: w.ws, mwstNo: 'CHE-123.456.788 MWST' });
  assert.equal(d.drafted, true, JSON.stringify(d));
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId, ownerWord: WORD }).reason, 'owner_word_excluded');

  // The agent can only propose a change to a person (human-only), never apply one.
  const own = rest(asAgent(w.deps), 'settings_set', { workspaceId: w.ws, key: 'agent.owner_word_excluded', value: 'none', reason: 'ich will', idempotencyKey: 'set-agent' });
  assert.equal(own.drafted, true, JSON.stringify(own));
  assert.equal(own.reason, 'person_only');
  assert.equal(count(w.deps.store.db, "SELECT COUNT(*) AS n FROM workspace_setting WHERE workspace_id = ? AND key = 'agent.owner_word_excluded'", w.ws), 0);

  // A bad value is refused like any value its schema does not fit.
  const bad = human(w.deps, 'settings_set', { workspaceId: w.ws, key: 'agent.owner_word_excluded', value: 'vat-file,mail', reason: 'x', idempotencyKey: 'set-bad' });
  assert.equal(bad.error, 'invalid_setting_value', JSON.stringify(bad));
  assert.equal(bad.family, 'mail');
  const twice = human(w.deps, 'settings_set', { workspaceId: w.ws, key: 'agent.owner_word_excluded', value: 'share,share', reason: 'x', idempotencyKey: 'set-twice' });
  assert.equal(twice.reason, 'repeated_family', JSON.stringify(twice));
  const mixed = human(w.deps, 'settings_set', { workspaceId: w.ws, key: 'agent.owner_word_excluded', value: 'none,share', reason: 'x', idempotencyKey: 'set-mixed' });
  assert.equal(mixed.reason, 'none_beside_a_family', JSON.stringify(mixed));

  // A person grows it: post waits for the click too.
  setSetting(w, 'agent.owner_word_excluded', 'vat-file,plugin-install,share,post');
  const p = rest(asAgent(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'set-post') });
  assert.equal(p.drafted, true, JSON.stringify(p));
  const grown = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: p.actionId, ownerWord: WORD });
  assert.equal(grown.family, 'post', JSON.stringify(grown));

  // A person shrinks it to nothing: the VAT number change now runs on the owner's word, recorded once.
  setSetting(w, 'agent.owner_word_excluded', 'none');
  const shrunk = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId, ownerWord: WORD });
  assert.equal(shrunk.ok, true, JSON.stringify(shrunk));
  assert.equal(auditRows(w, d.actionId), 1);
  w.deps.store.close();
});

test('fail closed: a stored set whose setter no longer holds the right never shrinks the default', () => {
  const w = world('fc');
  wordOn(w);
  setSetting(w, 'agent.owner_word_excluded', 'none');
  const d = rest(asAgent(w.deps), 'update_company_profile', { workspaceId: w.ws, mwstNo: 'CHE-123.456.788 MWST' });
  assert.equal(d.drafted, true, JSON.stringify(d));
  // A seated workspace (a member invited), so an actor who is not a member holds nothing (the D209 test's shape).
  assert.equal(human(w.deps, 'invite_member', { workspaceId: w.ws, email: 'fc@muster.ch', role: 'viewer', idempotencyKey: 'fc-inv' }).ok, true);
  for (const setter of ['agent', 'member:gone']) {
    w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = ? WHERE workspace_id = ? AND key = 'agent.owner_word_excluded'").run(setter, w.ws);
    assertRefusedFor(w, d.actionId, rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId, ownerWord: WORD }), 'vat-file');
  }
  // A value that does not parse (written by hand) is the default too.
  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'studio', value_json = ? WHERE workspace_id = ? AND key = 'agent.owner_word_excluded'").run(JSON.stringify('nonsense'), w.ws);
  assertRefusedFor(w, d.actionId, rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId, ownerWord: WORD }), 'vat-file');
  // The bite: the same row signed by the person who still holds the right shrinks it, and the approval runs.
  w.deps.store.db.prepare("UPDATE workspace_setting SET value_json = ? WHERE workspace_id = ? AND key = 'agent.owner_word_excluded'").run(JSON.stringify('none'), w.ws);
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId, ownerWord: WORD }).ok, true);
  w.deps.store.close();
});

test('tenant isolation: one workspace shrinking the set changes nothing in another', () => {
  const deps = freshDeps();
  const a = world('iso-a', deps);
  const b = world('iso-b', deps);
  wordOn(a);
  wordOn(b);
  setSetting(a, 'agent.owner_word_excluded', 'none');
  const da = rest(asAgent(deps), 'update_company_profile', { workspaceId: a.ws, mwstNo: 'CHE-123.456.788 MWST' });
  const db = rest(asAgent(deps), 'update_company_profile', { workspaceId: b.ws, mwstNo: 'CHE-123.456.788 MWST' });
  assertRefusedFor(b, db.actionId, rest(asAgent(deps), 'approve_drafted_action', { workspaceId: b.ws, actionId: db.actionId, ownerWord: WORD }), 'vat-file');
  assert.equal(rest(asAgent(deps), 'approve_drafted_action', { workspaceId: b.ws, actionId: da.actionId, ownerWord: WORD }).error, 'not_found', 'another workspace\'s id is not found');
  assert.equal(rest(asAgent(deps), 'approve_drafted_action', { workspaceId: a.ws, actionId: da.actionId, ownerWord: WORD }).ok, true);
  assert.equal(rowOf(b, db.actionId).status, 'pending');
  deps.store.close();
});

test('whoami names the families in force, and the rule says they wait for the owner\'s click', () => {
  const w = world('who');
  wordOn(w);
  const r = rest(asAgent(w.deps), 'whoami', { workspaceId: w.ws });
  assert.deepEqual(r.approveOnOwnerWord.excludedFamilies, ['vat-file', 'plugin-install', 'share']);
  assert.match(r.approveOnOwnerWord.rule, /owner_word_excluded/);
  setSetting(w, 'agent.owner_word_excluded', 'share');
  assert.deepEqual(rest(asAgent(w.deps), 'whoami', { workspaceId: w.ws }).approveOnOwnerWord.excludedFamilies, ['share']);
  w.deps.store.close();
});

// --- critic round 1 ---------------------------------------------------------------------------------

/** An approval on the owner's word, as the agent. */
const onWord = (w, id) => rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id, ownerWord: WORD });
let dialSeq = 0;
const setDial = (w, capability, level) => assert.equal(human(w.deps, 'set_agent_dial', { workspaceId: w.ws, capability, level, idempotencyKey: `ex-dial-${++dialSeq}` }).ok, true);

/** What a rule firing each excluded family fires. */
const FIRES = [
  ['share', 'prepare_feedback', { subject: 'Erfunden', message: 'Erfundener Text.' }],
  ['plugin-install', 'enable_plugin', { pluginId: 'plugin_erfunden' }],
  ['vat-file', 'set_vat_method', { method: 'effektiv' }],
];

for (const [family, tool, template] of FIRES) {
  test(`critic MEDIUM-1 (${family}): an enable drafted while ${family} stood at auto is still refused once the dial is back at ask`, () => {
    const w = world(`m1-en-${family}`);
    wordOn(w);
    const created = rest(asAgent(w.deps), 'create_automation_rule', {
      workspaceId: w.ws, name: 'Erfundene Regel', trigger: { event: 'contact.created' }, action: { tool, inputTemplate: template }, enabled: false, idempotencyKey: `m1-${family}`,
    });
    assert.equal(typeof created.rule?.ruleId, 'string', JSON.stringify(created));
    setDial(w, family, 'auto');
    const en = rest(asAgent(w.deps), 'enable_automation_rule', { workspaceId: w.ws, ruleId: created.rule.ruleId });
    assert.equal(en.drafted, true, JSON.stringify(en));
    assert.equal(en.dialCapability, 'customize', 'stored under the floor, the fired family did not draft then');
    setDial(w, family, 'ask');

    assertRefusedFor(w, en.actionId, onWord(w, en.actionId), family);
    const enabled = () => w.deps.store.db.prepare('SELECT enabled FROM automation_rule WHERE workspace_id = ? AND id = ?').get(w.ws, created.rule.ruleId).enabled;
    assert.equal(enabled(), 0, 'the rule stays disabled');
    w.deps.store.close();
  });
}

test('critic MEDIUM-1: a trigger-only update of a rule that fires share is refused on the owner\'s word', () => {
  const w = world('m1-up');
  wordOn(w);
  const created = human(w.deps, 'create_automation_rule', {
    workspaceId: w.ws, name: 'Erfundene Regel', trigger: { event: 'contact.created' }, action: { tool: 'prepare_feedback', inputTemplate: FIRES[0][2] }, enabled: false, idempotencyKey: 'm1-up-rule',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  setDial(w, 'share', 'auto');
  const up = rest(asAgent(w.deps), 'update_automation_rule', { workspaceId: w.ws, ruleId: created.rule.ruleId, patch: { trigger: { event: 'contact.updated' } }, idempotencyKey: 'm1-up' });
  assert.equal(up.drafted, true, JSON.stringify(up));
  assert.equal(up.dialCapability, 'customize');
  setDial(w, 'share', 'ask');
  assertRefusedFor(w, up.actionId, onWord(w, up.actionId), 'share');
  w.deps.store.close();
});

test('critic MEDIUM-1: a retry is judged by the run it re-sends, and a rule or run that cannot be read fails closed', () => {
  const w = world('m1-rt');
  wordOn(w);
  const created = human(w.deps, 'create_automation_rule', {
    workspaceId: w.ws, name: 'Erfundene Regel', trigger: { event: 'contact.created' }, action: { tool: 'prepare_feedback', inputTemplate: FIRES[0][2] }, enabled: false, idempotencyKey: 'm1-rt-rule',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  w.deps.store.db
    .prepare("INSERT INTO automation_run (id, workspace_id, rule_id, trigger_event, event_ref, status, action_tool, action_input, error_code, actor, started_at) VALUES ('arun_erfunden', ?, ?, 'contact.created', 'ref-erfunden', 'running', 'prepare_feedback', ?, NULL, 'agent', '2026-07-16T00:00:00.000Z')")
    .run(w.ws, created.rule.ruleId, JSON.stringify({ ...FIRES[0][2], idempotencyKey: 'k-erfunden' }));
  // Hand-written Vorschläge stored under the floor, as a draft taken at another dial would be.
  const insert = w.deps.store.db.prepare("INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, created_at) VALUES (?, ?, 'agent', 'customize', ?, ?, 'pending', '2026-07-16T00:00:00Z')");
  insert.run('agent_action_retry', w.ws, 'retry_automation_run', JSON.stringify({ workspaceId: w.ws, runId: 'arun_erfunden' }));
  assertRefusedFor(w, 'agent_action_retry', onWord(w, 'agent_action_retry'), 'share');
  for (const [id, tool, payload] of [
    ['agent_action_gone_run', 'retry_automation_run', { workspaceId: w.ws, runId: 'arun_fehlt' }],
    ['agent_action_gone_rule', 'enable_automation_rule', { workspaceId: w.ws, ruleId: 'arule_fehlt' }],
  ]) {
    insert.run(id, w.ws, tool, JSON.stringify(payload));
    const r = onWord(w, id);
    assert.equal(r.reason, 'owner_word_excluded', JSON.stringify(r));
    assert.equal(r.ownerWordExclusion, 'unreadable');
    assert.equal(rowOf(w, id).status, 'pending');
  }
  // Another workspace's run reads as absent (tenant-bound): it fails closed, never borrows that run's family.
  const other = world('m1-rt-other', w.deps);
  wordOn(other);
  insert.run('agent_action_cross', other.ws, 'retry_automation_run', JSON.stringify({ workspaceId: other.ws, runId: 'arun_erfunden' }));
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: other.ws, actionId: 'agent_action_cross', ownerWord: WORD }).ownerWordExclusion, 'unreadable');
  w.deps.store.close();
});

test('critic LOW-2: the stored family counts even when the input names another', () => {
  const excluded = new Set(['vat-file', 'plugin-install', 'share']);
  const hit = ownerWordExclusionFor(null, { action_tool: 'update_company_profile', dial_capability: 'share', payload_json: JSON.stringify({ workspaceId: 'w', name: 'Neu AG' }) }, excluded);
  assert.equal(hit?.family, 'share', JSON.stringify(hit));
  const w = world('l2');
  wordOn(w);
  w.deps.store.db
    .prepare("INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, created_at) VALUES ('agent_action_l2', ?, 'agent', 'share', 'update_company_profile', ?, 'pending', '2026-07-16T00:00:00Z')")
    .run(w.ws, JSON.stringify({ workspaceId: w.ws, name: 'Neu AG' }));
  assertRefusedFor(w, 'agent_action_l2', onWord(w, 'agent_action_l2'), 'share');
  w.deps.store.close();
});

test('critic LOW-1: in an unseated workspace a stored set signed by a governed seat never shrinks the default', () => {
  const w = world('l1');
  wordOn(w);
  setSetting(w, 'agent.owner_word_excluded', 'none');
  const d = rest(asAgent(w.deps), 'update_company_profile', { workspaceId: w.ws, mwstNo: 'CHE-123.456.788 MWST' });
  assert.equal(d.drafted, true, JSON.stringify(d));
  // No member invited: the local owner seat, where every person-side actor holds the right.
  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'agent' WHERE workspace_id = ? AND key = 'agent.owner_word_excluded'").run(w.ws);
  assertRefusedFor(w, d.actionId, onWord(w, d.actionId), 'vat-file');
  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'studio' WHERE workspace_id = ? AND key = 'agent.owner_word_excluded'").run(w.ws);
  assert.equal(onWord(w, d.actionId).ok, true, 'signed by the person, the shrink holds');
  w.deps.store.close();
});

// --- critic round 2 ---------------------------------------------------------------------------------

test('critic LOW-A: an enabled create whose templated action can file VAT is refused once vat-file is back at ask', () => {
  const w = world('la');
  wordOn(w);
  // The placeholder evidence may resolve to a filed attestation (vat-file) or a sign-off (post).
  setDial(w, 'vat-file', 'auto');
  setDial(w, 'post', 'auto');
  const rules = () => count(w.deps.store.db, "SELECT COUNT(*) AS n FROM automation_rule WHERE workspace_id = ? AND action_tool = 'checklist_item_complete'", w.ws);
  const c = rest(asAgent(w.deps), 'create_automation_rule', {
    workspaceId: w.ws, name: 'Erfundene Regel', trigger: { event: 'contact.created' },
    action: { tool: 'checklist_item_complete', inputTemplate: { itemId: 'item_erfunden', evidence: { kind: '{{payload.kind}}' } } }, idempotencyKey: 'la-rule',
  });
  assert.equal(c.drafted, true, JSON.stringify(c));
  assert.equal(c.dialCapability, 'customize', 'stored under the floor: vat-file and post executed at draft time');
  setDial(w, 'vat-file', 'ask');
  assertRefusedFor(w, c.actionId, onWord(w, c.actionId), 'vat-file');
  assert.equal(rules(), 0, 'no rule was created');
  w.deps.store.close();
});

test('critic LOW-B: a run of another workspace with the same id reads as absent, so the retry fails closed', () => {
  const deps = freshDeps();
  const a = world('lb-a', deps);
  const b = world('lb-b', deps);
  wordOn(b);
  const created = human(deps, 'create_automation_rule', {
    workspaceId: a.ws, name: 'Erfundene Regel', trigger: { event: 'contact.created' }, action: { tool: 'prepare_feedback', inputTemplate: FIRES[0][2] }, enabled: false, idempotencyKey: 'lb-rule',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  deps.store.db
    .prepare("INSERT INTO automation_run (id, workspace_id, rule_id, trigger_event, event_ref, status, action_tool, action_input, error_code, actor, started_at) VALUES ('arun_lb', ?, ?, 'contact.created', 'ref-lb', 'running', 'prepare_feedback', '{}', NULL, 'agent', '2026-07-16T00:00:00.000Z')")
    .run(a.ws, created.rule.ruleId);
  deps.store.db
    .prepare("INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, created_at) VALUES ('agent_action_lb', ?, 'agent', 'customize', 'retry_automation_run', ?, 'pending', '2026-07-16T00:00:00Z')")
    .run(b.ws, JSON.stringify({ workspaceId: b.ws, runId: 'arun_lb' }));
  const r = onWord(b, 'agent_action_lb');
  assert.equal(r.ownerWordExclusion, 'unreadable', JSON.stringify(r));
  assert.equal(rowOf(b, 'agent_action_lb').status, 'pending');
  deps.store.close();
});
