/**
 * D165 follow-ups, round 3 (critic round 2, finding R2-3, `docs/critique/d165-followups-2026-10-14-critique.md`
 * on `origin/critic/d165-followups-2026-10-14`): on the managed (cloud) rail, `payment_batch_transmit`'s
 * intent row and its `failed` order were unscoped, so a `bank_rejected` approval was marked as having run
 * and, once its batch was discarded, could neither execute nor be rejected. The intent and the `failed`
 * order are the transmit's own bookkeeping now; a relay that THROWS (outcome unknown) and an accepted
 * submit still mark. Measured on the commit mark itself (`SqliteStore.withCommitMark`), the way an
 * approval sees it. Synthetic data only (the A37 test's fixture shape).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup, PLAIN_IBAN } from '../banking/support.mjs';
import { createContact } from '../../dist/core/sales/index.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createBankAccount, setCreditorBankProfile, createPaymentBatch, generatePain001 } from '../../dist/core/banking/index.js';
import { connectBankChannel, transmitPaymentBatch } from '../../dist/core/banking/ebics/index.js';
import { makeContext } from '../../dist/core/context.js';
import { handleRest } from '../../dist/api/rest.js';
import { getAction } from '../../dist/api/registry.js';

function must(/** @type {any} */ res, /** @type {string} */ label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

/** A managed relay with PSS consent granted; `submit` decides what the payment submit does. */
function relay(/** @type {() => { ok: boolean, reason?: string }} */ submit) {
  let consent = 'pending';
  return {
    grant() {
      consent = 'granted';
    },
    port: {
      beginConsent: () => ({ ok: true, consentUrl: 'https://bank.example/consent/1', consentRef: 'cref-1' }),
      getConsentState: () => ({ ok: true, state: consent, scopes: ['ais', 'pss'] }),
      fetchQueued: () => ({ ok: true, files: [] }),
      acknowledge: () => ({ ok: true }),
      submitPayment: () => submit(),
      getDeliveryLog: () => ({ ok: true, entries: [] }),
    },
  };
}

/** An active managed connection and a generated batch, then the transmit under a commit mark. */
function transmitUnderMark(/** @type {() => { ok: boolean, reason?: string }} */ submit, /** @type {string} */ seed) {
  const t = setup();
  const r = relay(submit);
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, managedChannel: r.port });
  const bankAccountId = must(createBankAccount(ctx, { name: `Konto ${seed}`, iban: PLAIN_IBAN, ledgerAccountId: t.acc('1020'), idempotencyKey: `ba-${seed}` }), 'bank account').bankAccountId;
  const c1 = must(connectBankChannel(ctx, { channelKind: 'managed_blink', bankRef: 'blink:UBS-CH', scopes: ['ais', 'pss'], routeBankAccountIds: [bankAccountId], confirm: true, idempotencyKey: `${seed}-conn` }), 'connect');
  r.grant();
  must(connectBankChannel(ctx, { channelKind: 'managed_blink', connectionId: c1.connectionId, confirm: true, idempotencyKey: `${seed}-conn2` }), 'advance');
  const vendor = must(createContact(ctx, { partyRole: 'vendor', name: `Lief ${seed}`, idempotencyKey: `v-${seed}` }), 'contact').contact.id;
  const bill = must(createVendorBill(ctx, { vendorId: vendor, billDate: '2026-03-01', vendorReference: `LG-${seed}`, amountMinor: 100000, expenseAccountId: t.acc('6500'), idempotencyKey: `bill-${seed}` }), 'bill');
  must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `post-${seed}` }), 'post');
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: `cbp-${seed}` }), 'creditor');
  const batch = must(createPaymentBatch(ctx, { bankAccountId, itemIds: [bill.vendorBillId], executionDate: '2026-03-20', idempotencyKey: `batch-${seed}` }), 'batch');
  must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: `gen-${seed}` }), 'generate');
  /** @type {boolean[]} */
  const marks = [];
  let outcome;
  let threw = false;
  try {
    outcome = t.store.withCommitMark((/** @type {boolean} */ ran) => marks.push(ran), () => transmitPaymentBatch(ctx, { batchId: batch.batchId, confirm: true, idempotencyKey: `${seed}-tx` }));
  } catch {
    threw = true;
  }
  t.store.close();
  return { outcome, threw, ranMarked: marks.includes(true), marks };
}

test('D165 R2-3: a managed-rail transmit the relay rejects writes only its own bookkeeping, never marking the act as run', () => {
  const r = transmitUnderMark(() => ({ ok: false, reason: 'insufficient_cover' }), 'rej');
  assert.equal(/** @type {any} */ (r.outcome)?.error, 'bank_rejected', JSON.stringify(r.outcome));
  assert.ok(r.marks.length > 0, 'the intent and the failed order were stamped as bookkeeping (the premise)');
  assert.equal(r.ranMarked, false, `nothing was submitted: ${JSON.stringify(r.marks)}`);
});

test('D165 R2-3: a managed-rail transmit whose relay THROWS marks the act as run (the payment may have gone)', () => {
  const r = transmitUnderMark(() => {
    throw new Error('crash mid-submit (outcome UNKNOWN)');
  }, 'thr');
  assert.equal(r.threw, true);
  assert.equal(r.ranMarked, true, JSON.stringify(r.marks));
});

test('D165 R2-3: an accepted managed-rail transmit marks the act as run', () => {
  const r = transmitUnderMark(() => ({ ok: true }), 'acc');
  assert.equal(/** @type {any} */ (r.outcome)?.ok, true, JSON.stringify(r.outcome));
  assert.equal(r.ranMarked, true, JSON.stringify(r.marks));
});

test('D165 R3-2: an approved managed-rail transmit whose relay threw settles executed as in doubt on re-approve, and is never submitted twice', () => {
  const t = setup();
  let calls = 0;
  let throwIt = true;
  const r = relay(() => {
    calls += 1;
    if (throwIt) throw new Error('crash mid-submit (outcome UNKNOWN)');
    return { ok: true };
  });
  const deps = { ...t.deps, managedChannel: r.port };
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, managedChannel: r.port });
  const seed = 'r32';
  const bankAccountId = must(createBankAccount(ctx, { name: `Konto ${seed}`, iban: PLAIN_IBAN, ledgerAccountId: t.acc('1020'), idempotencyKey: `ba-${seed}` }), 'bank account').bankAccountId;
  const c1 = must(connectBankChannel(ctx, { channelKind: 'managed_blink', bankRef: 'blink:UBS-CH', scopes: ['ais', 'pss'], routeBankAccountIds: [bankAccountId], confirm: true, idempotencyKey: `${seed}-conn` }), 'connect');
  r.grant();
  must(connectBankChannel(ctx, { channelKind: 'managed_blink', connectionId: c1.connectionId, confirm: true, idempotencyKey: `${seed}-conn2` }), 'advance');
  const vendor = must(createContact(ctx, { partyRole: 'vendor', name: `Lief ${seed}`, idempotencyKey: `v-${seed}` }), 'contact').contact.id;
  const bill = must(createVendorBill(ctx, { vendorId: vendor, billDate: '2026-03-01', vendorReference: `LG-${seed}`, amountMinor: 100000, expenseAccountId: t.acc('6500'), idempotencyKey: `bill-${seed}` }), 'bill');
  must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `post-${seed}` }), 'post');
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: `cbp-${seed}` }), 'creditor');
  const batch = must(createPaymentBatch(ctx, { bankAccountId, itemIds: [bill.vendorBillId], executionDate: '2026-03-20', idempotencyKey: `batch-${seed}` }), 'batch');
  must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: `gen-${seed}` }), 'generate');

  const drafted = /** @type {any} */ (handleRest('payment_batch_transmit', { workspaceId: t.workspaceId, batchId: batch.batchId, confirm: true, idempotencyKey: `${seed}-agent` }, { ...deps, actor: 'agent' }).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted).slice(0, 300));
  const approve = () => /** @type {any} */ (getAction('approve_drafted_action').run({ ...deps, actor: 'studio' }, { workspaceId: t.workspaceId, actionId: drafted.actionId, allowFuture: true }));
  const row = () => /** @type {any} */ (t.store.db.prepare('SELECT status, committed_at, result_json FROM agent_action WHERE id = ?').get(drafted.actionId));
  const first = approve();
  assert.equal(first.ok, false, JSON.stringify(first).slice(0, 300));
  assert.equal(calls, 1);
  assert.equal(typeof row().committed_at, 'string', 'the payment may have gone: marked (the premise)');
  throwIt = false;
  const dials = () => JSON.stringify(t.store.db.prepare('SELECT * FROM agent_dial WHERE workspace_id = ? ORDER BY capability').all(t.workspaceId));
  const dialsBefore = dials();
  const settled = approve();
  assert.equal(settled.ok, true, `the re-approve settles the row: ${JSON.stringify(settled).slice(0, 300)}`);
  assert.equal(settled.outcomeUnknown, true);
  assert.equal(settled.outcomeCode, 'transmit_in_doubt');
  assert.equal(settled.granted, undefined, 'no standing grant on a payment nobody knows went');
  assert.equal(dials(), dialsBefore);
  assert.equal(calls, 1, 'never submitted a second time');
  assert.equal(row().status, 'executed');
  assert.equal(JSON.parse(row().result_json).error, 'transmit_in_doubt', 'the record says in doubt, never transmitted');
  const latest = /** @type {any} */ (t.store.db.prepare('SELECT status FROM managed_order_log WHERE workspace_id = ? AND related_id = ? ORDER BY occurred_at DESC, rowid DESC LIMIT 1').get(t.workspaceId, batch.batchId));
  assert.equal(latest.status, 'intent', 'the batch stays in doubt for the person to resolve with the bank');
  // An approve after the settle replays the stored answer and submits nothing.
  approve();
  assert.equal(calls, 1);
  t.store.close();
});
