// @ts-nocheck
/**
 * D209, APPROVAL ON THE OWNER'S WORD, measured on rows.
 *
 * Written for a NON-AUTHOR critic to read: each test names the invariant it holds and counts the rows that
 * prove it, never a returned `ok` alone.
 *
 *  - setting OFF (the default): an agent approval carrying `ownerWord` is refused on both doors and the
 *    refusal names where the owner switches it on; the Vorschlag stays pending, nothing is posted.
 *  - the setting is HUMAN-ONLY: the agent can neither set it nor approve its own proposal to set it.
 *  - setting ON: the agent approves ANY kind of Vorschlag the owner named (a post_entry and an
 *    import_bank_statement, both outside the D196 grant), the act runs ONCE as drafted, and the row's history
 *    gains exactly one `decided_on_owner_word` entry with the quote verbatim, `saidAt`, the agent and the
 *    grantor; the A03 chain gains exactly one `agent_action` / `approve_on_owner_word` row.
 *  - REPLAY IS IDEMPOTENT: a second approval answers the stored result and writes no journal row, no history
 *    entry and no audit row.
 *  - never `allowFuture`; never a person-only setting; never a malformed or future `saidAt`; never a person
 *    carrying `ownerWord`.
 *  - TENANT ISOLATION: the setting in one workspace opens nothing in another, and an id of another workspace
 *    is `not_found`.
 *  - REVOKE and FAIL CLOSED: back to off refuses again; a grantor who no longer holds the right grants nothing.
 *  - the batch carries the words to every id and takes any kind of Vorschlag.
 *  - the way back works: an entry approved on the owner's word is reversed by a person with reverse_entry.
 *
 * All data is synthetic (the seeded KMU chart of a fresh in-memory workspace, invented bank lines).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, manualPost } from './support.mjs';
import { SCENARIOS, fixture } from './conformance-contract.mjs';
import { runPluginToolCall } from '../../dist/core/plugins/sandbox.js';

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const mcp = (deps, name, input) => JSON.parse(callTool(deps, name, input).content[0].text);
const asStudio = (deps) => ({ ...deps, actor: 'studio' });
const asAgent = (deps) => ({ ...deps, actor: 'agent' });

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
const posted = (w) => count(w.deps.store.db, "SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'", w.ws);
const rowOf = (w, id) => w.deps.store.db.prepare('SELECT status, resolved_by, history_json FROM agent_action WHERE workspace_id = ? AND id = ?').get(w.ws, id);
const historyOf = (w, id) => JSON.parse(rowOf(w, id).history_json ?? '[]');
const wordEntries = (w, id) => historyOf(w, id).filter((e) => e.event === 'decided_on_owner_word');
const auditRows = (w, id) =>
  count(w.deps.store.db, "SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_kind = 'agent_action' AND entity_id = ? AND action = 'approve_on_owner_word'", w.ws, id);

// The fixture clock is pinned at 2026-07-16T00:00:00Z (`support.mjs`), so every draft is made then.
const WORD = { quote: 'Ja, 2c9a und f960 sind genehmigt, bitte ausführen.', saidAt: '2026-07-16T00:00:00Z' };
const SAID = '2026-07-16T00:00:00.000Z';

function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Muster GmbH', `${seed}-ws`);
  return { deps, ws: workspaceId, accId };
}

let n = 0;
function setWord(w, value) {
  n += 1;
  const r = getAction('settings_set').run(asStudio(w.deps), { workspaceId: w.ws, key: 'agent.approve_on_owner_word', value, reason: 'D209 test', idempotencyKey: `word-${value}-${n}` });
  assert.equal(r.ok, true, JSON.stringify(r));
}

/** One agent-drafted post_entry (the dial is at ask by default, so the agent's write drafts). */
function draft(w, key) {
  const d = rest(asAgent(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, key) });
  assert.equal(d.drafted, true, JSON.stringify(d));
  return d.actionId;
}

test('setting off (default): an approval on the owner\'s word is refused on both doors, and names where the owner switches it on', () => {
  const w = world('off');
  const id = draft(w, 'off-1');
  const before = posted(w);

  const viaRest = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id, ownerWord: WORD });
  assert.equal(viaRest.error, 'permission_denied', JSON.stringify(viaRest));
  assert.equal(viaRest.ownerCanGrant.setting, 'agent.approve_on_owner_word');
  assert.equal(viaRest.ownerCanGrant.value, 'on');
  const viaMcp = mcp(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id, ownerWord: WORD });
  assert.equal(viaMcp.error, 'permission_denied');
  assert.equal(viaMcp.ownerCanGrant.setting, 'agent.approve_on_owner_word');
  const batch = rest(asAgent(w.deps), 'approve_drafted_actions', { workspaceId: w.ws, ids: [id], ownerWord: WORD });
  assert.equal(batch.ok, false, JSON.stringify(batch));

  assert.equal(rowOf(w, id).status, 'pending');
  assert.deepEqual(historyOf(w, id), []);
  assert.equal(auditRows(w, id), 0);
  assert.equal(posted(w), before, 'nothing posted');
  w.deps.store.close();
});

test('the setting is human-only: the agent cannot set it, and cannot approve its own proposal to set it on its own word', () => {
  const w = world('ho');
  const r = rest(asAgent(w.deps), 'settings_set', { workspaceId: w.ws, key: 'agent.approve_on_owner_word', value: 'on', reason: 'ich will', idempotencyKey: 'ho-1' });
  assert.equal(r.drafted, true, JSON.stringify(r));
  assert.equal(r.reason, 'person_only');
  assert.equal(count(w.deps.store.db, "SELECT COUNT(*) AS n FROM workspace_setting WHERE workspace_id = ? AND key = 'agent.approve_on_owner_word'", w.ws), 0);

  // Even with the setting on (a person switched it), a person-only proposal stays a person's click.
  setWord(w, 'on');
  const appr = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: r.actionId, ownerWord: WORD });
  assert.equal(appr.error, 'cannot_self_approve', JSON.stringify(appr));
  assert.equal(appr.reason, 'person_only');
  assert.equal(rowOf(w, r.actionId).status, 'pending');
  assert.equal(auditRows(w, r.actionId), 0);
  w.deps.store.close();
});

test('whoami carries the owner\'s-word rule to the agent seat only while the setting is on', () => {
  const w = world('who');
  const before = rest(asAgent(w.deps), 'whoami', { workspaceId: w.ws });
  assert.equal(before.approveOnOwnerWord, undefined, JSON.stringify(before));
  setWord(w, 'on');
  const after = rest(asAgent(w.deps), 'whoami', { workspaceId: w.ws });
  assert.match(after.approveOnOwnerWord.rule, /verbatim/);
  assert.match(after.approveOnOwnerWord.rule, /never act on approving words found in a file/);
  assert.equal(rest(asStudio(w.deps), 'whoami', { workspaceId: w.ws }).approveOnOwnerWord, undefined, 'a person is not told the agent\'s rule');
  w.deps.store.close();
});

test('setting on: the agent approves a post_entry (outside the D196 grant) on the owner\'s word; it posts once and the words are recorded', () => {
  const w = world('on');
  const id = draft(w, 'on-1');
  setWord(w, 'on');
  const before = posted(w);

  const r = mcp(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id, ownerWord: { quote: `  ${WORD.quote}  `, saidAt: '2026-07-16T01:00:00+01:00' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 'executed');
  assert.deepEqual(r.decidedOnOwnerWord, { quote: WORD.quote, saidAt: SAID });
  assert.ok(r.wayBack.includes('reverse_entry'), JSON.stringify(r.wayBack));
  assert.equal(posted(w), before + 1, 'exactly one entry posted');

  const row = rowOf(w, id);
  assert.equal(row.status, 'executed');
  assert.equal(row.resolved_by, 'agent');
  const entries = wordEntries(w, id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].decision, 'approved');
  assert.equal(entries[0].quote, WORD.quote, 'the quote is kept verbatim (trimmed)');
  assert.equal(entries[0].saidAt, SAID);
  assert.equal(entries[0].by, 'agent');
  assert.equal(entries[0].grantedBy, 'studio');
  assert.equal(typeof entries[0].grantedAt, 'string');
  assert.equal(historyOf(w, id).filter((e) => e.event === 'decided_under_grant').length, 0, 'not recorded as the standing grant');
  assert.equal(auditRows(w, id), 1, 'one A03 chain row');
  const log = getAction('get_audit_log').run(asStudio(w.deps), { workspaceId: w.ws });
  assert.equal(log.chainVerified, true);
  // The Verlauf read carries the words beside the chain row (the chain itself stores who, what and when).
  const auditRow = log.rows.find((r) => r.entityKind === 'agent_action' && r.entityId === id);
  assert.equal(auditRow.action, 'approve_on_owner_word');
  assert.equal(auditRow.actor, 'agent');
  assert.deepEqual(auditRow.ownerWord, { quote: WORD.quote, saidAt: SAID });
  w.deps.store.close();
});

test('setting on: an import_bank_statement Vorschlag (the 18.11.2026 case) runs on the owner\'s word and imports its lines once', () => {
  const w = world('imp');
  const created = getAction('create_bank_account').run(asStudio(w.deps), {
    workspaceId: w.ws, name: 'Kantonalbank Test', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: w.accId('1020'), idempotencyKey: 'imp-bank',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const d = rest(asAgent(w.deps), 'import_bank_statement', {
    workspaceId: w.ws, bankAccountId: created.bankAccountId, content: 'Datum;Text;Betrag\n02.03.2026;Lieferant Muster;-25.00\n03.03.2026;Kunde Beispiel;120.00\n',
    mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' }, idempotencyKey: 'imp-csv',
  });
  assert.equal(d.drafted, true, JSON.stringify(d));
  const lines = () => count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ? AND bank_account_id = ?', w.ws, created.bankAccountId);
  assert.equal(lines(), 0);

  // The D196 grant alone never approves an import.
  getAction('settings_set').run(asStudio(w.deps), { workspaceId: w.ws, key: 'agent.decide_proposals', value: 'decide', reason: 'D209 test', idempotencyKey: 'imp-grant' });
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId }).grantExclusion, 'not_a_bank_decision');
  // And with the standing grant live, words carried while the owner's-word setting is off still refuse.
  const off = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId, ownerWord: WORD });
  assert.equal(off.reason, 'owner_word_off', JSON.stringify(off));

  setWord(w, 'on');
  const r = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId, ownerWord: WORD });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(lines(), 2, 'both invented lines imported');
  assert.equal(wordEntries(w, d.actionId).length, 1);
  assert.equal(auditRows(w, d.actionId), 1);
  w.deps.store.close();
});

test('replay is idempotent: a second approval on the owner\'s word writes no journal row, no history entry and no audit row', () => {
  const w = world('idem');
  const id = draft(w, 'idem-1');
  setWord(w, 'on');
  const first = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id, ownerWord: WORD });
  assert.equal(first.ok, true, JSON.stringify(first));
  const after = posted(w);
  const again = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id, ownerWord: { ...WORD, quote: 'nochmals' } });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(posted(w), after);
  assert.equal(wordEntries(w, id).length, 1);
  assert.equal(wordEntries(w, id)[0].quote, WORD.quote, 'the first words stay');
  assert.equal(auditRows(w, id), 1);
  w.deps.store.close();
});

test('the owner\'s word never sets a dial level, and its words are checked', () => {
  const w = world('chk');
  const id = draft(w, 'chk-1');
  setWord(w, 'on');
  const before = posted(w);
  const ask = (ownerWord, extra = {}) => rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id, ownerWord, ...extra });

  assert.equal(ask(WORD, { allowFuture: true }).error, 'cannot_self_grant');
  assert.equal(ask({ quote: '   ', saidAt: WORD.saidAt }).error, 'invalid_input');
  assert.equal(ask({ quote: WORD.quote, saidAt: 'gestern' }).error, 'invalid_input');
  assert.equal(ask({ quote: WORD.quote, saidAt: '2999-01-01T00:00:00Z' }).error, 'invalid_input');
  assert.equal(ask({ quote: 'x'.repeat(2001), saidAt: WORD.saidAt }).error, 'invalid_input');
  // Critic MEDIUM-3: never a bare number or a date without a time, and never words older than an hour before the draft.
  assert.equal(ask({ quote: WORD.quote, saidAt: '1' }).error, 'invalid_input');
  assert.equal(ask({ quote: WORD.quote, saidAt: '2026-07-16' }).error, 'invalid_input');
  const early = ask({ quote: WORD.quote, saidAt: '2026-07-15T22:59:59Z' });
  assert.equal(early.error, 'invalid_input', JSON.stringify(early));
  assert.equal(early.reason, 'before the Vorschlag was drafted');
  // The window is a setting (D172): 180 minutes lets the same words count; 0 refuses words written before the draft.
  getAction('settings_set').run(asStudio(w.deps), { workspaceId: w.ws, key: 'agent.owner_word_before_draft_minutes', value: 0, reason: 'D209 test', idempotencyKey: 'win-0' });
  assert.equal(ask({ quote: WORD.quote, saidAt: '2026-07-15T23:59:00Z' }).reason, 'before the Vorschlag was drafted');
  // The agent cannot widen the window itself (human-only).
  const widen = rest(asAgent(w.deps), 'settings_set', { workspaceId: w.ws, key: 'agent.owner_word_before_draft_minutes', value: 1440, reason: 'x', idempotencyKey: 'win-agent' });
  assert.notEqual(widen.ok && widen.drafted !== true, true, JSON.stringify(widen));
  // A person approves under their own authority: words on a person's call are refused, never silently kept.
  const person = rest(asStudio(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id, ownerWord: WORD });
  assert.equal(person.error, 'invalid_input', JSON.stringify(person));

  assert.equal(rowOf(w, id).status, 'pending');
  assert.equal(posted(w), before);
  assert.equal(count(w.deps.store.db, "SELECT COUNT(*) AS n FROM agent_dial WHERE workspace_id = ?", w.ws), 0, 'no dial row');
  w.deps.store.close();
});

test('tenant isolation: the setting in one workspace opens nothing in another, and another workspace\'s id is not found', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const a = mintWorkspace(deps, 'Alpha GmbH', 'iso-a');
  const b = mintWorkspace(deps, 'Beta GmbH', 'iso-b');
  const wa = { deps, ws: a.workspaceId, accId: a.accId };
  const wb = { deps, ws: b.workspaceId, accId: b.accId };
  const idA = draft(wa, 'iso-a1');
  const idB = draft(wb, 'iso-b1');
  setWord(wa, 'on');

  const crossed = rest(asAgent(deps), 'approve_drafted_action', { workspaceId: wa.ws, actionId: idB, ownerWord: WORD });
  assert.equal(crossed.error, 'not_found', JSON.stringify(crossed));
  const inB = rest(asAgent(deps), 'approve_drafted_action', { workspaceId: wb.ws, actionId: idB, ownerWord: WORD });
  assert.equal(inB.error, 'permission_denied', JSON.stringify(inB));
  assert.equal(rowOf(wb, idB).status, 'pending');
  assert.equal(auditRows(wb, idB), 0);

  assert.equal(rest(asAgent(deps), 'approve_drafted_action', { workspaceId: wa.ws, actionId: idA, ownerWord: WORD }).ok, true);
  assert.equal(rowOf(wa, idA).status, 'executed');
  deps.store.close();
});

test('revoke and fail closed: off refuses again; a grantor who no longer holds the right grants nothing', () => {
  const w = world('rev');
  const a = draft(w, 'rev-1');
  setWord(w, 'on');
  setWord(w, 'off');
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: a, ownerWord: WORD }).error, 'permission_denied');

  setWord(w, 'on');
  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'agent' WHERE workspace_id = ? AND key = 'agent.approve_on_owner_word'").run(w.ws);
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: a, ownerWord: WORD }).error, 'permission_denied');
  assert.equal(getAction('invite_member').run(asStudio(w.deps), { workspaceId: w.ws, email: 'rev@muster.ch', role: 'viewer', idempotencyKey: 'rev-inv' }).ok, true);
  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'member:gone' WHERE workspace_id = ? AND key = 'agent.approve_on_owner_word'").run(w.ws);
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: a, ownerWord: WORD }).error, 'permission_denied');
  assert.equal(rowOf(w, a).status, 'pending');
  assert.equal(auditRows(w, a), 0);

  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'studio' WHERE workspace_id = ? AND key = 'agent.approve_on_owner_word'").run(w.ws);
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: a, ownerWord: WORD }).ok, true);
  w.deps.store.close();
});

test('the batch carries the owner\'s words to every id, any kind of Vorschlag, each recorded once', () => {
  const w = world('batch');
  const ids = [draft(w, 'batch-1'), draft(w, 'batch-2')];
  setWord(w, 'on');
  const before = posted(w);
  const r = rest(asAgent(w.deps), 'approve_drafted_actions', { workspaceId: w.ws, ids, ownerWord: WORD });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.okCount, 2, JSON.stringify(r));
  assert.equal(posted(w), before + 2);
  for (const id of ids) {
    assert.equal(rowOf(w, id).status, 'executed');
    assert.equal(wordEntries(w, id).length, 1);
    assert.equal(auditRows(w, id), 1);
  }
  // Without words the batch stays the person's bank-line batch.
  const other = draft(w, 'batch-3');
  const plain = rest(asStudio(w.deps), 'approve_drafted_actions', { workspaceId: w.ws, ids: [other] });
  assert.equal(plain.items?.[0]?.refusal?.error ?? plain.error ?? JSON.stringify(plain), 'not_batchable');
  w.deps.store.close();
});

test('the way back works: an entry approved on the owner\'s word is reversed by a person', () => {
  const w = world('back');
  const id = draft(w, 'back-1');
  setWord(w, 'on');
  const r = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id, ownerWord: WORD });
  assert.equal(r.ok, true, JSON.stringify(r));
  const entryId = r.result.entryId ?? r.result.id;
  assert.equal(typeof entryId, 'string', JSON.stringify(r.result));
  const rev = getAction('reverse_entry').run(asStudio(w.deps), { workspaceId: w.ws, entryId, reason: 'D209 test', idempotencyKey: 'back-rev' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  w.deps.store.close();
});

test('revDSG erasure: contacts_anonymise reaches the owner\'s words on the Vorschlag and in the Verlauf read', () => {
  const w = world('anon');
  const NAME = 'Muellerprobe AG';
  const vendor = getAction('create_contact').run(asStudio(w.deps), { workspaceId: w.ws, partyRole: 'vendor', name: NAME, idempotencyKey: 'anon-c' });
  assert.equal(vendor.ok, true, JSON.stringify(vendor));
  const id = draft(w, 'anon-1');
  setWord(w, 'on');
  const quote = `Die Rechnung von ${NAME} ist genehmigt.`;
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id, ownerWord: { quote, saidAt: WORD.saidAt } }).ok, true);
  assert.equal(wordEntries(w, id)[0].quote, quote, 'premise: the words are stored verbatim before the erasure');

  // HOW IT BITES: drop the history sweep in `purgeAgentTraceForStrings` and the name stays below.
  const erased = getAction('contacts_anonymise').run(asStudio(w.deps), { workspaceId: w.ws, contactId: vendor.contact.id, idempotencyKey: 'anon-x' });
  assert.equal(erased.ok, true, JSON.stringify(erased));
  const entry = wordEntries(w, id)[0];
  assert.equal(entry.quote.includes(NAME), false, 'the name is gone from the history');
  assert.ok(entry.quote.includes('[anonymisiert]'), 'the words keep their shape');
  const log = getAction('get_audit_log').run(asStudio(w.deps), { workspaceId: w.ws });
  assert.equal(JSON.stringify(log.rows).includes(NAME), false, 'nor in the Verlauf read');
  assert.equal(log.chainVerified, true, 'the chain stores no words, so it stays intact');
  w.deps.store.close();
});

test('revDSG erasure is JSON-aware: a name with a quote mark is found, and a name equal to a structural value leaves the record intact', () => {
  const w = world('anon2');
  const QUOTED = 'Beck "Brot" GmbH';
  const STRUCT = 'approved';
  const c1 = getAction('create_contact').run(asStudio(w.deps), { workspaceId: w.ws, partyRole: 'vendor', name: QUOTED, idempotencyKey: 'anon2-c1' });
  const c2 = getAction('create_contact').run(asStudio(w.deps), { workspaceId: w.ws, partyRole: 'vendor', name: STRUCT, idempotencyKey: 'anon2-c2' });
  assert.equal(c1.ok && c2.ok, true, JSON.stringify([c1, c2]));
  const id = draft(w, 'anon2-1');
  setWord(w, 'on');
  const quote = `${QUOTED} ist genehmigt.`;
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id, ownerWord: { quote, saidAt: WORD.saidAt } }).ok, true);

  assert.equal(getAction('contacts_anonymise').run(asStudio(w.deps), { workspaceId: w.ws, contactId: c1.contact.id, idempotencyKey: 'anon2-x1' }).ok, true);
  assert.equal(getAction('contacts_anonymise').run(asStudio(w.deps), { workspaceId: w.ws, contactId: c2.contact.id, idempotencyKey: 'anon2-x2' }).ok, true);
  const entry = wordEntries(w, id)[0];
  assert.equal(entry.quote.includes(QUOTED), false, 'the escaped name is gone');
  assert.equal(entry.decision, 'approved', 'a structural value is never rewritten');
  assert.equal(entry.event, 'decided_on_owner_word');
  w.deps.store.close();
});

test('critic HIGH-1: the owner\'s word is decided when the call starts; a revoke while the mail leaves never makes the books say "never sent"', () => {
  const fx = fixture();
  const sent = [];
  const { confirmed: _c, email: _e, ...input } = SCENARIOS.send_invoice(fx);
  const drafted = handleRest('send_invoice', input, asAgent(fx.deps)).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const set = (value, key) => {
    const r = getAction('settings_set').run(asStudio(fx.deps), { workspaceId: fx.workspaceId, key: 'agent.approve_on_owner_word', value, reason: 'D209 test', idempotencyKey: key });
    assert.equal(r.ok, true, JSON.stringify(r));
  };
  set('on', 'hi-on');
  // The relay sends, and the owner switches the setting off at that very moment (another process).
  fx.deps.emailRelay = { send: (m) => { sent.push(m.to); fx.deps.store.withoutCommitMark(() => set('off', 'hi-off')); return { ok: true }; } };
  const r = handleRest('approve_drafted_action', { workspaceId: fx.workspaceId, actionId: drafted.actionId, ownerWord: { quote: 'ja, schick sie', saidAt: fx.deps.clock.now() } }, asAgent(fx.deps)).body;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(sent.length, 1, 'the mail left once');
  const row = fx.deps.store.db.prepare('SELECT status, history_json FROM agent_action WHERE id = ?').get(drafted.actionId);
  assert.equal(row.status, 'executed', 'the record says what happened');
  assert.equal(JSON.parse(row.history_json).filter((e) => e.event === 'decided_on_owner_word').length, 1);
  const doc = fx.deps.store.db.prepare('SELECT sent_to_email FROM document WHERE id = ?').get(input.invoiceId);
  assert.notEqual(doc.sent_to_email, null, 'the invoice is marked sent');
  // A person can no longer reject what already ran; the revoke stops the NEXT call.
  assert.equal(handleRest('reject_drafted_action', { workspaceId: fx.workspaceId, actionId: drafted.actionId, reason: 'nie gesendet' }, asStudio(fx.deps)).body.ok, false);
  fx.deps.store.close();
});

test('critic MEDIUM-4: a plugin call never approves on the owner\'s word, and is not pointed at the setting', () => {
  const w = world('plug');
  assert.equal(getAction('invite_member').run(asStudio(w.deps), { workspaceId: w.ws, email: 'x@example.invalid', role: 'viewer', idempotencyKey: 'plug-inv' }).ok, true);
  w.deps.store.db.prepare("INSERT INTO user (id, actor_id, email, display_name, created_at, kind) VALUES ('usr_bob','member:usr_bob','bob@example.invalid','Bob','2026-01-01','human')").run();
  w.deps.store.db.prepare("INSERT INTO workspace_member (id, workspace_id, user_id, role, invited_at, accepted_at, created_by) VALUES ('mem_bob', ?, 'usr_bob', 'owner', '2026-01-01', '2026-01-01', 'studio')").run(w.ws);
  const id = draft(w, 'plug-1');
  setWord(w, 'on');
  const before = posted(w);
  const invoke = (tool, input, asActor) => getAction(tool).run({ ...w.deps, actor: asActor }, input);
  const r = runPluginToolCall(invoke, { grantedScopes: ['mcp_tool:approve_drafted_action'], pluginActor: 'member:usr_bob', tool: 'approve_drafted_action', input: { workspaceId: w.ws, actionId: id, ownerWord: WORD } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.ownerCanGrant?.setting, 'agent.approve_on_owner_word', 'a plugin is never pointed at the owner\'s-word setting');
  assert.equal(rowOf(w, id).status, 'pending');
  assert.equal(posted(w), before);
  assert.equal(auditRows(w, id), 0);
  w.deps.store.close();
});

test('critic MEDIUM-2: deleting a session\'s prose clears the owner\'s words from the call and the Vorschlag; what ran stays', () => {
  const w = world('prose');
  const id = draft(w, 'prose-1');
  setWord(w, 'on');
  const Q = 'Privat: Muster-Notiz, aber ja, genehmigt';
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: id, ownerWord: { quote: Q, saidAt: WORD.saidAt } }).ok, true);
  const hits = () => ({
    args: count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM agent_call WHERE workspace_id = ? AND args_json LIKE ?', w.ws, '%Muster-Notiz%'),
    history: count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND history_json LIKE ?', w.ws, '%Muster-Notiz%'),
  });
  assert.deepEqual(hits(), { args: 1, history: 1 }, 'premise: both copies exist');
  const sessions = w.deps.store.db.prepare('SELECT DISTINCT t.session_id AS s FROM agent_call c JOIN agent_turn t ON t.id = c.turn_id WHERE c.workspace_id = ?').all(w.ws);
  for (const { s } of sessions) assert.equal(getAction('agent_prose_delete').run(asStudio(w.deps), { workspaceId: w.ws, sessionId: s, idempotencyKey: `pd-${s}` }).ok, true);
  assert.deepEqual(hits(), { args: 0, history: 0 });
  const entry = wordEntries(w, id)[0];
  assert.equal(entry.quote, '[gelöscht]');
  assert.equal(entry.saidAt, SAID, 'what ran stays');
  assert.equal(rowOf(w, id).status, 'executed');
  w.deps.store.close();
});
