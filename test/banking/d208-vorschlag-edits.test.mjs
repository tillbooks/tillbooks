// D208 (owner, 18.11.2026): the Vorschlag row's open line books the line with the person's values, keeps a
// changed booking as a Buchungsregel with the star, and carries a comment to the agent on the rule.
//
// THE ENGINE CHOICE FOR "BOOK WITH CHANGES" (no new verb). A person who changes the booking text, the account
// or the MWST code of an agent's bank-line Vorschlag books the line with `book_bank_line` and those values;
// the decision's own transaction resolves every pending bank-line draft of that line as decided
// (`resolveLineDraftsOnDecision`, D177: closure_kind `line_decided`, stamped by the deciding person and the
// link that decided). So the draft cannot be approved afterwards (it is no longer pending), a retry of the
// person's click under its one key replays and books nothing more, and undoing that booking
// (`reopen_bank_line`) gives the Vorschlag back as it was. The tests marked [INVARIANT] are the money-path
// assertions for the non-author critic: each names the code it guards, so a mutation of that code fails it.
//
// SYNTHETIC DATA ONLY: every counterparty, text and amount below is invented for this file.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox, setBankStandard, clearBankStandard, listBankStandards } from '../../dist/core/banking/index.js';
import { getAction } from '../../dist/api/registry.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { makeContext } from '../../dist/core/context.js';
import { enqueueDraftedAction } from '../../dist/core/agent/index.js';
import { createAccount } from '../../dist/core/accounts/accounts.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { grantRuleAutobook } from '../../dist/core/banking/autobook.js';
import { debits, bookAsProposed, autopilot, proposalOf, decisionOf, at } from './n04-autobook-support.mjs';
import { world, secondWorkspace, importLines, must, refused, rowCounts, legs, assertClaimInvariantHolds } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const SHOP = 'Papeterie Sonnhalde GmbH';
const studio = (t) => ({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' });
const call = (t, name, input) => getAction(name).run(studio(t), { workspaceId: t.workspaceId, ...input });
const governed = (t, name, input) => runGoverned({ store: t.store, clock: t.clock, ids: t.ids, actor: 'agent' }, getAction(name), { workspaceId: t.workspaceId, ...input });
const lineOf = (t, id) => must(listBankInbox(t.ctx, { status: 'all' }), 'inbox').lines.find((l) => l.bankTxnId === id);
const draftRow = (t, id) => t.store.db.prepare('SELECT id, status, closure_kind, resolved_by, closed_by_link_id FROM agent_action WHERE workspace_id = ? AND id = ?').get(t.workspaceId, id);
const entriesOfLine = (t, id) =>
  t.store.db.prepare("SELECT COUNT(*) AS n FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND state = 'booked'").get(t.workspaceId, id).n;
const entryDescription = (t, entryId) => t.store.db.prepare('SELECT description FROM journal_entry WHERE workspace_id = ? AND id = ?').get(t.workspaceId, entryId).description;

function shopLine(t, key = 'S1', amountMinor = 4870) {
  return importLines(t, { statementId: `BS-${key}`, entries: [{ ref: key, amountMinor, cd: 'DBIT', name: SHOP, ustrd: `Rechnung ${key}` }] }).lines[key];
}

/** The agent's Vorschlag: the whole line to 6500 without MWST. */
function agentDraft(t, line, key = 'd-1', amountMinor = 4870) {
  const drafted = must(governed(t, 'book_bank_line', { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor }] }, idempotencyKey: key }));
  assert.equal(drafted.drafted, true, 'the agent seat drafts');
  return drafted.actionId;
}

/** The person's booking with their own values, as the open line sends it. */
const bookWithEdits = (t, line, key, { account = '6570', text = 'Büromaterial Sonnhalde', amountMinor = 4870 } = {}) =>
  call(t, 'book_bank_line', { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc(account), amountMinor }] }, text, idempotencyKey: key });

// ---------------------------------------------------------------------------------------------------
// Book with changes
// ---------------------------------------------------------------------------------------------------

test('[INVARIANT D208-1] booking a Vorschlag with changed values books the line ONCE with the person\'s account and text, and closes the draft as decided by that person', () => {
  const t = world();
  const line = shopLine(t);
  const actionId = agentDraft(t, line);
  const booked = must(bookWithEdits(t, line, 'edit-1'));
  assert.equal(booked.state, 'booked');
  assert.equal(entryDescription(t, booked.entryId), 'Büromaterial Sonnhalde', 'the person\'s booking text is the entry\'s');
  const numbers = legs(t.store, booked.entryId).map((r) => r.number);
  assert.ok(numbers.includes('6570'), 'the person\'s account carries the expense');
  assert.ok(!numbers.includes('6500'), 'the agent\'s account is not booked');
  // Guards `resolveLineDraftsOnDecision` (bankLines.ts): mutate it away and the draft stays pending.
  const row = draftRow(t, actionId);
  assert.equal(row.status, 'rejected');
  assert.equal(row.closure_kind, 'line_decided');
  assert.equal(row.resolved_by, 'studio', 'stamped by the person who decided');
  assert.equal(row.closed_by_link_id, booked.linkId, 'the closure names the decision that made it');
  assert.equal(lineOf(t, line).vorschlagActionId, null, 'no pending Vorschlag is left on the line');
});

test('[INVARIANT D208-2] a retry of the same click (same key) books nothing more: idempotent on ROWS', () => {
  const t = world();
  const line = shopLine(t);
  agentDraft(t, line);
  const first = must(bookWithEdits(t, line, 'edit-retry'));
  const before = rowCounts(t.store, t.workspaceId);
  const again = must(bookWithEdits(t, line, 'edit-retry'));
  assert.equal(again.entryId, first.entryId, 'the replay answers the same booking');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the replay writes no row anywhere');
  assert.equal(entriesOfLine(t, line), 1, 'one booking of the line');
});

test('[INVARIANT D208-3] the closed draft can no longer be approved: the approval refuses and posts nothing', () => {
  const t = world();
  const line = shopLine(t);
  const actionId = agentDraft(t, line);
  must(bookWithEdits(t, line, 'edit-then-approve'));
  const before = rowCounts(t.store, t.workspaceId);
  const late = call(t, 'approve_drafted_action', { actionId });
  assert.equal(late.ok, false, `the approval refuses: ${JSON.stringify(late)}`);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'nothing is written by the refused approval');
  assert.equal(entriesOfLine(t, line), 1, 'never a double booking');
});

test('[INVARIANT D208-4] a second click with a NEW key on the booked line refuses: the line is decided once', () => {
  const t = world();
  const line = shopLine(t);
  agentDraft(t, line);
  must(bookWithEdits(t, line, 'edit-a'));
  const before = rowCounts(t.store, t.workspaceId);
  const second = bookWithEdits(t, line, 'edit-b', { account: '6500' });
  assert.equal(second.ok, false);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before);
});

test('[INVARIANT D208-5] undoing the person\'s booking gives the agent\'s Vorschlag back, pending and approvable as drafted', () => {
  const t = world();
  const line = shopLine(t);
  const actionId = agentDraft(t, line);
  must(bookWithEdits(t, line, 'edit-undo'));
  must(call(t, 'reopen_bank_line', { bankTxnId: line, idempotencyKey: 'undo-1' }));
  assert.equal(draftRow(t, actionId).status, 'pending', 'the undo of THAT decision revives the draft (D177)');
  const approved = must(call(t, 'approve_drafted_action', { actionId }));
  assert.equal(approved.status, 'executed');
  assert.equal(lineOf(t, line).state, 'booked');
});

test('[INVARIANT D208-6] §H-TENANT: another workspace\'s booking never closes this workspace\'s Vorschlag', () => {
  const t = world();
  const b = secondWorkspace(t);
  const line = shopLine(t);
  const actionId = agentDraft(t, line);
  // The same line id named from another workspace is not that workspace's line.
  const foreign = getAction('book_bank_line').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, {
    workspaceId: b.workspaceId,
    bankTxnId: line,
    target: { kind: 'accounts', legs: [{ accountId: b.acc('6570'), amountMinor: 4870 }] },
    idempotencyKey: 'foreign-1',
  });
  assert.equal(foreign.ok, false, 'another workspace cannot book this line');
  assert.equal(draftRow(t, actionId).status, 'pending', 'this workspace\'s Vorschlag stands');
});

// ---------------------------------------------------------------------------------------------------
// The comment to the agent on a rule (set_bank_standard { note })
// ---------------------------------------------------------------------------------------------------

const ruleOf = (t, id, ctx = t.ctx) => must(listBankStandards(ctx, { scope: 'bank' })).standards.find((s) => s.id === id);

test('[INVARIANT D208-7] the note round-trips through set_bank_standard and list_bank_standards, with who and when', () => {
  const t = world();
  const line = shopLine(t);
  const saved = must(setBankStandard(t.ctx, { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: '  Immer auf 6570, nie auf 6500.  ', idempotencyKey: 'n-1' }));
  assert.equal(saved.noteChanged, true);
  const rule = ruleOf(t, saved.standard.id);
  assert.equal(rule.note, 'Immer auf 6570, nie auf 6500.', 'stored trimmed, as plain text');
  assert.equal(rule.noteSetBy, t.ctx.actor);
  assert.equal(typeof rule.noteSetAt, 'string');
  assert.equal(rule.noteHistory.length, 1);
  // The MCP verb answers the same.
  const listed = must(call(t, 'list_bank_standards', { scope: 'bank' }));
  assert.equal(listed.standards.find((s) => s.id === saved.standard.id).note, 'Immer auf 6570, nie auf 6500.');
});

test('[INVARIANT D208-8] a comment alone is NO new rule version (an autopilot grant on the rule survives), and every change is kept in its history', () => {
  const t = world();
  const line = shopLine(t);
  const first = must(setBankStandard(t.ctx, { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'v-1' }));
  const versions = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_standard WHERE workspace_id = ?').get(t.workspaceId).n;
  const before = versions();
  const noted = must(setBankStandard(t.ctx, { standardId: first.standard.id, accountId: t.acc('6570'), taxCode: null, note: 'Nur Büromaterial.', idempotencyKey: 'v-2' }));
  assert.equal(noted.unchanged, true, 'the rule stands as it was');
  assert.equal(noted.noteChanged, true);
  assert.equal(noted.supersededId, null);
  assert.equal(noted.standard.id, first.standard.id, 'the same rule version');
  assert.equal(versions(), before, 'no bank_standard row was written');
  must(setBankStandard(t.ctx, { standardId: first.standard.id, accountId: t.acc('6570'), taxCode: null, note: 'Büromaterial und Porto.', idempotencyKey: 'v-3' }));
  must(setBankStandard(t.ctx, { standardId: first.standard.id, accountId: t.acc('6570'), taxCode: null, note: null, idempotencyKey: 'v-4' }));
  const rule = ruleOf(t, first.standard.id);
  assert.equal(rule.note, null, 'cleared');
  assert.deepEqual(rule.noteHistory.map((h) => h.note), [null, 'Büromaterial und Porto.', 'Nur Büromaterial.'], 'every change, newest first');
  // Append-only: the history rows can neither change nor go.
  assert.throws(() => t.store.db.prepare('UPDATE bank_standard_note SET note = ? WHERE workspace_id = ?').run('x', t.workspaceId), /never changed/);
  assert.throws(() => t.store.db.prepare('DELETE FROM bank_standard_note WHERE workspace_id = ?').run(t.workspaceId), /never deleted/);
});

test('[INVARIANT D208-9] the comment follows the rule through an edit (a new version) and ends with a clear', () => {
  const t = world();
  const line = shopLine(t);
  const first = must(setBankStandard(t.ctx, { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: 'Büromaterial.', idempotencyKey: 'f-1' }));
  const edited = must(setBankStandard(t.ctx, { standardId: first.standard.id, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'f-2' }));
  assert.equal(edited.unchanged, false, 'a recipe change is a new version');
  assert.equal(edited.noteChanged, false, 'the comment was not touched');
  assert.equal(ruleOf(t, edited.standard.id).note, 'Büromaterial.', 'the comment carries to the new version');
  must(clearBankStandard(t.ctx, { standardId: edited.standard.id, idempotencyKey: 'f-3' }));
  const again = must(setBankStandard(t.ctx, { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'f-4' }));
  assert.equal(ruleOf(t, again.standard.id).note, null, 'a rule set again after a clear starts without the old comment');
});

test('[INVARIANT D208-10] the comment save is idempotent on ROWS: a replay under its key writes nothing', () => {
  const t = world();
  const line = shopLine(t);
  const input = { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: 'Büromaterial.', idempotencyKey: 'i-1' };
  must(setBankStandard(t.ctx, input));
  const before = rowCounts(t.store, t.workspaceId);
  const notes = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_standard_note').get().n;
  const n = notes();
  must(setBankStandard(t.ctx, input));
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before);
  assert.equal(notes(), n);
});

test('[INVARIANT D208-11] §H-TENANT: another workspace neither reads nor writes this rule\'s comment', () => {
  const t = world();
  const b = secondWorkspace(t);
  const line = shopLine(t);
  const saved = must(setBankStandard(t.ctx, { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: 'Nur hier.', idempotencyKey: 't-1' }));
  refused(setBankStandard(b.ctx, { standardId: saved.standard.id, accountId: b.acc('6570'), taxCode: null, note: 'Von nebenan.', idempotencyKey: 't-2' }), 'rule_not_found');
  assert.equal(must(listBankStandards(b.ctx, { scope: 'bank' })).standards.length, 0, 'the other workspace lists no rule');
  assert.equal(ruleOf(t, saved.standard.id).note, 'Nur hier.');
  const foreign = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_standard_note WHERE workspace_id = ?').get(b.workspaceId).n;
  assert.equal(foreign, 0);
});

test('[D208] the note is bounded plain text, and a Vorlage carries none', () => {
  const t = world();
  const line = shopLine(t);
  refused(setBankStandard(t.ctx, { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: 'x'.repeat(501), idempotencyKey: 'b-1' }), 'invalid_input');
  refused(setBankStandard(t.ctx, { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: 'a\u0007b', idempotencyKey: 'b-2' }), 'invalid_input');
  refused(setBankStandard(t.ctx, { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: 42, idempotencyKey: 'b-3' }), 'invalid_input');
  const vorlage = setBankStandard(t.ctx, {
    scope: 'manual',
    label: 'Porto Sonnhalde',
    legs: [
      { accountId: t.acc('6500'), taxCode: null, amount: { kind: 'ask', label: 'Betrag' }, side: 'debit' },
      { accountId: t.acc('1020'), taxCode: null, amount: { kind: 'rest' }, side: 'credit' },
    ],
    note: 'nein',
    idempotencyKey: 'b-4',
  });
  refused(vorlage, 'invalid_input');
  must(setBankStandard(t.ctx, { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: 'x'.repeat(500), idempotencyKey: 'b-5' }));
});

test('[D208] the star: a changed booking saved as the rule carries the line\'s booking text as its leg description', () => {
  const t = world();
  const line = shopLine(t);
  agentDraft(t, line);
  must(bookWithEdits(t, line, 'star-book', { text: 'Büromaterial Sonnhalde' }));
  const saved = must(
    setBankStandard(t.ctx, {
      fromBankTxnId: line,
      legs: [{ accountId: t.acc('6570'), taxCode: null, amount: { kind: 'rest' }, description: 'Büromaterial Sonnhalde' }],
      expectSlotStandardId: null,
      note: 'Sonnhalde ist Büromaterial.',
      idempotencyKey: 'star-rule',
    }),
  );
  const rule = ruleOf(t, saved.standard.id);
  assert.equal(rule.legs[0].description, 'Büromaterial Sonnhalde');
  assert.equal(rule.note, 'Sonnhalde ist Büromaterial.');
  // The next line of the counterparty is proposed by that rule.
  const next = shopLine(t, 'S2', 1290);
  assert.equal(lineOf(t, next).proposal.reasonCode, 'standard');
  assert.equal(lineOf(t, next).standardId, saved.standard.id);
});

// ---------------------------------------------------------------------------------------------------
// Security review (18.11.2026): the comment is the OWNER's text; no agent, TILL or replayed draft writes it
// ---------------------------------------------------------------------------------------------------

const noteRows = (t) => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_standard_note').get().n;

test('[INVARIANT D208-12] an agent seat\'s note is refused note_human_only, directly and at draft time, and nothing is drafted or written', () => {
  const t = world();
  const line = shopLine(t);
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  // Guards `ruleNoteRefusal` (bankStandards.ts): mutate it away and these save or draft the note.
  refused(setBankStandard(agentCtx, { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: 'Ab jetzt alles auf 6570.', idempotencyKey: 'ag-1' }), 'note_human_only');
  refused(setBankStandard(agentCtx, { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: null, idempotencyKey: 'ag-1b' }), 'note_human_only');
  const drafts = () => t.store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND action_tool = 'set_bank_standard'").get(t.workspaceId).n;
  const before = drafts();
  const viaGate = governed(t, 'set_bank_standard', { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: 'Ab jetzt alles auf 6570.', idempotencyKey: 'ag-2' });
  assert.equal(viaGate.ok, false, `the gate refuses: ${JSON.stringify(viaGate)}`);
  assert.equal(viaGate.error, 'note_human_only');
  assert.equal(drafts(), before, 'no Vorschlag carrying a note is drafted');
  assert.equal(noteRows(t), 0);
  const system = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'system', clock: t.clock, ids: t.ids });
  refused(setBankStandard(system, { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: 'x', idempotencyKey: 'sys-1' }), 'note_human_only');
});

test('[INVARIANT D208-13] a Vorschlag that carries a note is refused at approval: a note is never replayed from a draft', () => {
  const t = world();
  const line = shopLine(t);
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  // A draft row written past the pre-draft screen (an older build, or a forged row): the approval must still refuse.
  const drafted = must(
    enqueueDraftedAction(agentCtx, {
      actionTool: 'set_bank_standard',
      payload: { workspaceId: t.workspaceId, bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: 'Ab jetzt alles auf 6570.', idempotencyKey: 'ag-draft' },
      dialCapability: 'post',
    }),
  );
  const versions = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_standard WHERE workspace_id = ?').get(t.workspaceId).n;
  const before = versions();
  const approved = call(t, 'approve_drafted_action', { actionId: drafted.actionId });
  const refusal = approved.ok ? approved.result : approved;
  assert.equal(refusal?.ok, false, `the replay refuses: ${JSON.stringify(approved)}`);
  assert.equal(refusal.error, 'note_human_only');
  assert.equal(versions(), before, 'no rule was saved');
  assert.equal(noteRows(t), 0, 'no comment was written');
});

test('[INVARIANT D208-14] a person\'s note round-trips with its author, as data on the rule', () => {
  const t = world();
  const line = shopLine(t);
  const saved = must(call(t, 'set_bank_standard', { bankTxnId: line, accountId: t.acc('6570'), taxCode: null, note: 'Sonnhalde ist Büromaterial.', idempotencyKey: 'h-1' }));
  const listed = must(call(t, 'list_bank_standards', { scope: 'bank' })).standards.find((s) => s.id === saved.standard.id);
  assert.equal(listed.note, 'Sonnhalde ist Büromaterial.');
  assert.equal(listed.noteSetBy, 'studio', 'the person who wrote it');
  assert.deepEqual(listed.noteHistory.map((h) => h.setBy), ['studio']);
});

// ---------------------------------------------------------------------------------------------------
// Critic D208 (18.11.2026): the open line's star sends a kept rule back as list_bank_standards reads it
// ---------------------------------------------------------------------------------------------------

/** What the Studio's open line sends for a rule it keeps (lineContext.parseRules, openLineCommit.legsOf). */
const recipeAsListed = (rule) =>
  rule.legs.map((l) => ({
    accountId: l.accountId,
    taxCode: l.taxCode ?? null,
    amount: l.amount,
    ...(l.against === true ? { against: true } : {}),
    ...(typeof l.description === 'string' && l.description !== '' ? { description: l.description } : {}),
  }));

test('[INVARIANT D208-15] a kept rule sent back as listed, with a comment, is NO new version: recipe, name, Durchlaufkonto and next step survive, by standardId and by the pinned slot', () => {
  const t = world();
  const line = shopLine(t);
  const via = must(createAccount(t.ctx, { number: '1095', name: 'Durchlaufkonto Papeterie', type: 'asset', idempotencyKey: 'acc-1095' }), '1095');
  const next = must(
    setBankStandard(t.ctx, {
      scope: 'manual',
      label: 'Porto Sonnhalde',
      legs: [
        { accountId: t.acc('6500'), taxCode: null, amount: { kind: 'ask', label: 'Betrag' }, side: 'debit' },
        { accountId: t.acc('6570'), taxCode: null, amount: { kind: 'rest' }, side: 'credit' },
      ],
      idempotencyKey: 'k-v',
    }),
  );
  const first = must(
    setBankStandard(t.ctx, {
      bankTxnId: line,
      label: 'Papeterie',
      viaAccountId: via.accountId,
      followUpStandardId: next.standard.id,
      legs: [
        { accountId: t.acc('6570'), taxCode: null, amount: { kind: 'rest' }, description: 'Büromaterial' },
        { accountId: t.acc('6500'), taxCode: null, amount: { kind: 'ask', label: 'Porto' } },
      ],
      idempotencyKey: 'k-1',
    }),
  );
  const versions = () => t.store.db.prepare("SELECT COUNT(*) AS n FROM bank_standard WHERE workspace_id = ? AND scope = 'bank'").get(t.workspaceId).n;
  const before = versions();
  const listed = ruleOf(t, first.standard.id);
  const kept = { legs: recipeAsListed(listed), label: listed.label, followUpStandardId: listed.followUpStandardId, viaAccountId: listed.viaAccountId };
  // "Regel anpassen" with a comment only.
  const byId = must(setBankStandard(t.ctx, { standardId: first.standard.id, ...kept, note: 'Nur Büromaterial.', idempotencyKey: 'k-2' }));
  assert.equal(byId.unchanged, true, 'the rule stands as it was');
  assert.equal(byId.noteChanged, true);
  assert.equal(byId.supersededId, null);
  // The star on a line whose slot holds the same booking: the slot pinned, the rule sent back as listed.
  const bySlot = must(setBankStandard(t.ctx, { fromBankTxnId: line, ...kept, expectSlotStandardId: first.standard.id, note: 'Büromaterial und Porto.', idempotencyKey: 'k-3' }));
  assert.equal(bySlot.unchanged, true);
  assert.equal(bySlot.standard.id, first.standard.id);
  assert.equal(versions(), before, 'no bank_standard row was written');
  const after = ruleOf(t, first.standard.id);
  assert.equal(after.label, 'Papeterie');
  assert.equal(after.viaAccountId, via.accountId);
  assert.equal(after.followUpStandardId, next.standard.id);
  assert.deepEqual(recipeAsListed(after), recipeAsListed(listed));
  assert.equal(after.note, 'Büromaterial und Porto.');
});

// ---------------------------------------------------------------------------------------------------
// D208 point 8 (critic r3, the root): a rule's booking text is the text of EVERY entry it books
// ---------------------------------------------------------------------------------------------------

const TEXT = 'Telefon Fernmeldewerk';
/** A world with a rule whose only (rest) leg carries the booking text, saved from its first line. */
function textRuleWorld() {
  const t = world();
  const [first] = debits(t, [1000]);
  const ruleId = must(
    setBankStandard(t.ctx, { bankTxnId: first, legs: [{ accountId: t.acc('6570'), taxCode: null, amount: { kind: 'rest' }, description: TEXT }], idempotencyKey: 'txt-rule' }),
  ).standard.id;
  return { ...t, ruleId };
}
const entryOf = (t, line) => decisionOf(t, line).entry_id;
const accountsOf = (t, entryId) => legs(t.store, entryId).map((r) => r.number).sort();

test('[INVARIANT D208-16] the inbox proposal of a rule with a text books that text, accounts and amount unchanged, and a replay writes nothing', () => {
  const t = textRuleWorld();
  const [line] = debits(t, [1290]);
  const target = proposalOf(t, line).target;
  assert.equal(target.kind, 'accounts', 'a plain rule proposes the accounts it books');
  const input = { bankTxnId: line, target, idempotencyKey: 'txt-inbox' };
  const booked = must(call(t, 'book_bank_line', input));
  // Guards `restLegText` in `dispatchBooking` (bankBooking.ts): mutate it away and the default text stands.
  assert.equal(entryDescription(t, booked.entryId), TEXT);
  assert.deepEqual(accountsOf(t, booked.entryId), ['1020', '6570']);
  const before = rowCounts(t.store, t.workspaceId);
  assert.equal(must(call(t, 'book_bank_line', input)).entryId, booked.entryId);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'idempotent on ROWS');
});

test('[D208] the rule target and the bulk verb book the rule\'s text; a text the booking names wins', () => {
  const t = textRuleWorld();
  const [a, b, c] = debits(t, [1290, 990, 770]);
  assert.equal(entryDescription(t, must(call(t, 'book_bank_line', { bankTxnId: a, target: { kind: 'rule', standardId: t.ruleId }, idempotencyKey: 'txt-rule-t' })).entryId), TEXT);
  must(call(t, 'book_bank_lines', { items: [{ bankTxnId: b, target: proposalOf(t, b).target }], idempotencyKey: 'txt-bulk' }));
  assert.equal(entryDescription(t, entryOf(t, b)), TEXT, 'bulk');
  assert.equal(entryDescription(t, must(call(t, 'book_bank_line', { bankTxnId: c, target: proposalOf(t, c).target, text: 'Porto', idempotencyKey: 'txt-own' })).entryId), 'Porto');
});

test('[D208] autobook books the rule\'s text', () => {
  const t = textRuleWorld();
  must(settingsSet(t.ctx, { key: 'rules.autobook_offer_after', value: 3, reason: 'D208 test', idempotencyKey: 'oa-3' }));
  for (const id of debits(t, [1100, 1200, 1300])) bookAsProposed(t, id);
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'txt-grant' }), 'grant');
  at(t, '2026-07-20T08:00:00.000Z');
  const [line] = debits(t, [1500]);
  autopilot(t).tick();
  assert.equal(decisionOf(t, line).channel, 'autobook:' + t.ruleId, 'booked by the autopilot');
  assert.equal(entryDescription(t, entryOf(t, line)), TEXT);
});

test('[D208] a split whose rest leg carries no text keeps the default; a booking without any text too', () => {
  const t = world();
  const [a, b] = debits(t, [5000, 3000]);
  const split = must(
    call(t, 'book_bank_line', {
      bankTxnId: a,
      target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 4000 }, { accountId: t.acc('6500'), amountMinor: 1000, description: 'Porto' }] },
      idempotencyKey: 'split',
    }),
  );
  assert.match(entryDescription(t, split.entryId), /^Bank: /);
  const plain = must(call(t, 'book_bank_line', { bankTxnId: b, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 3000 }] }, idempotencyKey: 'plain' }));
  assert.match(entryDescription(t, plain.entryId), /^Bank: /);
});

test('[D208] a rule with an asked leg books its REST leg\'s text, whichever leg the asked amount makes the largest', () => {
  const t = world();
  const [first, small, large] = debits(t, [1000, 1000, 1000]);
  const ruleId = must(
    setBankStandard(t.ctx, {
      bankTxnId: first,
      legs: [
        { accountId: t.acc('6500'), taxCode: null, amount: { kind: 'ask', label: 'Mietzins' }, description: 'Mietzins' },
        { accountId: t.acc('6570'), taxCode: null, amount: { kind: 'rest' }, description: 'Nebenkosten' },
      ],
      idempotencyKey: 'mn-rule',
    }),
  ).standard.id;
  const book = (line, ask, key) => must(call(t, 'book_bank_line', { bankTxnId: line, target: { kind: 'rule', standardId: ruleId, asks: { 0: ask } }, idempotencyKey: key }));
  assert.equal(entryDescription(t, book(small, 200, 'mn-1').entryId), 'Nebenkosten', 'the rest leg is the largest');
  assert.equal(entryDescription(t, book(large, 800, 'mn-2').entryId), 'Nebenkosten', 'the asked leg is the largest: still the rest leg\'s text');
});

test('[D208] bank.entry_text_from_leg: leg (default) books the rule\'s text; bank keeps the bank\'s text; another value is refused', () => {
  const t = textRuleWorld();
  const [a, b] = debits(t, [1290, 990]);
  assert.equal(entryDescription(t, must(call(t, 'book_bank_line', { bankTxnId: a, target: proposalOf(t, a).target, idempotencyKey: 'set-leg' })).entryId), TEXT);
  must(settingsSet(t.ctx, { key: 'bank.entry_text_from_leg', value: 'bank', reason: 'D208 test', idempotencyKey: 'set-bank' }));
  assert.match(entryDescription(t, must(call(t, 'book_bank_line', { bankTxnId: b, target: proposalOf(t, b).target, idempotencyKey: 'set-bank-b' })).entryId), /^Bank: /);
  refused(settingsSet(t.ctx, { key: 'bank.entry_text_from_leg', value: 'other', reason: 'D208 test', idempotencyKey: 'set-other' }), 'invalid_setting_value');
});
