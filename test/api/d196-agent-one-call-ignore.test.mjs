// @ts-nocheck
/**
 * D196 item 8 (owner, 12.11.2026): the agent's ONE-CALL Ignorieren under the owner's grant, measured on rows.
 *
 * An agent seat's `ignore_bank_line` drafts (the `post` dial is at ask). Under `agent.decide_proposals = decide`
 * and the setting `agent.ignore_under_grant = one_call` (the default) the same call also approves that draft
 * under the grant, through the existing approval: nothing the two-call path could not do. Each test names the
 * invariant and counts rows, never a returned `ok` alone.
 *
 * All data is synthetic (the seeded KMU chart of a fresh in-memory workspace, invented bank lines).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from './support.mjs';

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const mcp = (deps, name, input) => JSON.parse(callTool(deps, name, input).content[0].text);
const asStudio = (deps) => ({ ...deps, actor: 'studio' });
const asAgent = (deps) => ({ ...deps, actor: 'agent' });
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

/** A workspace with one bank account and three synthetic open debit lines. */
function world(seed, shared) {
  const deps = shared ?? freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Muster GmbH', `${seed}-ws`);
  const created = getAction('create_bank_account').run(asStudio(deps), {
    workspaceId, name: 'Testbank', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: `${seed}-bank`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const imported = getAction('import_bank_statement').run(asStudio(deps), {
    workspaceId, bankAccountId: created.bankAccountId,
    content: 'Datum;Gegenpartei;Text;Betrag\n02.03.2026;Kaffee Beispiel;Kaffee;-8.50\n03.03.2026;Velo Muster;Velo;-120.00\n04.03.2026;Druck Beispiel;Flyer;-45.00\n',
    mapping: { columns: { bookingDate: 'Datum', counterparty: 'Gegenpartei', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' }, idempotencyKey: `${seed}-csv`,
  });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const lines = deps.store.db.prepare('SELECT id, amount_minor AS amt FROM bank_txn WHERE workspace_id = ? ORDER BY booking_date').all(workspaceId);
  return { deps, ws: workspaceId, accId, lines };
}

let n = 0;
function setting(w, key, value) {
  n += 1;
  const r = getAction('settings_set').run(asStudio(w.deps), { workspaceId: w.ws, key, value, reason: 'D196 item 8 test', idempotencyKey: `s-${key}-${value}-${n}` });
  assert.equal(r.ok, true, JSON.stringify(r));
}
const grant = (w, value) => setting(w, 'agent.decide_proposals', value);

const lineState = (w, txn) => w.deps.store.db.prepare("SELECT state FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND superseded_at IS NULL").get(w.ws, txn)?.state ?? 'open';
const decisions = (w, txn) => count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ?', w.ws, txn);
const actionRow = (w, id) => w.deps.store.db.prepare('SELECT status, resolved_by, reject_reason, history_json, actor FROM agent_action WHERE workspace_id = ? AND id = ?').get(w.ws, id);
const historyOf = (w, id) => JSON.parse(actionRow(w, id).history_json ?? '[]');
const traceRows = (w, verb) => w.deps.store.db.prepare('SELECT mode, decision_reason AS reason, agent_action_id AS aid, ok FROM agent_call WHERE workspace_id = ? AND verb = ? ORDER BY rowid').all(w.ws, verb);
const discards = (w, txn) => count(w.deps.store.db, "SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_kind = 'bank_txn' AND entity_id = ? AND action = 'discard'", w.ws, txn);
const ignore = (w, txn, key, extra = {}) => rest(asAgent(w.deps), 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: txn, idempotencyKey: key, ...extra });
const bookDraft = (w, deps, txn, key, amount = 850) =>
  rest(deps, 'book_bank_line', { workspaceId: w.ws, bankTxnId: txn, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: amount }] }, idempotencyKey: key });
/** A second agent seat (a `user` row of kind agent, the bank-factor suite's shape). */
const SECOND = 'agent-zwei';
function addSecondSeat(w) {
  w.deps.store.db.prepare("INSERT INTO user (actor_id, kind, display_name, created_at) VALUES (?, 'agent', 'Zweiter Agent', '2026-07-01T00:00:00.000Z')").run(SECOND);
  return { ...w.deps, actor: SECOND };
}
/** Run `fn` while the registry's approve_drafted_action first does `between` (the gap between the two transactions). */
function withGap(between, fn) {
  const approve = getAction('approve_drafted_action');
  const original = approve.run;
  approve.run = (deps, input) => {
    between(input.actionId);
    return original(deps, input);
  };
  try {
    return fn();
  } finally {
    approve.run = original;
  }
}

test('decide + one_call (default): ONE agent call ignores the line under the grant, with the same rows as the two-call path', () => {
  const w = world('one');
  const txn = w.lines[0].id;
  // A recommended booking for the line, drafted by the agent earlier: the owner's "cancel it" case.
  const book = bookDraft(w, asAgent(w.deps), txn, 'one-book');
  assert.equal(book.drafted, true, JSON.stringify(book));
  grant(w, 'decide');

  const r = ignore(w, txn, 'one-ign');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.drafted, undefined, 'decided, not drafted');
  assert.equal(r.state, 'ignored');
  assert.equal(r.reason, 'other', 'no reason given: bank.ignore_default_reason');
  assert.equal(typeof r.actionId, 'string');
  assert.deepEqual([r.decidedUnderGrant.scope, r.decidedUnderGrant.grantedBy], ['decide', 'studio']);
  assert.deepEqual(r.undo, { tool: 'reopen_bank_line', args: { workspaceId: w.ws, bankTxnId: txn } }, 'the way back is named');
  // The agent's own recommended booking was replaced by its ignore (D177: one pending decision per seat and line).
  assert.deepEqual(r.supersededActionIds, [book.actionId]);
  assert.deepEqual(r.closedActionIds, []);

  assert.equal(lineState(w, txn), 'ignored');
  assert.equal(decisions(w, txn), 1, 'one decision row');
  assert.equal(discards(w, txn), 1, 'one A03 discard row');
  const row = actionRow(w, r.actionId);
  assert.deepEqual([row.status, row.resolved_by, row.actor], ['executed', 'agent', 'agent']);
  const h = historyOf(w, r.actionId);
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].event, h[0].decision, h[0].grantedBy], ['decided_under_grant', 'approved', 'studio']);
  assert.deepEqual([actionRow(w, book.actionId).status, actionRow(w, book.actionId).reject_reason], ['rejected', 'ersetzt']);
  // The trace: the drafting call, and the approval as its own row that does NOT claim to be a drafting call.
  assert.deepEqual(traceRows(w, 'ignore_bank_line').map((c) => [c.mode, c.aid]), [['draft', r.actionId]]);
  assert.deepEqual(traceRows(w, 'approve_drafted_action').map((c) => [c.mode, c.reason, c.aid, c.ok]), [['execute', 'one_call_under_grant', null, 1]]);
  const session = w.deps.store.db.prepare('SELECT t.session_id AS s FROM agent_turn t JOIN agent_call c ON c.turn_id = t.id WHERE c.agent_action_id = ?').get(r.actionId).s;
  const detail = rest(asStudio(w.deps), 'get_agent_session', { workspaceId: w.ws, sessionId: session });
  const calls = detail.turns.flatMap((t) => t.calls);
  const drafting = calls.filter((c) => c.agentActionId === r.actionId);
  assert.equal(drafting.length, 1, 'one drafting call in the Studio trace');
  assert.equal(drafting[0].decidedUnderGrant.decision, 'approved');
  // No standing power rode along.
  assert.equal(count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM agent_dial WHERE workspace_id = ?', w.ws), 0, 'no dial row');
  w.deps.store.close();
});

test('another seat\'s recommended booking on the line closes as "Zeile entschieden", is named in the answer, and a person\'s reopen brings it back', () => {
  const w = world('other');
  const txn = w.lines[0].id;
  const zwei = addSecondSeat(w);
  const theirs = bookDraft(w, zwei, txn, 'other-book');
  assert.equal(theirs.drafted, true, JSON.stringify(theirs));
  grant(w, 'decide');
  const r = ignore(w, txn, 'other-ign');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.closedActionIds, [theirs.actionId]);
  assert.deepEqual([actionRow(w, theirs.actionId).status, actionRow(w, theirs.actionId).reject_reason], ['rejected', 'Zeile entschieden']);
  const reopened = getAction('reopen_bank_line').run(asStudio(w.deps), { workspaceId: w.ws, bankTxnId: txn, reason: 'doch buchen', idempotencyKey: 'other-p' });
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(actionRow(w, theirs.actionId).status, 'pending', 'the other seat\'s recommendation is back');
  w.deps.store.close();
});

test('the MCP door does the same, and a named closed reason is kept', () => {
  const w = world('mcp');
  grant(w, 'decide');
  const r = mcp(asAgent(w.deps), 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: w.lines[1].id, reason: 'booked_elsewhere', idempotencyKey: 'mcp-1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reason, 'booked_elsewhere');
  assert.equal(lineState(w, w.lines[1].id), 'ignored');
  w.deps.store.close();
});

test('idempotent: the same key again answers the same decision and writes nothing more', () => {
  const w = world('idem');
  grant(w, 'decide');
  const txn = w.lines[0].id;
  const a = ignore(w, txn, 'idem-1');
  assert.equal(a.ok, true, JSON.stringify(a));
  const drafts = count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?', w.ws);
  const b = ignore(w, txn, 'idem-1');
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.state, 'ignored');
  // Code critic L2: the retry answers like the first call, so a lost answer loses nothing.
  assert.equal(b.actionId, a.actionId);
  assert.deepEqual(b.decidedUnderGrant, a.decidedUnderGrant);
  assert.deepEqual(b.closedActionIds, a.closedActionIds);
  assert.equal(count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?', w.ws), drafts, 'no second Vorschlag');
  assert.equal(decisions(w, txn), 1);
  assert.equal(discards(w, txn), 1);
  assert.equal(historyOf(w, a.actionId).length, 1, 'one decided_under_grant entry');
  w.deps.store.close();
});

test('without a decide grant the call drafts exactly as before (off, reject), and decides nothing', () => {
  for (const scope of [null, 'reject']) {
    const w = world(`nog-${scope}`);
    if (scope !== null) grant(w, scope);
    const txn = w.lines[0].id;
    const r = ignore(w, txn, 'nog-1');
    assert.equal(r.drafted, true, JSON.stringify(r));
    assert.equal(r.status, 'pending');
    assert.equal(r.notDecided, undefined, 'no approval was attempted');
    assert.equal(lineState(w, txn), 'open');
    assert.equal(traceRows(w, 'approve_drafted_action').length, 0);
    assert.equal(actionRow(w, r.actionId).status, 'pending');
    w.deps.store.close();
  }
});

test('setting two_calls: the call drafts, and the agent decides it with a second call (the D196 path)', () => {
  const w = world('two');
  grant(w, 'decide');
  setting(w, 'agent.ignore_under_grant', 'two_calls');
  const txn = w.lines[0].id;
  const r = ignore(w, txn, 'two-1');
  assert.equal(r.drafted, true, JSON.stringify(r));
  assert.equal(lineState(w, txn), 'open');
  const a = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: r.actionId });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(lineState(w, txn), 'ignored');
  w.deps.store.close();
});

test('the setting is human-only: the agent never sets it; it only proposes it to a person, whom the grant never replaces (D202)', () => {
  const w = world('ho');
  grant(w, 'decide');
  const r = rest(asAgent(w.deps), 'settings_set', { workspaceId: w.ws, key: 'agent.ignore_under_grant', value: 'two_calls', reason: 'x', idempotencyKey: 'ho-1' });
  assert.equal(r.drafted, true, JSON.stringify(r));
  assert.equal(r.reason, 'person_only');
  assert.equal(rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: r.actionId }).error, 'cannot_self_approve');
  assert.equal(count(w.deps.store.db, "SELECT COUNT(*) AS n FROM workspace_setting WHERE workspace_id = ? AND key = 'agent.ignore_under_grant'", w.ws), 0);
  w.deps.store.close();
});

test('reversible by a person: reopen_bank_line brings the line back; the agent\'s own replaced booking stays replaced; the grant never approves the agent\'s reopen', () => {
  const w = world('rev');
  const txn = w.lines[0].id;
  const book = bookDraft(w, asAgent(w.deps), txn, 'rev-book');
  grant(w, 'decide');
  assert.equal(ignore(w, txn, 'rev-ign').ok, true);
  assert.equal(actionRow(w, book.actionId).status, 'rejected');

  // The agent's reopen drafts (the pay dial at ask), and the grant does not approve it (not a verb it covers).
  const agentReopen = rest(asAgent(w.deps), 'reopen_bank_line', { workspaceId: w.ws, bankTxnId: txn, reason: 'doch buchen', idempotencyKey: 'rev-ag' });
  assert.equal(agentReopen.drafted, true, JSON.stringify(agentReopen));
  const refused = rest(asAgent(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: agentReopen.actionId });
  assert.equal(refused.grantExclusion, 'not_a_bank_decision', JSON.stringify(refused));
  assert.equal(lineState(w, txn), 'ignored');

  const reopened = getAction('reopen_bank_line').run(asStudio(w.deps), { workspaceId: w.ws, bankTxnId: txn, reason: 'doch buchen', idempotencyKey: 'rev-p' });
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(lineState(w, txn), 'open');
  // Paper critic M2: an "ersetzt" never returns (draftedActions.ts header); the agent proposes again if asked.
  assert.equal(actionRow(w, book.actionId).status, 'rejected', 'the agent\'s own replaced booking is not revived');
  w.deps.store.close();
});

test('§H-TENANT: a line of another workspace is not found, and nothing is drafted or decided', () => {
  const w = world('ten');
  const other = world('ten2', w.deps);
  assert.notEqual(other.ws, w.ws);
  grant(w, 'decide');
  const r = ignore(w, other.lines[0].id, 'ten-1');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.error, 'not_found');
  assert.equal(count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?', w.ws), 0);
  assert.equal(traceRows(w, 'approve_drafted_action').length, 0);
  assert.equal(lineState(other, other.lines[0].id), 'open', 'the other book is untouched');
  w.deps.store.close();
});

test('a decided line refuses as before (line_not_open), and an unknown reason refuses before anything is drafted', () => {
  const w = world('ref');
  grant(w, 'decide');
  const txn = w.lines[0].id;
  assert.equal(getAction('ignore_bank_line').run(asStudio(w.deps), { workspaceId: w.ws, bankTxnId: txn, idempotencyKey: 'ref-p' }).ok, true);
  const again = ignore(w, w.lines[1].id, 'ref-bad', { reason: 'weil ich will' });
  assert.equal(again.error, 'invalid_input', JSON.stringify(again));
  const booked = getAction('book_bank_line').run(asStudio(w.deps), { workspaceId: w.ws, bankTxnId: w.lines[2].id, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: 4500 }] }, idempotencyKey: 'ref-b' });
  assert.equal(booked.ok, true, JSON.stringify(booked));
  const notOpen = ignore(w, w.lines[2].id, 'ref-2');
  assert.equal(notOpen.error, 'line_not_open', JSON.stringify(notOpen));
  assert.equal(count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?', w.ws), 0, 'nothing drafted');
  assert.equal(traceRows(w, 'approve_drafted_action').length, 0);
  w.deps.store.close();
});

test('only ignore_bank_line: the agent\'s book_bank_line under decide still drafts and waits for its own approval call', () => {
  const w = world('only');
  grant(w, 'decide');
  const r = rest(asAgent(w.deps), 'book_bank_line', { workspaceId: w.ws, bankTxnId: w.lines[0].id, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: 850 }] }, idempotencyKey: 'only-1' });
  assert.equal(r.drafted, true, JSON.stringify(r));
  assert.equal(lineState(w, w.lines[0].id), 'open');
  assert.equal(traceRows(w, 'approve_drafted_action').length, 0);
  w.deps.store.close();
});

test('the gap between the draft and the approval: the answer says where the Vorschlag actually stands', () => {
  // (a) a person decides the line meanwhile: the draft closes as "Zeile entschieden"
  {
    const w = world('gap-a');
    grant(w, 'decide');
    const txn = w.lines[0].id;
    const r = withGap(() => {
      const p = getAction('ignore_bank_line').run(asStudio(w.deps), { workspaceId: w.ws, bankTxnId: txn, reason: 'duplicate', idempotencyKey: 'gap-a-p' });
      assert.equal(p.ok, true, JSON.stringify(p));
    }, () => ignore(w, txn, 'gap-a'));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.drafted, r.status, r.closureKind, r.notDecided.error], [true, 'rejected', 'line_decided', 'already_rejected']);
    assert.equal(decisions(w, txn), 1, 'only the person\'s decision');
    w.deps.store.close();
  }
  // (b) a person rejects the Vorschlag meanwhile
  {
    const w = world('gap-b');
    grant(w, 'decide');
    const txn = w.lines[0].id;
    const r = withGap((id) => {
      assert.equal(getAction('reject_drafted_action').run(asStudio(w.deps), { workspaceId: w.ws, actionId: id, reason: 'nein' }).ok, true);
    }, () => ignore(w, txn, 'gap-b'));
    assert.deepEqual([r.status, r.notDecided.error], ['rejected', 'already_rejected'], JSON.stringify(r));
    assert.equal(lineState(w, txn), 'open');
    w.deps.store.close();
  }
  // (c) the same agent drafts the line again with another key meanwhile: this Vorschlag was replaced
  {
    const w = world('gap-c');
    setting(w, 'agent.ignore_under_grant', 'two_calls');
    grant(w, 'decide');
    const txn = w.lines[0].id;
    let first;
    const approve = getAction('approve_drafted_action');
    const original = approve.run;
    setting(w, 'agent.ignore_under_grant', 'one_call');
    approve.run = (deps, input) => {
      approve.run = original;
      // A second call while the first one's approval has not started (the replacement keeps two_calls off the
      // second call by running it with the setting at two_calls).
      setting(w, 'agent.ignore_under_grant', 'two_calls');
      const second = ignore(w, txn, 'gap-c-2');
      assert.equal(second.drafted, true, JSON.stringify(second));
      first = input.actionId;
      return original(deps, input);
    };
    let r;
    try {
      r = ignore(w, txn, 'gap-c-1');
    } finally {
      approve.run = original;
    }
    assert.equal(r.actionId, first);
    assert.deepEqual([r.status, r.closureKind, r.notDecided.error], ['rejected', 'superseded', 'already_rejected'], JSON.stringify(r));
    assert.equal(lineState(w, txn), 'open');
    w.deps.store.close();
  }
  // (d) the "Nicht buchen" rule the ignore follows is edited meanwhile: the pin voids the Vorschlag
  {
    const w = world('gap-d');
    grant(w, 'decide');
    const txn = w.lines[0].id;
    const rule = getAction('set_bank_standard').run(asStudio(w.deps), { workspaceId: w.ws, bankTxnId: txn, outcome: 'ignore', ignoreReason: 'booked_elsewhere', label: 'Kaffee privat', idempotencyKey: 'gap-d-rule' });
    assert.equal(rule.ok, true, JSON.stringify(rule));
    const r = withGap(() => {
      const edit = getAction('set_bank_standard').run(asStudio(w.deps), { workspaceId: w.ws, standardId: rule.standard.id, outcome: 'ignore', ignoreReason: 'other', ignoreNote: 'geändert', label: 'Kaffee privat', idempotencyKey: 'gap-d-edit' });
      assert.equal(edit.ok, true, JSON.stringify(edit));
    }, () => ignore(w, txn, 'gap-d', { standardId: rule.standard.id }));
    assert.deepEqual([r.status, r.notDecided.error], ['stale', 'vorschlag_stale'], JSON.stringify(r));
    assert.equal(lineState(w, txn), 'open');
    w.deps.store.close();
  }
});

test('a Vorschlag another seat drafted under the same key is never approved by this call (paper critic L6)', () => {
  const w = world('l6');
  const zwei = addSecondSeat(w);
  const txn = w.lines[0].id;
  const theirs = rest(zwei, 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: txn, idempotencyKey: 'same-key' });
  assert.equal(theirs.drafted, true, JSON.stringify(theirs));
  grant(w, 'decide');
  const r = ignore(w, txn, 'same-key');
  // The draft's key is per workspace, verb and key (not per seat), so the replay answers the other seat's row.
  assert.equal(r.actionId, theirs.actionId, JSON.stringify(r));
  assert.equal(r.drafted, true, 'answered with the other seat\'s draft, and left it for a person');
  assert.equal(actionRow(w, theirs.actionId).status, 'pending');
  assert.equal(lineState(w, txn), 'open');
  assert.equal(traceRows(w, 'approve_drafted_action').length, 0, 'no approval attempted');
  w.deps.store.close();
});

test('a served agent member whose role lacks manage_agent_dial gets a draft only, and no refused approval is attempted (paper critic L7)', () => {
  const w = world('l7');
  grant(w, 'decide');
  // Provision the book, then seat an agent member as bookkeeper (post, but not manage_agent_dial).
  assert.equal(getAction('invite_member').run(asStudio(w.deps), { workspaceId: w.ws, email: 'p@example.invalid', role: 'viewer', idempotencyKey: 'l7-inv' }).ok, true);
  w.deps.store.db.prepare("INSERT INTO user (id, actor_id, email, display_name, kind, created_at) VALUES ('usr_bot', 'member:usr_bot', 'bot@example.invalid', 'Bot', 'agent', '2026-01-01')").run();
  w.deps.store.db.prepare("INSERT INTO workspace_member (id, workspace_id, user_id, role, invited_at, accepted_at, created_by) VALUES ('mem_bot', ?, 'usr_bot', 'bookkeeper', '2026-01-01', '2026-01-01', 'studio')").run(w.ws);
  const bot = { ...w.deps, actor: 'member:usr_bot' };
  const txn = w.lines[0].id;
  const r = rest(bot, 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: txn, idempotencyKey: 'l7-1' });
  assert.equal(r.drafted, true, JSON.stringify(r));
  assert.equal(r.notDecided, undefined);
  assert.equal(lineState(w, txn), 'open');
  assert.equal(traceRows(w, 'approve_drafted_action').length, 0);
  w.deps.store.close();
});

test('the undo hint names reopen_bank_line wherever an ignore executes (paper critic M4), and the setting agent.undo_hints off removes it', () => {
  const w = world('undo');
  assert.equal(getAction('set_agent_dial').run(asStudio(w.deps), { workspaceId: w.ws, capability: 'post', level: 'auto', idempotencyKey: 'undo-dial' }).ok, true);
  const r = ignore(w, w.lines[0].id, 'undo-1');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.drafted, undefined, 'post at auto executes directly');
  assert.deepEqual(r.undo, { tool: 'reopen_bank_line', args: { workspaceId: w.ws, bankTxnId: w.lines[0].id } });
  setting(w, 'agent.undo_hints', 'off');
  const s2 = ignore(w, w.lines[1].id, 'undo-2');
  assert.equal(s2.ok, true, JSON.stringify(s2));
  assert.equal(s2.undo, undefined);
  w.deps.store.close();
});

test('code critic M1: a line a person already ignored is answered alreadyIgnored, with no closures and no undo claimed', () => {
  const w = world('m1');
  const txn = w.lines[0].id;
  const zwei = addSecondSeat(w);
  const theirs = bookDraft(w, zwei, txn, 'm1-book');
  assert.equal(theirs.drafted, true, JSON.stringify(theirs));
  // The person ignores the line: that decision closes the other seat's Vorschlag.
  assert.equal(getAction('ignore_bank_line').run(asStudio(w.deps), { workspaceId: w.ws, bankTxnId: txn, idempotencyKey: 'm1-p' }).ok, true);
  assert.equal(actionRow(w, theirs.actionId).reject_reason, 'Zeile entschieden');
  grant(w, 'decide');
  const r = ignore(w, txn, 'm1-agent');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.alreadyIgnored, true);
  assert.deepEqual(r.closedActionIds, [], 'the person\'s decision closed it, not this call');
  assert.equal(r.undo, undefined, 'no undo of someone else\'s decision');
  assert.equal(decisions(w, txn), 1, 'still the person\'s one decision');
  // The same at post = auto (the hint reaches every seat).
  assert.equal(getAction('set_agent_dial').run(asStudio(w.deps), { workspaceId: w.ws, capability: 'post', level: 'auto', idempotencyKey: 'm1-dial' }).ok, true);
  const auto = ignore(w, txn, 'm1-auto');
  assert.equal(auto.alreadyIgnored, true, JSON.stringify(auto));
  assert.equal(auto.undo, undefined);
  w.deps.store.close();
});

test('code critic L3: a same-key replay of a Vorschlag a person rejected is not approved', () => {
  const w = world('l3');
  grant(w, 'decide');
  setting(w, 'agent.ignore_under_grant', 'two_calls');
  const txn = w.lines[0].id;
  const first = ignore(w, txn, 'l3-k');
  assert.equal(first.drafted, true, JSON.stringify(first));
  assert.equal(getAction('reject_drafted_action').run(asStudio(w.deps), { workspaceId: w.ws, actionId: first.actionId, reason: 'nein' }).ok, true);
  setting(w, 'agent.ignore_under_grant', 'one_call');
  const again = ignore(w, txn, 'l3-k');
  assert.equal(again.actionId, first.actionId, JSON.stringify(again));
  assert.equal(again.status, 'rejected');
  assert.equal(again.notDecided, undefined, 'no approval was attempted');
  assert.equal(traceRows(w, 'approve_drafted_action').length, 0);
  assert.equal(lineState(w, txn), 'open');
  w.deps.store.close();
});

test('a revoke in the gap: the Vorschlag waits, and notDecided says where the owner grants it again', () => {
  const w = world('rvk');
  grant(w, 'decide');
  const txn = w.lines[0].id;
  const r = withGap(() => grant(w, 'off'), () => ignore(w, txn, 'rvk-1'));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.drafted, r.status, r.notDecided.error], [true, 'pending', 'permission_denied']);
  assert.equal(r.notDecided.ownerCanGrant?.setting, 'agent.decide_proposals', JSON.stringify(r.notDecided));
  assert.equal(lineState(w, txn), 'open');
  w.deps.store.close();
});
