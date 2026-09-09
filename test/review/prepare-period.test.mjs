/**
 * A25 US-A25.5, `prepare_period`: the packet, the machine flags, and the two idempotency claims.
 *
 * The verb's §H-IDEMPOTENT half (same key replays, database untouched) is already held by the
 * conformance gate. What this suite adds is the RE-RUN half the spec states separately: a prepare
 * under a NEW key refreshes the packet and never duplicates a machine flag, and a NEW anomaly
 * appearing between runs is flagged by the re-run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

function fixture(seed) {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Prepare AG', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, accId, call };
}

function reviewRows(fx) {
  return fx.deps.store.db
    .prepare("SELECT * FROM entry_review WHERE workspace_id = ? ORDER BY rowid")
    .all(fx.workspaceId);
}

test('A25: prepare flags the two anomaly shapes and a re-run never duplicates them', () => {
  const fx = fixture('pf');
  // Anomaly 1, the duplicate pair: two posted business entries, same day, same amount.
  fx.call('post_entry', manualPost(fx.accId, 'pf-1', 4200));
  fx.call('post_entry', manualPost(fx.accId, 'pf-2', 4200));
  // Anomaly 2, missing tax code: 6500 declares a VAT default, the lines above carry none.
  // A tax default needs a REGISTERED workspace (needs_vat_registration otherwise).
  fx.call('vat_seed_defaults', {});
  assert.equal(
    fx.call('vat_configure', { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'pf-vc' }).ok,
    true,
  );
  assert.equal(fx.call('account_set_tax_default', { accountId: fx.accId('6500'), taxCode: 'VST-M' }).ok, true);

  const first = fx.call('prepare_period', { period: '2026-03', idempotencyKey: 'pf-a' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const newFlags = first.packet.flags.filter((f) => f.new);
  // Both entries get a duplicate_suspect flag AND a missing_tax_code flag: four new flags.
  assert.equal(newFlags.length, 4, JSON.stringify(first.packet.flags));
  assert.ok(newFlags.some((f) => f.comment.startsWith('duplicate_suspect:')));
  assert.ok(newFlags.some((f) => f.comment.startsWith('missing_tax_code: account 6500')));
  const rowsAfterFirst = reviewRows(fx);
  assert.equal(rowsAfterFirst.length, 4);
  assert.ok(rowsAfterFirst.every((r) => r.source === 'prepare' && r.status === 'flagged'));

  // The re-run under a NEW key: same anomalies found, nothing written twice.
  const second = fx.call('prepare_period', { period: '2026-03', idempotencyKey: 'pf-b' });
  assert.equal(second.ok, true);
  assert.equal(second.packet.flags.filter((f) => f.new).length, 0, 'a re-run duplicated a machine flag');
  assert.equal(reviewRows(fx).length, 4);

  // A NEW anomaly between runs IS caught: a third posting of the same shape.
  fx.call('post_entry', manualPost(fx.accId, 'pf-3', 4200));
  const third = fx.call('prepare_period', { period: '2026-03', idempotencyKey: 'pf-c' });
  assert.equal(third.ok, true);
  const thirdNew = third.packet.flags.filter((f) => f.new);
  assert.ok(thirdNew.length > 0, 'the re-run missed a new anomaly');
  // The pre-existing pair's duplicate comments now name TWO others, so they are new rows by
  // identity, but no (entry, comment) pair ever appears twice.
  const all = reviewRows(fx).map((r) => `${r.entry_id}|${r.comment}`);
  assert.equal(new Set(all).size, all.length, 'a (entry, comment) machine flag was written twice');
});

test('A25: the packet counts come from the owning read models', () => {
  const fx = fixture('pk');
  fx.call('post_entry', manualPost(fx.accId, 'pk-1'));
  const draft = fx.call('save_draft', {
    date: '2026-03-10',
    lines: [
      { account: fx.accId('6500'), debit: 900 },
      { account: fx.accId('1000'), credit: 900 },
    ],
    idempotencyKey: 'pk-d',
  });
  assert.equal(draft.ok, true);

  const prepared = fx.call('prepare_period', { period: '2026-03', idempotencyKey: 'pk-a' });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const packet = prepared.packet;
  assert.equal(packet.review.total, 1);
  assert.equal(packet.draftCount, 1);
  assert.equal(packet.unmatchedIncoming, 0);
  assert.equal(packet.unmatchedBankTxns, 0);
  assert.equal(packet.openDebtors, 0);
  // No VAT config: the packet SURFACES the code as a note (never a failed prepare).
  assert.equal(typeof packet.vatPreview.error, 'string');

  // An unmatched incoming credit shows up in the next packet.
  const bank = fx.call('create_bank_account', {
    name: 'Kontokorrent',
    iban: 'CH93 0076 2011 6238 5295 7',
    currency: 'CHF',
    ledgerAccountId: fx.accId('1020'),
    idempotencyKey: 'pk-bank',
  });
  assert.equal(bank.ok, true);
  const credit = fx.call('record_incoming_credit', {
    bankAccountId: bank.bankAccountId,
    amountMinor: 12500,
    valueDate: '2026-03-15',
    idempotencyKey: 'pk-credit',
  });
  assert.equal(credit.ok, true, JSON.stringify(credit));
  const again = fx.call('prepare_period', { period: '2026-03', idempotencyKey: 'pk-b' });
  assert.equal(again.packet.unmatchedIncoming, 1);
});

test('A25: prepare refuses a malformed period and requires its key', () => {
  const fx = fixture('pv');
  assert.equal(fx.call('prepare_period', { period: 'Q1-2026', idempotencyKey: 'pv-a' }).error, 'invalid_period');
  assert.equal(fx.call('prepare_period', { period: '2026-03' }).error, 'invalid_input');
});
