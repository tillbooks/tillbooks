// A39 through the ONE registry (and so through every face): a stale Vorschlag refused, and the
// governance maps (dial, denylist, A24) holding what the lean spec A39 §3 and D139 decided.
// SYNTHETIC DATA ONLY.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { dialCapabilityForCall, enqueueDraftedAction } from '../../dist/core/agent/index.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/denylist.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';
import { makeContext } from '../../dist/core/context.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { assertClaimInvariantHolds, trackClaimInvariant, camt, MAIN_IBAN } from './bank-inbox-support.mjs';

// Critic A39R2-4: the claim invariant is asserted after EVERY scenario of this suite.
afterEach(assertClaimInvariantHolds);

const call = (deps, name, input) => getAction(name).run(deps, input);

function must(res, label = 'result') {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

/** A workspace seen by a human at the Studio (never the governed `agent` seat). */
function studio(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Bankzeilen AG', `${seed}-ws`);
  trackClaimInvariant(deps.store, workspaceId);
  const c = (name, input) => call(deps, name, { workspaceId, ...input });
  must(c('vat_seed_defaults', {}));
  must(c('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }));
  const bankAccountId = must(c('create_bank_account', { name: 'Geschäftskonto', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: `${seed}-bank` })).bankAccountId;
  return { deps, workspaceId, accId, c, bankAccountId };
}

function importStatement(w, spec, key) {
  return must(w.c('import_camt', { bankAccountId: w.bankAccountId, xml: camt(spec), idempotencyKey: key }), `import ${spec.statementId}`);
}

function lineIds(w, statementId) {
  const out = {};
  for (const r of w.deps.store.db.prepare('SELECT id, entry_ref FROM bank_txn WHERE workspace_id = ? AND statement_id = ?').all(w.workspaceId, statementId)) out[r.entry_ref] = r.id;
  return out;
}

// ================================================================================================
// a stale Vorschlag returns the refusal (walk B14.3)
// ================================================================================================

test('B14.3: approving a stale Vorschlag after a human booked the line returns the refusal, nothing runs', () => {
  const w = studio('stale');
  const imported = importStatement(w, { statementId: 'ST-1', entries: [{ ref: 'A10', amountMinor: 4200, cd: 'DBIT' }] }, 'st-imp');
  const line = lineIds(w, imported.statementId).A10;
  const agentCtx = makeContext(w.deps.store, { workspaceId: w.workspaceId, actor: 'agent', clock: w.deps.clock, ids: w.deps.ids });
  const drafted = must(enqueueDraftedAction(agentCtx, {
    actionTool: 'create_entry_for_txn',
    payload: { workspaceId: w.workspaceId, bankTxnId: line, contraAccountId: w.accId('6500'), idempotencyKey: 'agent-key' },
    dialCapability: 'post',
  }));
  must(w.c('book_bank_line', { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: w.accId('6800'), amountMinor: 4200 }] }, idempotencyKey: 'human' }));
  const entries = () => w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(w.workspaceId).n;
  const before = entries();
  const approved = call(w.deps, 'approve_drafted_action', { workspaceId: w.workspaceId, actionId: drafted.actionId });
  assert.equal(approved.ok, false, 'the stale approval is NOT reported as executed');
  assert.equal(approved.error, 'line_not_open');
  assert.equal(approved.staleProposal, true);
  assert.equal(entries(), before, 'no second booking');
  const status = w.deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(drafted.actionId).status;
  assert.notEqual(status, 'executed', 'the draft is not marked executed (marking it stale is the agent module\'s, recorded in spec A39 §7)');
});

// ================================================================================================
// governance, as spec A39 §0.1 D-A39.4/5 decided
// ================================================================================================

test('the dial is keyed on the target: accounts and matches on post, settlements on pay, undo on pay', () => {
  const line = { workspaceId: 'w', bankTxnId: 'b' };
  assert.equal(dialCapabilityForCall('book_bank_line', { ...line, target: { kind: 'accounts', legs: [] } }), 'post');
  assert.equal(dialCapabilityForCall('book_bank_line', { ...line, target: { kind: 'existing_entry', entryId: 'e' } }), 'post');
  assert.equal(dialCapabilityForCall('book_bank_line', { ...line, target: { kind: 'open_item', documentId: 'd' } }), 'pay');
  assert.equal(dialCapabilityForCall('book_bank_line', { ...line, target: { kind: 'payment_batch', batchId: 'x' } }), 'pay');
  assert.equal(dialCapabilityForCall('reopen_bank_line', line), 'pay');
  assert.equal(dialCapabilityForCall('ignore_bank_line', line), 'post');
  assert.equal(dialCapabilityForCall('book_bank_line', {}), undefined, 'an empty probe is never drafted');
  // D139: a stored rule never decides a bank line nor records, allocates or reverses a payment.
  for (const verb of [
    'book_bank_line',
    'reopen_bank_line',
    'ignore_bank_line',
    'confirm_match',
    'create_entry_for_txn',
    'record_incoming_credit',
    'import_camt',
    'record_payment',
    'allocate_payment',
    'reverse_payment',
    'set_bank_opening_balance',
    'set_write_off_threshold',
  ]) {
    assert.ok(NOT_AUTOMATABLE.has(verb), `${verb} is denied to stored rules`);
  }
  assert.deepEqual(requiredCapabilitiesFor('book_bank_line', { target: { kind: 'accounts' } }), ['post']);
  assert.deepEqual(requiredCapabilitiesFor('book_bank_line', { target: { kind: 'open_item' } }), ['pay']);
  assert.deepEqual(requiredCapabilitiesFor('list_bank_inbox', {}), ['read_sales']);
  // The cut verbs are gone from every face (spec §4.6).
  for (const verb of ['unignore_bank_line', 'bank_rule_upsert', 'bank_rule_list', 'bank_rule_delete', 'bank_balance_status', 'set_bank_reconciliation_mode', 'files_count_linked']) {
    assert.equal(getAction(verb), undefined, `${verb} is not registered`);
  }
});
