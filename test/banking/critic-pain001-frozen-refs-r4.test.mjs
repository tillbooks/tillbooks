// NON-AUTHOR critic probes, round 4 (confirmation), for `claude/pain001-frozen-refs`: the r3 LOW fixes.
// Report: docs/critique/pain001-frozen-refs-critic-r4.md.
//
// `payment_batch.generated_at` is now THE fact "a file existed": stamped at the first generation,
// frozen, backfilled by generation 9. `batch_id`, `ctrl_sum_minor` and `nb_of_txs` are frozen once set.
// A paid batch no longer locks the debtor account IBAN. These probes try to forge, miss or mis-backfill
// the stamp, and check that no legitimate engine write (generation, regeneration, mark paid, discard,
// a scaling env_copy) trips the new freezes.
//
// SYNTHETIC DATA ONLY: invented IBANs with correct check digits, invented names, uuid ids.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { DATA_MIGRATIONS } from '../../dist/core/store/migrations.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact, anonymiseContact } from '../../dist/core/sales/index.js';
import {
  createBankAccount,
  updateBankAccount,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  markBatchPaid,
  discardPaymentBatch,
} from '../../dist/core/banking/index.js';
import { envCreate, envCopy } from '../../dist/core/landscape/index.js';

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
const NEW_DEBTOR_IBAN = synthIban('09000', '000000000003');
const vendorIban = (n) => synthIban('09000', String(600000000000 + n));

function world({ location, clockAt = AT } = {}) {
  const clock = fixedClock(clockAt);
  const ids = systemIdGen;
  const store = new SqliteStore({ clock, ...(location !== undefined ? { location } : {}) });
  const workspaceId = must(createWorkspace({ store, clock, ids }, { name: 'Erfundene Schreinerei GmbH' }), 'ws').workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  const acc = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number)?.id;
  const bank = must(createBankAccount(ctx, { name: 'Zahlkonto', iban: DEBTOR_IBAN, ledgerAccountId: acc('1020'), idempotencyKey: 'bank' }), 'bank').bankAccountId;
  return { store, workspaceId, ctx, acc, bank, clock };
}
let n = 0;
function run(w, tag, count = 1) {
  const bills = [];
  for (let i = 0; i < count; i++) {
    const k = ++n;
    const v = must(createContact(w.ctx, { partyRole: 'vendor', name: `Erfunden ${tag}${i} AG`, idempotencyKey: `v-${tag}-${k}` }), 'contact').contact.id;
    const b = must(createVendorBill(w.ctx, { vendorId: v, billDate: '2026-09-01', vendorReference: `SYN-${tag}${i}`, amountMinor: 30_000 + k, expenseAccountId: w.acc('6500'), idempotencyKey: `bill-${tag}-${k}` }), 'bill');
    must(postVendorBill(w.ctx, { vendorBillId: b.vendorBillId, idempotencyKey: `post-${tag}-${k}` }), 'post');
    must(setCreditorBankProfile(w.ctx, { vendorId: v, iban: vendorIban(k), idempotencyKey: `cbp-${tag}-${k}` }), 'cbp');
    bills.push(b.vendorBillId);
  }
  return must(createPaymentBatch(w.ctx, { bankAccountId: w.bank, itemIds: bills, executionDate: '2026-10-05', idempotencyKey: `batch-${tag}` }), 'batch').batchId;
}
const gen = (w, id, key) => Buffer.from(must(generatePain001(w.ctx, { batchId: id, idempotencyKey: key }), 'gen').xmlBase64, 'base64').toString('utf8');
const row = (w, id) => w.store.db.prepare('SELECT status, generated_at, ctrl_sum_minor, nb_of_txs, debtor_iban FROM payment_batch WHERE workspace_id = ? AND id = ?').get(w.workspaceId, id);

test('R4-F1: generated_at is stamped by the first generation only, then frozen with the control sum and the count; nothing forges a "no file" batch', () => {
  const w = world();
  const b = run(w, 'f1', 2);
  assert.equal(row(w, b).generated_at, null, 'a draft has no file');
  const first = gen(w, b, 'f1-g1');
  const stamped = row(w, b);
  assert.equal(stamped.generated_at, AT);
  assert.equal(gen(w, b, 'f1-g2'), first, 'regeneration writes nothing and renders the same file');
  assert.deepEqual(row(w, b), stamped);
  for (const sql of [
    'UPDATE payment_batch SET generated_at = NULL WHERE id = ?',
    "UPDATE payment_batch SET generated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    'UPDATE payment_batch SET ctrl_sum_minor = NULL WHERE id = ?',
    'UPDATE payment_batch SET ctrl_sum_minor = 1 WHERE id = ?',
    'UPDATE payment_batch SET nb_of_txs = NULL WHERE id = ?',
  ]) {
    assert.throws(() => w.store.db.prepare(sql).run(b), /refs_frozen/, sql);
  }
  must(discardPaymentBatch(w.ctx, { batchId: b, confirmation: true, idempotencyKey: 'f1-disc' }), 'discard after generation');
  assert.equal(row(w, b).generated_at, AT, 'a discard keeps the stamp');
  assert.throws(() => w.store.db.prepare('UPDATE payment_batch_item SET creditor_name = NULL WHERE batch_id = ?').run(b), /refs_frozen/, 'the sent snapshot is retained');
  // Forging in the other direction (stamping a never-generated draft) only makes it STRICTER.
  const dd = run(w, 'f1d');
  must(discardPaymentBatch(w.ctx, { batchId: dd, idempotencyKey: 'f1d-disc' }), 'discard draft');
  // An item never changes batch, with or without a clear in the same statement (critic r3 R3-1).
  assert.throws(() => w.store.db.prepare('UPDATE payment_batch_item SET batch_id = ? WHERE batch_id = ?').run(dd, b), /refs_frozen/);
  w.store.db.prepare('UPDATE payment_batch SET generated_at = ? WHERE id = ?').run(AT, dd);
  assert.throws(() => w.store.db.prepare('UPDATE payment_batch_item SET creditor_name = NULL WHERE batch_id = ?').run(dd), /refs_frozen/);
});

test('R4-F2: the generation-9 backfill stamps exactly the batches that had a file (generated, paid, discarded after generation) and is idempotent; the erasure then clears only the never-filed items', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-r4-f2-'));
  try {
    const path = join(dir, 'book.db');
    const w = world({ location: path });
    const vendorName = 'Erfunden Gemeinsam AG';
    const v = must(createContact(w.ctx, { partyRole: 'vendor', name: vendorName, idempotencyKey: 'v-shared' }), 'contact').contact.id;
    const mk = (tag) => {
      const k = ++n;
      const bl = must(createVendorBill(w.ctx, { vendorId: v, billDate: '2026-09-01', vendorReference: `SYN-${tag}`, amountMinor: 40_000 + k, expenseAccountId: w.acc('6500'), idempotencyKey: `bill-${tag}` }), 'bill');
      must(postVendorBill(w.ctx, { vendorBillId: bl.vendorBillId, idempotencyKey: `post-${tag}` }), 'post');
      if (k === n) must(setCreditorBankProfile(w.ctx, { vendorId: v, iban: vendorIban(k), idempotencyKey: `cbp-${tag}` }), 'cbp');
      return must(createPaymentBatch(w.ctx, { bankAccountId: w.bank, itemIds: [bl.vendorBillId], executionDate: '2026-10-05', idempotencyKey: `batch-${tag}` }), 'batch').batchId;
    };
    const generated = mk('g'); gen(w, generated, 'g');
    const paid = mk('p'); gen(w, paid, 'p'); must(markBatchPaid(w.ctx, { batchId: paid, confirmation: true, valueDate: '2026-10-05', idempotencyKey: 'p-paid' }), 'paid');
    const discAfter = mk('da'); gen(w, discAfter, 'da'); must(discardPaymentBatch(w.ctx, { batchId: discAfter, confirmation: true, idempotencyKey: 'da-disc' }), 'disc after');
    const discBefore = mk('db'); must(discardPaymentBatch(w.ctx, { batchId: discBefore, idempotencyKey: 'db-disc' }), 'disc before');
    const ws = w.workspaceId;
    w.store.close();

    const raw = new Database(path);
    for (const x of raw.prepare("SELECT name, type FROM sqlite_master WHERE name LIKE 'payment_batch%frozen%' OR name LIKE 'payment_batch%_ref_unique'").all()) {
      raw.exec(`DROP ${x.type === 'trigger' ? 'TRIGGER' : 'INDEX'} IF EXISTS "${x.name}"`);
    }
    raw.exec('UPDATE payment_batch SET generated_at = NULL, pmt_inf_id = NULL, debtor_name = NULL, debtor_iban = NULL');
    raw.exec("UPDATE payment_batch SET msg_id = NULL WHERE status IN ('draft') OR (status = 'discarded' AND ctrl_sum_minor IS NULL)");
    raw.exec('UPDATE payment_batch_item SET instr_id = NULL, end_to_end_id = NULL, seq = NULL, creditor_name = NULL');
    raw.pragma('user_version = 8');
    raw.close();

    const store = new SqliteStore({ location: path, clock: fixedClock(AT) });
    try {
      const at = (id) => store.db.prepare('SELECT generated_at FROM payment_batch WHERE workspace_id = ? AND id = ?').get(ws, id).generated_at;
      for (const id of [generated, paid, discAfter]) assert.notEqual(at(id), null, `${id} had a file`);
      assert.equal(at(discBefore), null, 'discarded as a draft: never a file');
      const before = store.db.prepare('SELECT id, generated_at FROM payment_batch WHERE workspace_id = ? ORDER BY id').all(ws);
      const step = DATA_MIGRATIONS.find((m) => m.generation === 9);
      store.db.transaction(() => step.apply(store.db))();
      assert.deepEqual(store.db.prepare('SELECT id, generated_at FROM payment_batch WHERE workspace_id = ? ORDER BY id').all(ws), before, 'idempotent');

      const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock: fixedClock(AT), ids: systemIdGen });
      const erased = must(anonymiseContact(ctx, { contactId: v, idempotencyKey: 'f2-erase' }), 'erase');
      assert.equal(erased.paymentSnapshotsCleared.items, 1, 'only the never-filed item is cleared');
      assert.equal(erased.retained.find((r) => r.table === 'payment_batch_item').rows, 3);
      const nameOf = (id) => store.db.prepare('SELECT creditor_name FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ?').get(ws, id).creditor_name;
      for (const id of [generated, paid, discAfter]) assert.equal(nameOf(id), vendorName, 'a filed snapshot is retained');
      assert.equal(nameOf(discBefore), null);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R4-F3: a scaling env_copy (structure_synthetic) of a book with a generated batch succeeds: the new freezes are suspended for the transform and restored after', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-r4-f3-'));
  try {
    const deps = {
      supportDir: dir,
      environmentsRoot: join(dir, 'environments'),
      mainDbPath: join(dir, 'main', 'till.db'),
      actor: 'owner',
      now: () => AT,
      ids: systemIdGen,
      clock: { now: () => AT },
      seeders: {
        paid: (path) => {
          const w = world({ location: path });
          gen(w, run(w, 'f3', 2), 'f3');
          w.store.close();
        },
        minimal: (p) => new SqliteStore({ location: p }).close(),
      },
    };
    must(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'paid', tierRank: 250, confirmed: true }), 'env src');
    must(envCreate(deps, { name: 'dst', policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true }), 'env dst');
    must(envCopy(deps, { source: 'src', target: 'dst', scope: 'instance', sanitize: 'structure_synthetic', confirmed: true }), 'env_copy structure_synthetic');
    const store = new SqliteStore({ location: join(dir, 'environments', 'dst', 'till.db'), clock: fixedClock(AT) });
    try {
      const b = store.db.prepare('SELECT id, generated_at, ctrl_sum_minor FROM payment_batch LIMIT 1').get();
      assert.notEqual(b.generated_at, null, 'the copy keeps the fact that a file existed');
      assert.throws(() => store.db.prepare('UPDATE payment_batch SET ctrl_sum_minor = 1 WHERE id = ?').run(b.id), /refs_frozen/, 'and its freezes are back');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R4-F4: a PAID batch frees the account IBAN, but a generated batch on the same account still locks it, and the paid file can never be regenerated under the new IBAN', () => {
  const w = world();
  const paid = run(w, 'f4p');
  const sent = gen(w, paid, 'f4p');
  must(markBatchPaid(w.ctx, { batchId: paid, confirmation: true, valueDate: '2026-10-05', idempotencyKey: 'f4-paid' }), 'paid');
  const live = run(w, 'f4g');
  gen(w, live, 'f4g');
  const locked = updateBankAccount(w.ctx, { bankAccountId: w.bank, iban: NEW_DEBTOR_IBAN, idempotencyKey: 'f4-iban1' });
  assert.equal(locked.ok, false);
  assert.equal(locked.error, 'account_in_use');
  assert.equal(locked.batchId, live, 'the generated batch is what locks it');
  must(markBatchPaid(w.ctx, { batchId: live, confirmation: true, valueDate: '2026-10-05', idempotencyKey: 'f4-paid2' }), 'paid2');
  must(updateBankAccount(w.ctx, { bankAccountId: w.bank, iban: NEW_DEBTOR_IBAN, idempotencyKey: 'f4-iban2' }), 'freed');
  const again = generatePain001(w.ctx, { batchId: paid, idempotencyKey: 'f4-regen' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_paid');
  assert.equal(row(w, paid).debtor_iban, DEBTOR_IBAN, 'the paid batch keeps the IBAN its file carried');
  assert.ok(sent.includes(DEBTOR_IBAN));
  const next = run(w, 'f4n');
  assert.equal(row(w, next).debtor_iban, NEW_DEBTOR_IBAN, 'a new batch takes the new IBAN');
});
