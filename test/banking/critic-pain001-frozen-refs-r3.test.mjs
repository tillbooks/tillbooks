// NON-AUTHOR critic probes, round 3, for `claude/pain001-frozen-refs` (A18 F9 + D148 + the owner's
// R2-5 decisions of 01.10.2026). Report: docs/critique/pain001-frozen-refs-critic-r3.md.
//
// Each probe asserts what the branch CLAIMS about the database floor and the erasure: the creditor
// snapshot may be cleared ONLY on an item of a batch discarded before any file, the debtor IBAN cannot
// move under a live batch, and an erasure refuses while a draft batch names any row of the identity.
//
// SYNTHETIC DATA ONLY: every IBAN is invented here with a correct ISO 7064 check digit; every name is
// invented. uuid ids (systemIdGen) throughout.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact, mergeContacts, anonymiseContact } from '../../dist/core/sales/index.js';
import {
  createBankAccount,
  updateBankAccount,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  markBatchPaid,
  discardPaymentBatch,
} from '../../dist/core/banking/index.js';

const AT = '2026-10-01T08:00:00.000Z';

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

function synthIban(iid, account) {
  const bban = `${iid}${account}`;
  const numeric = `${bban}CH00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return `CH${String(98 - rem).padStart(2, '0')}${bban}`;
}
const DEBTOR_IBAN = synthIban('09000', '000000000001');
const OTHER_DEBTOR_IBAN = synthIban('09000', '000000000002');
const vendorIban = (n) => synthIban('09000', String(700000000000 + n));

function world(store = new SqliteStore({ clock: fixedClock(AT) })) {
  const clock = fixedClock(AT);
  const ids = systemIdGen;
  const workspaceId = must(createWorkspace({ store, clock, ids }, { name: 'Erfundene Werkstatt GmbH' }), 'ws').workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  const acc = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number)?.id;
  const bank = must(createBankAccount(ctx, { name: 'Zahlkonto', iban: DEBTOR_IBAN, ledgerAccountId: acc('1020'), idempotencyKey: 'bank' }), 'bank').bankAccountId;
  return { store, workspaceId, ctx, acc, bank };
}

let n = 0;
function vendor(w, tag) {
  const k = ++n;
  return must(createContact(w.ctx, { partyRole: 'vendor', name: `Erfunden ${tag} AG`, idempotencyKey: `v-${tag}-${k}` }), 'contact').contact.id;
}
function bill(w, vendorId, tag) {
  const k = ++n;
  const b = must(
    createVendorBill(w.ctx, { vendorId, billDate: '2026-09-01', vendorReference: `SYN-${tag}`, amountMinor: 20_000 + k, expenseAccountId: w.acc('6500'), idempotencyKey: `bill-${tag}-${k}` }),
    'bill',
  );
  must(postVendorBill(w.ctx, { vendorBillId: b.vendorBillId, idempotencyKey: `post-${tag}-${k}` }), 'post');
  must(setCreditorBankProfile(w.ctx, { vendorId, iban: vendorIban(k), idempotencyKey: `cbp-${tag}-${k}` }), 'cbp');
  return b.vendorBillId;
}
function batch(w, billIds, tag) {
  return must(createPaymentBatch(w.ctx, { bankAccountId: w.bank, itemIds: billIds, executionDate: '2026-10-05', idempotencyKey: `batch-${tag}` }), 'batch').batchId;
}
const itemsOf = (w, batchId) =>
  w.store.db.prepare('SELECT id, seq, creditor_name, creditor_iban FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ? ORDER BY seq').all(w.workspaceId, batchId);

// --- E1/E2: the one admitted clear, and attempts to reach it from elsewhere -------------------------------

test('R3-E1: the clear is admitted only on a batch discarded as a draft: not on a draft, not on a generated batch discarded later, never to another value', () => {
  const w = world();
  const v = vendor(w, 'e1');
  const draft = batch(w, [bill(w, v, 'e1d')], 'e1d');
  const gen = batch(w, [bill(w, v, 'e1g')], 'e1g');
  must(generatePain001(w.ctx, { batchId: gen, idempotencyKey: 'e1g-gen' }), 'gen');
  must(discardPaymentBatch(w.ctx, { batchId: gen, confirmation: true, idempotencyKey: 'e1g-disc' }), 'discard generated');
  const dd = batch(w, [bill(w, v, 'e1x')], 'e1x');
  must(discardPaymentBatch(w.ctx, { batchId: dd, idempotencyKey: 'e1x-disc' }), 'discard draft');

  const clearName = (batchId) => w.store.db.prepare('UPDATE payment_batch_item SET creditor_name = NULL WHERE workspace_id = ? AND batch_id = ?').run(w.workspaceId, batchId);
  const clearIban = (batchId) => w.store.db.prepare("UPDATE payment_batch_item SET creditor_iban = '' WHERE workspace_id = ? AND batch_id = ?").run(w.workspaceId, batchId);
  assert.throws(() => clearName(draft), /refs_frozen/, 'a live draft keeps its snapshot');
  assert.throws(() => clearIban(draft), /refs_frozen/);
  assert.throws(() => clearName(gen), /refs_frozen/, 'a batch that produced a file keeps its snapshot, discarded or not');
  assert.throws(() => clearIban(gen), /refs_frozen/);
  assert.throws(() => w.store.db.prepare("UPDATE payment_batch_item SET creditor_name = 'Jemand Anders' WHERE workspace_id = ? AND batch_id = ?").run(w.workspaceId, dd), /refs_frozen/);
  assert.throws(() => w.store.db.prepare("UPDATE payment_batch_item SET creditor_iban = ? WHERE workspace_id = ? AND batch_id = ?").run(vendorIban(9), w.workspaceId, dd), /refs_frozen/);
  clearName(dd);
  clearIban(dd);
  assert.deepEqual(itemsOf(w, dd).map((i) => [i.creditor_name, i.creditor_iban]), [[null, '']], 'the admitted clear');
});

test('R3-E2: the clear cannot be smuggled onto a sent item by moving it into a discarded draft in the same statement', () => {
  const w = world();
  const v = vendor(w, 'e2');
  const gen = batch(w, [bill(w, v, 'e2a'), bill(w, v, 'e2b')], 'e2g');
  must(generatePain001(w.ctx, { batchId: gen, idempotencyKey: 'e2-gen' }), 'gen');
  const dd = batch(w, [bill(w, v, 'e2x')], 'e2x');
  must(discardPaymentBatch(w.ctx, { batchId: dd, idempotencyKey: 'e2-disc' }), 'discard draft');
  const sent = itemsOf(w, gen).find((i) => i.seq === 2); // seq 2 cannot collide with the draft's seq 1
  assert.throws(
    () => w.store.db.prepare('UPDATE payment_batch_item SET batch_id = ?, creditor_name = NULL WHERE workspace_id = ? AND id = ?').run(dd, w.workspaceId, sent.id),
    /refs_frozen|immutable|constraint/i,
    'the exception must be judged on the batch the item BELONGS to (OLD.batch_id), not the one it is moved to',
  );
});

test('R3-E3: the "had a file" fact cannot be rewritten: a generated batch keeps its control sum', () => {
  const w = world();
  const v = vendor(w, 'e3');
  const gen = batch(w, [bill(w, v, 'e3')], 'e3');
  must(generatePain001(w.ctx, { batchId: gen, idempotencyKey: 'e3-gen' }), 'gen');
  must(discardPaymentBatch(w.ctx, { batchId: gen, confirmation: true, idempotencyKey: 'e3-disc' }), 'discard');
  assert.throws(
    () => w.store.db.prepare('UPDATE payment_batch SET ctrl_sum_minor = NULL WHERE workspace_id = ? AND id = ?').run(w.workspaceId, gen),
    /frozen|immutable|constraint/i,
    'ctrl_sum_minor is what the trigger exception reads to decide a file never existed',
  );
});

// --- E4: the erasure refusal ------------------------------------------------------------------------------

test('R3-E4: an erasure refuses while a DRAFT names any row of the identity (a merged tombstone included), and only in this workspace', () => {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  const w = world(store);
  const tomb = vendor(w, 'e4t');
  const survivor = vendor(w, 'e4s');
  const draft = batch(w, [bill(w, tomb, 'e4')], 'e4');
  must(mergeContacts(w.ctx, { sourceId: tomb, targetId: survivor, idempotencyKey: 'e4-merge' }), 'merge');
  const refused = anonymiseContact(w.ctx, { contactId: survivor, idempotencyKey: 'e4-erase' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'contact_in_open_payment_batch');
  assert.deepEqual(refused.batches.map((b) => b.batchId), [draft]);
  assert.equal(store.db.prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?').get(w.workspaceId, survivor).name, 'Erfunden e4s AG', 'nothing erased');

  // A generated (unpaid) batch is a file: it does not block, and its snapshot is retained.
  must(generatePain001(w.ctx, { batchId: draft, idempotencyKey: 'e4-gen' }), 'gen');
  const erased = must(anonymiseContact(w.ctx, { contactId: survivor, idempotencyKey: 'e4-erase2' }), 'erase');
  assert.equal(erased.retained.find((r) => r.table === 'payment_batch_item').rows, 1);
  assert.equal(itemsOf(w, draft)[0].creditor_name, 'Erfunden e4t AG', 'the sent file keeps the name it carried');

  // §H-TENANT: a draft in ANOTHER workspace that (anomalously) names this workspace's vendor id does not
  // block an erasure here.
  const other = world(store);
  const v2 = vendor(w, 'e4h');
  const otherBill = bill(other, vendor(other, 'e4o'), 'e4o');
  const otherDraft = batch(other, [otherBill], 'e4o');
  store.db.prepare('UPDATE payment_batch_item SET vendor_id = ? WHERE workspace_id = ? AND batch_id = ?').run(v2, other.workspaceId, otherDraft);
  must(anonymiseContact(w.ctx, { contactId: v2, idempotencyKey: 'e4-erase3' }), 'erase here ignores the other tenant');
  store.close();
});

// --- E5: the debtor IBAN lock -------------------------------------------------------------------------------

// ADAPTED on the author branch for critic r3 R3-4 (coordinator instruction, 01.10.2026): a PAID batch no
// longer locks the account IBAN (it renders only from its frozen debtor_iban and refuses to regenerate,
// and it cannot be discarded). The paid leg now asserts the change is accepted and the snapshot stays.
test('R3-E5: update_bank_account refuses an IBAN change under a draft and a generated batch; a paid or discarded one frees it; the file never moves', () => {
  const w = world();
  const v = vendor(w, 'e5');
  const b = batch(w, [bill(w, v, 'e5')], 'e5');
  const tryIban = (key) => updateBankAccount(w.ctx, { bankAccountId: w.bank, iban: OTHER_DEBTOR_IBAN, idempotencyKey: key });
  for (const [label, step] of [
    ['draft', () => {}],
    ['generated', () => must(generatePain001(w.ctx, { batchId: b, idempotencyKey: 'e5-gen' }), 'gen')],
  ]) {
    step();
    const res = tryIban(`e5-${label}`);
    assert.equal(res.ok, false, `${label}: refused`);
    assert.equal(res.error, 'account_in_use');
    assert.equal(res.reason, 'payment_batch');
  }
  must(markBatchPaid(w.ctx, { batchId: b, confirmation: true, valueDate: '2026-10-05', idempotencyKey: 'e5-paid' }), 'paid');
  must(tryIban('e5-paid'), 'a paid batch frees the account (R3-4)');
  assert.equal(w.store.db.prepare('SELECT debtor_iban FROM payment_batch WHERE workspace_id = ? AND id = ?').get(w.workspaceId, b).debtor_iban, DEBTOR_IBAN, 'and its snapshot stays');
  const w2 = world();
  const b2 = batch(w2, [bill(w2, vendor(w2, 'e5b'), 'e5b')], 'e5b');
  must(discardPaymentBatch(w2.ctx, { batchId: b2, idempotencyKey: 'e5b-disc' }), 'discard');
  must(updateBankAccount(w2.ctx, { bankAccountId: w2.bank, iban: OTHER_DEBTOR_IBAN, idempotencyKey: 'e5b-iban' }), 'a discarded batch frees the account');
  assert.equal(w2.store.db.prepare('SELECT debtor_iban FROM payment_batch WHERE workspace_id = ? AND id = ?').get(w2.workspaceId, b2).debtor_iban, DEBTOR_IBAN, 'and the snapshot stays');
});
