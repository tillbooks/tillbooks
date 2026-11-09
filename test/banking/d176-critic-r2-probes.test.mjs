// D176 non-author critic probes, round 2 (critic/d176-r2-2026-10-15, reviewed tip 51be7a24). They attack what the
// round-1 fixes introduced: `rule_invalid` against the replay, `label_taken` / `replaceStandardId` across tenants and
// under a governed seat, the C3 placeholder without a usable Bankkonto, and the `read_sales` gate on
// `post_entry { template }` through both faces. Synthetic data only: invented names, invented amounts, the
// published sample IBANs of bank-inbox-support.mjs.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox, setBankStandard, listBankStandards } from '../../dist/core/banking/index.js';
import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { createAccount, archiveAccount } from '../../dist/core/accounts/accounts.js';
import { makeContext } from '../../dist/core/context.js';
import { enqueueDraftedAction } from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { world, secondWorkspace, importLines, must, refused, rowCounts, excuseClaimInvariant, assertClaimInvariantHolds, TELCO_IBAN } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const DATE = '2026-07-31';
const call = (t, name, input) => getAction(name).run(t.deps, { workspaceId: t.workspaceId, ...input });
const standardRows = (t, ws = t.workspaceId) => t.store.db.prepare('SELECT * FROM bank_standard WHERE workspace_id = ? ORDER BY rowid').all(ws);
const lineOf = (t, id) => must(listBankInbox(t.ctx, { status: 'all' })).lines.find((l) => l.bankTxnId === id);

function vWorld() {
  const t = world();
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }));
  return t;
}
const leg = (t, number, side, amount, taxCode = null) => ({ accountId: t.acc(number), taxCode, side, amount });
const wagesLegs = (t) => [leg(t, '5000', 'debit', { kind: 'ask', label: 'Brutto' }), leg(t, '2800', 'credit', { kind: 'rest' })];
const otherLegs = (t) => [leg(t, '6570', 'debit', { kind: 'ask', label: 'Betrag' }), leg(t, '2800', 'credit', { kind: 'rest' })];

// ================================================================================================
// 1. rule_invalid never pre-empts the replay of an entry already posted
// ================================================================================================

test('[PROBE R2] a template post replays its stored result after the Vorlage went invalid; a new key is rule_invalid', () => {
  const t = vWorld();
  const v = must(setBankStandard(t.ctx, { scope: 'manual', label: 'Abgrenzung', legs: otherLegs(t), idempotencyKey: 'rp-v' })).standard;
  const input = { date: DATE, source: 'manual', template: { standardId: v.id, asks: { 0: 1000 } }, idempotencyKey: 'rp-1' };
  const posted = must(call(t, 'post_entry', input));
  must(archiveAccount(t.ctx, { accountId: t.acc('6570') }));
  const counts = rowCounts(t.store, t.workspaceId);
  assert.deepEqual(call(t, 'post_entry', input), posted, 'the replay answers the stored result');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
  refused(call(t, 'post_entry', { ...input, idempotencyKey: 'rp-2' }), 'rule_invalid');
});

// ================================================================================================
// 2. label_taken / replaceStandardId (the author's R2-1 fix retired the bare `replace: true` these probes first used)
// ================================================================================================

test('[PROBE R2] replaceStandardId never reaches another workspace: B saving "Lohn" naming A\'s "Lohn" leaves it live', () => {
  const t = vWorld();
  const b = secondWorkspace(t);
  const aLohn = must(setBankStandard(t.ctx, { scope: 'manual', label: 'Lohn', legs: wagesLegs(t), idempotencyKey: 'xt-a' })).standard;
  const bLohn = must(setBankStandard(b.ctx, { scope: 'manual', label: 'Lohn', legs: wagesLegs(b), replaceStandardId: aLohn.id, idempotencyKey: 'xt-b' }));
  assert.equal(bLohn.supersededId, null, 'nothing of B was replaced');
  assert.equal(standardRows(t).find((r) => r.id === aLohn.id).superseded_at, null, "A's Vorlage is untouched");
  // And B cannot edit A's Vorlage by id, replace or not.
  refused(setBankStandard(b.ctx, { scope: 'manual', standardId: aLohn.id, label: 'Lohn', legs: wagesLegs(b), replaceStandardId: aLohn.id, idempotencyKey: 'xt-c' }), 'rule_not_found');
});

test('[PROBE R2] label_taken is not memoised: the same key then succeeds naming the holder; a replay without it answers that result', () => {
  const t = vWorld();
  const holder = must(setBankStandard(t.ctx, { scope: 'manual', label: 'Lohn', legs: wagesLegs(t), idempotencyKey: 'lm-a' })).standard;
  const input = { scope: 'manual', label: 'Lohn', legs: otherLegs(t), idempotencyKey: 'lm-1' };
  refused(setBankStandard(t.ctx, input), 'label_taken');
  const done = must(setBankStandard(t.ctx, { ...input, replaceStandardId: holder.id }));
  assert.deepEqual(setBankStandard(t.ctx, input), done, 'the key now replays the stored replacement');
  refused(setBankStandard(t.ctx, { ...input, replace: 'yes', idempotencyKey: 'lm-2' }), 'invalid_input');
});

const agentCtx = (t) => makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.deps.clock, ids: t.deps.ids });
const approve = (t, actionId) => getAction('approve_drafted_action').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, actionId });

test('[FINDING D176-R2-1] an agent drafts a Vorlage "Lohn" replacing the "Lohn" it saw; the person then edits "Lohn"; approval must not replace the edited Vorlage', () => {
  excuseClaimInvariant();
  const t = vWorld();
  const l = importLines(t, { statementId: 'BS-AG', entries: [{ ref: 'P1', amountMinor: 3000, cd: 'CRDT', name: 'Zahlwerk Beispiel Ltd' }] }).lines;
  const lohn = must(setBankStandard(t.ctx, { scope: 'manual', label: 'Lohn', legs: wagesLegs(t), idempotencyKey: 'ag-lohn' })).standard;
  must(setBankStandard(t.ctx, { bankTxnId: l.P1, accountId: t.acc('1095'), taxCode: null, followUpStandardId: lohn.id, idempotencyKey: 'ag-rule' }));
  const drafted = enqueueDraftedAction(agentCtx(t), {
    actionTool: 'set_bank_standard',
    payload: { workspaceId: t.workspaceId, scope: 'manual', label: 'Lohn', legs: otherLegs(t), replaceStandardId: lohn.id, idempotencyKey: 'ag-draft' },
  });
  assert.equal(drafted.ok, true, JSON.stringify(drafted));
  // The person edits "Lohn" after the draft (a new row, a new id, new legs).
  const edited = must(
    setBankStandard(t.ctx, { scope: 'manual', standardId: lohn.id, label: 'Lohn', legs: [leg(t, '5000', 'debit', { kind: 'ask', label: 'Bruttolohn' }), leg(t, '2800', 'credit', { kind: 'rest' })], idempotencyKey: 'ag-edit' }),
  ).standard;
  const decided = approve(t, drafted.actionId);
  const editedRow = standardRows(t).find((r) => r.id === edited.id);
  assert.ok(
    decided.error === 'vorschlag_stale' || editedRow.superseded_at === null,
    `the approval replaced a Vorlage the draft never saw (${edited.id}, edited after the draft): ${JSON.stringify(decided).slice(0, 200)}`,
  );
});

// ================================================================================================
// 3. The C3 placeholder: a Bankkonto whose ledger account is archived, several Bankkonten
// ================================================================================================

test('[PROBE R2] an edit to "Nicht buchen" with the oldest Bankkonto ledger archived still stores a bank ledger and proposes the ignore', () => {
  const t = vWorld();
  const l = importLines(t, { statementId: 'BS-PA', entries: [{ ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }).lines;
  const r = must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'pa-1' })).standard;
  const archived = archiveAccount(t.ctx, { accountId: t.bankId });
  const ig = must(setBankStandard(t.ctx, { standardId: r.id, outcome: 'ignore', ignoreReason: 'duplicate', idempotencyKey: 'pa-2' })).standard;
  const row = standardRows(t).find((x) => x.id === ig.id);
  assert.equal(row.account_id, t.bankId, `archive of the ledger answered ${JSON.stringify(archived)}`);
  const listed = must(listBankStandards(t.ctx, {})).standards.find((s) => s.id === ig.id);
  assert.deepEqual([listed.accountId, listed.invalidReason], [null, null], 'an ignore rule names no account, so it never goes invalid');
  assert.equal(lineOf(t, l.TEL).proposal.reasonCode, 'rule_ignore');
});

// ================================================================================================
// 4. read_sales on post_entry { template }: MCP and REST agree, typed lines unchanged
// ================================================================================================

function seatHolding(capabilities, seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Rollen GmbH', `r2-${seed}`);
  must(getAction('invite_member').run(deps, { workspaceId, email: `${seed}@muster.ch`, role: 'bookkeeper', idempotencyKey: `r2-i-${seed}` }));
  const role = must(getAction('define_role').run(deps, { workspaceId, name: 'Genau diese Rechte', capabilities, idempotencyKey: `r2-d-${seed}` }));
  const seat = getAction('list_members')
    .run(deps, { workspaceId })
    .members.find((m) => m.actorId === 'agent');
  must(getAction('set_role').run(deps, { workspaceId, memberId: seat.memberId, role: role.roleId }));
  return { deps: { ...deps, actor: 'agent' }, studio: { ...deps, actor: 'studio' }, workspaceId };
}

test('[PROBE R2] post_entry { template } asks read_sales on the MCP face and the REST face alike; typed lines post on post alone through both', () => {
  excuseClaimInvariant();
  const seat = seatHolding(['post', 'read_books', 'read_vat'], 'tpl');
  const accounts = must(getAction('list_accounts').run(seat.studio, { workspaceId: seat.workspaceId })).accounts;
  const acc = (n) => accounts.find((a) => a.number === n).id;
  const template = { standardId: 'bstd_unknown', asks: {} };
  const viaMcp = getAction('post_entry').run(seat.deps, { workspaceId: seat.workspaceId, date: '2026-03-02', source: 'manual', template, idempotencyKey: 'm-1' });
  const viaRest = handleRest('post_entry', { workspaceId: seat.workspaceId, date: '2026-03-02', source: 'manual', template, idempotencyKey: 'r-1' }, seat.deps).body;
  assert.deepEqual([viaMcp.error, viaMcp.capability], ['permission_denied', 'read_sales']);
  assert.deepEqual([viaRest.error, viaRest.capability], [viaMcp.error, viaMcp.capability], 'REST says what MCP says');
  const lines = [
    { account: acc('6570'), debit: 1000 },
    { account: acc('2800'), credit: 1000 },
  ];
  const typedMcp = getAction('post_entry').run(seat.deps, { workspaceId: seat.workspaceId, date: '2026-03-02', source: 'manual', lines, idempotencyKey: 'm-2' });
  const typedRest = handleRest('post_entry', { workspaceId: seat.workspaceId, date: '2026-03-02', source: 'manual', lines, idempotencyKey: 'r-2' }, seat.deps).body;
  assert.notEqual(typedMcp.error, 'permission_denied', JSON.stringify(typedMcp));
  assert.notEqual(typedRest.error, 'permission_denied', JSON.stringify(typedRest));
});

test('[FINDING D176-R2-2] post_entry with typed lines and template: null is refused (invalid_input with full rights, permission_denied read_sales without it), though lines: null reads as absent', () => {
  const t = vWorld();
  const lines = [
    { account: t.acc('6570'), debit: 1000 },
    { account: t.acc('2800'), credit: 1000 },
  ];
  const plain = call(t, 'post_entry', { date: DATE, source: 'manual', lines, idempotencyKey: 'nt-1' });
  assert.equal(plain.ok, true, JSON.stringify(plain));
  const withNull = call(t, 'post_entry', { date: DATE, source: 'manual', lines, template: null, idempotencyKey: 'nt-2' });
  assert.equal(withNull.ok, true, `a null template is the typed form, as a null lines is the template form: ${JSON.stringify(withNull)}`);
});
