// D176 non-author critic probes, round 3 (critic/d176-r3-2026-10-15, reviewed tip d7377464): a save that names a
// holder (`replaceStandardId`) when NO Vorlage holds the name any more. Synthetic data only.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setBankStandard, clearBankStandard, listBankStandards } from '../../dist/core/banking/index.js';
import { createAccount } from '../../dist/core/accounts/accounts.js';
import { world, importLines, must, assertClaimInvariantHolds } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const leg = (t, number, side, amount) => ({ accountId: t.acc(number), taxCode: null, side, amount });

test('[PROBE R3] a stale replaceStandardId on a free name supersedes nothing; the holder it named stays as it was', () => {
  const t = world();
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }));
  const l = importLines(t, { statementId: 'BS-R3', entries: [{ ref: 'P1', amountMinor: 3000, cd: 'CRDT', name: 'Zahlwerk Beispiel Ltd' }] }).lines;
  const wages = [leg(t, '5000', 'debit', { kind: 'ask', label: 'Brutto' }), leg(t, '2800', 'credit', { kind: 'rest' })];
  const other = [leg(t, '6570', 'debit', { kind: 'ask', label: 'Betrag' }), leg(t, '2800', 'credit', { kind: 'rest' })];
  const lohn = must(setBankStandard(t.ctx, { scope: 'manual', label: 'Lohn', legs: wages, idempotencyKey: 'r3-a' })).standard;
  const rule = must(setBankStandard(t.ctx, { bankTxnId: l.P1, accountId: t.acc('1095'), taxCode: null, followUpStandardId: lohn.id, idempotencyKey: 'r3-rule' })).standard;
  // The person renames "Lohn" away after a draft named it.
  const renamed = must(setBankStandard(t.ctx, { scope: 'manual', standardId: lohn.id, label: 'Gehalt', legs: wages, idempotencyKey: 'r3-ren' })).standard;
  const before = t.store.db.prepare('SELECT id, superseded_at FROM bank_standard WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);
  const saved = must(setBankStandard(t.ctx, { scope: 'manual', label: 'Lohn', legs: other, replaceStandardId: lohn.id, idempotencyKey: 'r3-b' }));
  assert.equal(saved.supersededId, null, 'no row is replaced');
  const after = t.store.db.prepare('SELECT id, superseded_at FROM bank_standard WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);
  assert.deepEqual(after.slice(0, before.length), before, 'every earlier row is as it was');
  assert.equal(after.find((r) => r.id === renamed.id).superseded_at, null, '"Gehalt" (the renamed holder) is untouched');
  // The name-keyed next step (§15.6) now resolves to the new "Lohn": the pre-existing follow-the-name rule,
  // recorded here as observed, not introduced by replaceStandardId.
  const listed = must(listBankStandards(t.ctx, {})).standards.find((s) => s.id === rule.id);
  assert.equal(listed.followUpStandardId, saved.standard.id);
  must(clearBankStandard(t.ctx, { standardId: saved.standard.id, idempotencyKey: 'r3-c' }));
});
